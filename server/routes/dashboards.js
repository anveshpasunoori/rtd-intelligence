// Read endpoints: workspace summary, the four dashboards, employee dossier and search, rule impact,
// audit log and archived-cycle cases. Each returns only what its screen shows (aggregates plus one
// page of rows) — the browser never receives the whole roster.

const express = require('express');
const { RATINGS, RATING_RANK, READINESS_ORDER, ELIGIBILITY_STATUSES, capRating } = require('../lib/engine');
const { getCases } = require('../lib/cases');
const store = require('../lib/store');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(req.method, req.path, err);
      res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
    }
  };
}

const str = (v) => (typeof v === 'string' ? v : '');

// Sidebar quick filters, shared by every dashboard.
function quickFilters(query) {
  return { regionType: str(query.regionType), region: str(query.region), localGrade: str(query.localGrade), practice: str(query.practice) };
}

function page(query) {
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  return { offset, limit };
}

// The header search box narrows listed rows by name, GGID or practice.
function searchFilter(q) {
  const s = str(q).trim().toLowerCase();
  if (!s) return null;
  return (c) => c.employee.name.toLowerCase().indexOf(s) >= 0 || (c.employee.ggid || '').toLowerCase().indexOf(s) >= 0 || (c.employee.practice || '').toLowerCase().indexOf(s) >= 0;
}

function countBy(cases, keys, fn) {
  const counts = {};
  keys.forEach((k) => { counts[k] = 0; });
  cases.forEach((c) => { const k = fn(c); if (counts[k] != null) counts[k]++; });
  return counts;
}

function scoped(data, query) {
  const qf = quickFilters(query);
  return data.cases.filter((c) => data.engine.matchesQuickFilters(c.employee, qf));
}

// ------------------------------------------------------------------ rows ----

function employeeBasics(e) {
  return {
    id: e.id, name: e.name, ggid: e.ggid, year: e.year, globalGrade: e.globalGrade, localGrade: e.localGrade,
    practice: e.practice, subPractice: e.subPractice, region: e.region, country: e.country, peopleManager: e.peopleManager,
    dataQualityIssues: e.dataQualityIssues || [],
  };
}

function riskRow(c) {
  return Object.assign(employeeBasics(c.employee), { finalRating: c.rating.finalRating, eligibilityStatus: c.eligibility.status, risk: c.risk });
}

function rtdRow(c, ranks) {
  return Object.assign(employeeBasics(c.employee), {
    finalRating: c.rating.finalRating, systemRating: c.rating.systemRating,
    ratingConfidence: c.ratingConfidence,
    eligibility: { status: c.eligibility.status, systemStatus: c.eligibility.systemStatus, overridden: c.eligibility.overridden },
    promotionConfidence: c.promotionConfidence,
    achievement: c.achievement, achievementRank: ranks[c.employee.id] || null,
    riskCount: c.risk.length,
  });
}

// Promotion-quota position for every case in a grade whose quota is exceeded.
function quotaPositions(data, cases) {
  const byEmp = {};
  data.engine.promotionQuotaExceptions(cases).forEach((ex) => {
    ex.ranked.forEach((rc, i) => {
      const rank = i + 1;
      byEmp[rc.employee.id] = {
        rank, total: ex.total, quota: ex.quota, overQuota: rank > ex.quota,
        suggestedRating: capRating(rc.rating.finalRating, 'Succeeding'),
        suggestedNote: data.engine.promotionOverflowReason(ex, rank, rc),
      };
    });
  });
  return byEmp;
}

function candidateRow(c, quota) {
  const e = c.employee;
  return Object.assign(employeeBasics(e), {
    promotionReadiness: e.promotionReadiness, promotionRecommendation: !!e.promotionRecommendation,
    finalRating: c.rating.finalRating, eligibilityStatus: c.eligibility.status,
    topReasons: c.eligibility.reasons.filter((r) => r.ok !== true).slice(0, 2).map((r) => r.text),
    risk: c.risk, achievement: c.achievement, awards: e.awards || [], businessImpactNotes: e.businessImpactNotes || '',
    utilization: e.utilization, timeInGrade: e.timeInGrade, certificationLevel: e.certificationLevel || 'None',
    quota: quota || null,
  });
}

// RTD Review's row ordering: the chosen column, then achievement rank among tied top ratings.
function rtdComparator(sort, dir, ranks) {
  return (a, b) => {
    const val = (c) => {
      if (sort === 'rating') return RATING_RANK[c.rating.finalRating];
      if (sort === 'eligibility') return c.eligibility.status;
      if (sort === 'name') return c.employee.name;
      if (sort === 'grade') return c.employee.globalGrade;
      return c.employee[sort];
    };
    const av = val(a), bv = val(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    if (a.rating.finalRating === b.rating.finalRating) {
      const ra = ranks[a.employee.id] ? ranks[a.employee.id].rank : Infinity;
      const rb = ranks[b.employee.id] ? ranks[b.employee.id].rank : Infinity;
      if (ra !== rb) return ra - rb;
    }
    return 0;
  };
}

const RTD_SORTS = ['name', 'grade', 'peopleManager', 'rating', 'eligibility'];
const BLOCKER_LABELS = { 'Rule 2': 'Prior year promotion', 'Rule 5': 'Readiness / recommendation', 'L&D': 'Learning & development', 'Rule 6': 'Certification', TIG: 'Time in grade', BOTP: 'Active BOTP' };

function rtdFiltered(data, query) {
  const cases = scoped(data, query);
  let filtered = cases.filter((c) => {
    if (query.rating && c.rating.finalRating !== query.rating) return false;
    if (query.eligibility && c.eligibility.status !== query.eligibility) return false;
    if (query.risk === '1' && !c.risk.length) return false;
    return true;
  });
  const search = searchFilter(query.q);
  if (search) filtered = filtered.filter(search);
  const sort = RTD_SORTS.indexOf(query.sort) >= 0 ? query.sort : 'name';
  const dir = query.dir === '-1' ? -1 : 1;
  filtered.sort(rtdComparator(sort, dir, data.achievementRanks));
  return { cases, filtered, sort, dir };
}

function promoFiltered(data, query) {
  const cases = scoped(data, query);
  let candidates = cases.filter((c) => c.employee.promotionRecommendation || c.eligibility.status !== 'Not Eligible');
  candidates = candidates.filter((c) => {
    if (query.eligibility && c.eligibility.status !== query.eligibility) return false;
    if (query.globalGrade && String(c.employee.globalGrade) !== query.globalGrade) return false;
    return true;
  });
  candidates.sort((a, b) => RATING_RANK[b.rating.finalRating] - RATING_RANK[a.rating.finalRating]);
  const beforeSearch = candidates.length;
  const search = searchFilter(query.q);
  if (search) candidates = candidates.filter(search);
  return { cases, candidates, beforeSearch };
}

function distinctSorted(employees, field) {
  const s = {};
  employees.forEach((e) => { s[e[field]] = true; });
  return Object.keys(s).sort();
}

// Mounted behind requireAuth (see server.js).
module.exports = function dashboardRoutes({ pool, requireAdmin }) {
  const router = express.Router();

  // Everything the app needs at start-up except records: settings, counts, filter options,
  // archived-cycle list and (HR Admin) this cycle's uploads.
  router.get('/workspace', handle(async (req, res) => {
    const data = await getCases(pool);
    const settings = Object.assign({}, data.settings, {
      meta: Object.assign({}, data.settings.meta, { lastUpdated: data.updatedAt.toISOString().slice(0, 10) }),
    });
    const [archives, audit, batches] = await Promise.all([
      pool.query('select id, cycle_label, archived_at, archived_by, employee_count from archives order by archived_at desc'),
      pool.query('select count(*)::int as n from audit_log'),
      req.user.role === 'HR Admin' ? store.listBatches(pool) : Promise.resolve([]),
    ]);
    res.json({
      version: data.version,
      settings,
      counts: { employees: data.employees.length, archives: archives.rows.length, audit: audit.rows[0].n, uploadBatches: batches.length },
      options: {
        region: distinctSorted(data.employees, 'region'), localGrade: distinctSorted(data.employees, 'localGrade'),
        practice: distinctSorted(data.employees, 'practice'), globalGrade: distinctSorted(data.employees, 'globalGrade'),
      },
      archives: archives.rows.map((a) => ({ id: a.id, cycleLabel: a.cycle_label, archivedAt: a.archived_at, archivedBy: a.archived_by, employeeCount: a.employee_count })),
      uploadBatches: batches,
    });
  }));

  // ------------------------------------------------------------ dashboards ----

  router.get('/dashboards/executive', handle(async (req, res) => {
    const data = await getCases(pool);
    const cases = scoped(data, req.query);
    const total = cases.length;
    if (!total) return res.json({ total: 0 });
    const atRisk = cases.filter((c) => c.risk.length > 0);
    const search = searchFilter(req.query.q);
    const atRiskShown = search ? atRisk.filter(search) : atRisk;
    res.json({
      total,
      ratingCounts: countBy(cases, RATINGS, (c) => c.rating.finalRating),
      eligibilityCounts: countBy(cases, ELIGIBILITY_STATUSES, (c) => c.eligibility.status),
      avgRatingIndex: cases.reduce((s, c) => s + RATING_RANK[c.rating.finalRating], 0) / total,
      promotionRecommendations: cases.filter((c) => c.employee.promotionRecommendation).length,
      learningCompliant: cases.filter((c) => c.learning.status === 'Meets Requirement').length,
      certificationMet: total - cases.filter((c) => c.cert.gap).length,
      trainingCompleted: cases.filter((c) => c.employee.mandatoryTrainingStatus === 'Completed').length,
      atRiskTotal: atRisk.length,
      atRiskMatching: atRiskShown.length,
      atRisk: atRiskShown.slice(0, 8).map(riskRow),
    });
  }));

  router.get('/dashboards/rtd', handle(async (req, res) => {
    const data = await getCases(pool);
    const { cases, filtered, sort, dir } = rtdFiltered(data, req.query);
    const { offset, limit } = page(req.query);
    const total = cases.length;
    const eligible = cases.filter((c) => c.eligibility.status !== 'Not Eligible').length;
    const blockerCounts = {};
    cases.forEach((c) => {
      const seen = {};
      c.eligibility.reasons.filter((r) => r.ok === false).forEach((r) => {
        const cat = r.text.split(' ·')[0];
        if (seen[cat]) return;
        seen[cat] = true;
        blockerCounts[cat] = (blockerCounts[cat] || 0) + 1;
      });
    });
    res.json({
      total, eligible, notEligible: total - eligible,
      avgConfidence: total ? Math.round(cases.reduce((s, c) => s + c.ratingConfidence.score, 0) / total) : 0,
      topBlockers: Object.keys(blockerCounts).map((k) => ({ label: BLOCKER_LABELS[k] || k, count: blockerCounts[k] }))
        .sort((a, b) => b.count - a.count).slice(0, 4),
      filteredTotal: filtered.length, offset, limit, sort, dir,
      rows: filtered.slice(offset, offset + limit).map((c) => rtdRow(c, data.achievementRanks)),
    });
  }));

  // Every row RTD Review's current filters match, with the columns of the Excel results export.
  router.get('/dashboards/rtd/export', requireAdmin, handle(async (req, res) => {
    const data = await getCases(pool);
    const { filtered } = rtdFiltered(data, req.query);
    const quota = quotaPositions(data, filtered);
    res.json({
      cycleLabel: data.settings.meta.cycleLabel,
      rows: filtered.map((c) => {
        const e = c.employee, q = quota[e.id];
        return {
          ggid: e.ggid, name: e.name, email: e.email, region: e.region, country: e.country, globalGrade: e.globalGrade, localGrade: e.localGrade,
          practice: e.practice, subPractice: e.subPractice, finalRating: c.rating.finalRating, ratingSource: e.ratingOverride ? 'HR Override' : 'System',
          eligibility: c.eligibility.status, eligibilitySource: e.promotionEligibilityOverride ? 'HR Override' : 'System',
          learning: c.learning.status, certification: c.cert.gap ? 'Gap' : 'Met',
          quotaRank: q ? `${q.rank} of ${q.total}` : '', quotaStatus: q ? (q.overQuota ? 'Over quota' : 'Within quota') : '',
          risk: c.risk.join(' | '),
        };
      }),
    });
  }));

  router.get('/dashboards/promotions', handle(async (req, res) => {
    const data = await getCases(pool);
    const { cases, candidates, beforeSearch } = promoFiltered(data, req.query);
    const { offset, limit } = page(req.query);
    const count = (fn) => cases.filter(fn).length;
    const readyAndEligible = cases.filter((c) => c.employee.promotionReadiness === 'Ready Now' && c.eligibility.status !== 'Not Eligible');
    const practiceCounts = {};
    readyAndEligible.forEach((c) => { practiceCounts[c.employee.practice] = (practiceCounts[c.employee.practice] || 0) + 1; });
    const topPractice = Object.keys(practiceCounts).map((p) => ({ practice: p, count: practiceCounts[p] })).sort((a, b) => b.count - a.count)[0] || null;
    const quota = quotaPositions(data, cases);
    res.json({
      funnel: [
        { label: 'Recommended', value: count((c) => c.employee.promotionRecommendation) },
        { label: 'Ready Now', value: count((c) => c.employee.promotionReadiness === 'Ready Now') },
        { label: 'Eligible', value: count((c) => c.eligibility.status === 'Eligible') },
        { label: 'Elig. w/ Exception', value: count((c) => c.eligibility.status === 'Eligible With Exception') },
      ],
      eligibilityCounts: countBy(cases, ELIGIBILITY_STATUSES, (c) => c.eligibility.status),
      readyAndEligibleCount: readyAndEligible.length,
      readyForReview: readyAndEligible.slice(0, 3).map((c) => candidateRow(c, quota[c.employee.id])),
      topPractice,
      candidatesBeforeSearch: beforeSearch,
      candidatesTotal: candidates.length, offset, limit,
      candidates: candidates.slice(offset, offset + limit).map((c) => candidateRow(c, quota[c.employee.id])),
    });
  }));

  router.get('/dashboards/calibration', handle(async (req, res) => {
    const data = await getCases(pool);
    const cases = scoped(data, req.query);
    res.json({
      total: cases.length,
      ratingCounts: countBy(cases, RATINGS, (c) => c.rating.finalRating),
      readinessCounts: countBy(cases, READINESS_ORDER, (c) => c.employee.promotionReadiness),
    });
  }));

  // ------------------------------------------------------------- employees ----

  // Header search: the first employees whose name or GGID matches, and whether any practice does.
  router.get('/employees/search', handle(async (req, res) => {
    const q = str(req.query.q).trim().toLowerCase();
    if (!q) return res.json({ employees: [], practiceMatch: false });
    const data = await getCases(pool);
    const hits = data.employees.filter((e) => e.name.toLowerCase().indexOf(q) >= 0 || (e.ggid || '').toLowerCase().indexOf(q) >= 0);
    res.json({
      employees: hits.slice(0, 10).map((e) => ({ id: e.id, name: e.name, ggid: e.ggid, practice: e.practice })),
      practiceMatch: data.employees.some((e) => (e.practice || '').toLowerCase().indexOf(q) >= 0),
    });
  }));

  // One employee's full dossier: the record, its linked records and the computed case.
  router.get('/employees/:id', handle(async (req, res) => {
    const data = await getCases(pool);
    const c = data.byId.get(req.params.id);
    if (!c) throw httpError(404, 'This employee could not be found.');
    const e = c.employee;
    res.json({
      version: data.version,
      employee: e,
      accounts: data.engine.getAccounts(e.id),
      contributions: data.engine.getContributions(e.id),
      managerRecord: data.managerRecords.find((m) => m.employeeId === e.id) || null,
      workflow: c.workflow || null,
      case: {
        rating: c.rating, eligibility: c.eligibility, learning: c.learning, cert: c.cert, risk: c.risk,
        ratingConfidence: c.ratingConfidence, promotionConfidence: c.promotionConfidence, achievement: c.achievement,
        achievementRank: data.achievementRanks[e.id] || null,
      },
    });
  }));

  // ---------------------------------------------------------- rules, audit ----

  router.get('/rules/:id/impact', requireAdmin, handle(async (req, res) => {
    const data = await getCases(pool);
    const r = (data.settings.rules || []).find((x) => x.id === req.params.id);
    if (!r) throw httpError(404, 'Rule not found.');
    res.json(data.engine.ruleImpactStats(r, data.cases, data.employees, data.managerRecords));
  }));

  router.get('/audit', requireAdmin, handle(async (req, res) => {
    const { offset, limit } = page(req.query);
    const where = [], params = [];
    if (str(req.query.entity)) { params.push(req.query.entity); where.push(`entity = $${params.length}`); }
    if (str(req.query.fieldPrefix)) { params.push(req.query.fieldPrefix.replace(/[\\%_]/g, '\\$&') + '%'); where.push(`field like $${params.length}`); }
    const w = where.length ? 'where ' + where.join(' and ') : '';
    const [total, rows, entities] = await Promise.all([
      pool.query(`select count(*)::int as n from audit_log ${w}`, params),
      pool.query(`select * from audit_log ${w} order by ts desc, seq desc offset ${offset} limit ${limit}`, params),
      pool.query('select entity, max(ts) as last from audit_log where entity is not null group by entity order by last desc'),
    ]);
    res.json({ total: total.rows[0].n, offset, limit, entities: entities.rows.map((r) => r.entity), entries: rows.rows.map(store.auditRowToEntry) });
  }));

  // -------------------------------------------------------------- archives ----

  // An archived cycle's case summaries, narrowed by the quick filters, with chart counts.
  router.get('/archives/:id/cases', requireAdmin, handle(async (req, res) => {
    const r = await pool.query(`select id, cycle_label, archived_at, archived_by, employee_count, snapshot->'cases' as cases from archives where id = $1`, [req.params.id]);
    if (!r.rows.length) throw httpError(404, 'Archive not found.');
    const a = r.rows[0];
    const data = await getCases(pool);
    const qf = quickFilters(req.query);
    const all = a.cases || [];
    const cases = all.filter((c) => data.engine.matchesQuickFilters(c, qf));
    const { offset, limit } = page(req.query);
    res.json({
      archive: { id: a.id, cycleLabel: a.cycle_label, archivedAt: a.archived_at, archivedBy: a.archived_by, employeeCount: a.employee_count },
      totalArchived: all.length, total: cases.length, offset, limit,
      ratingCounts: countBy(cases, RATINGS, (c) => c.finalRating),
      eligibilityCounts: countBy(cases, ELIGIBILITY_STATUSES, (c) => c.eligibilityStatus),
      cases: cases.slice(offset, offset + limit),
    });
  }));

  return router;
};
