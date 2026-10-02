// Read endpoints (workspace, dashboards, dossier, search, rules impact, audit, archive cases) and
// field-level saves. Expected numbers are recomputed here straight from the stored data with the
// rules engine (whose output is pinned by engine.parity.test.js).

const test = require('node:test');
const { assert, pool, startServer, stopServer, resetDatabase, newUser, dbState, row } = require('./helpers');
const { createEngine, applySettingsDefaults, RATINGS } = require('../lib/engine');

let admin, reviewer;

test.before(startServer);
test.after(stopServer);
test.beforeEach(async () => {
  await resetDatabase();
  admin = await newUser('HR Admin');
  reviewer = await newUser();
});

// Every case, computed independently from what's in the database right now.
async function expectedCases() {
  const s = (await dbState()).data;
  const engine = createEngine(applySettingsDefaults(s), s);
  return { s, engine, cases: s.employees.map(engine.fullCase) };
}
const qs = (o) => '?' + Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ------------------------------------------------------------- workspace ----

test('workspace: settings, counts and filter options — but no records', async () => {
  const r = await reviewer.get('/api/workspace');
  assert.equal(r.status, 200);
  const w = r.body;
  for (const k of ['employees', 'accounts', 'contributions', 'managerRecords', 'workflow', 'auditLog']) {
    assert.equal(w[k], undefined, k);
    assert.equal(w.settings[k], undefined, 'settings.' + k);
  }
  assert.equal(w.counts.employees, 300);
  assert.equal(w.counts.audit, 1);
  assert.equal(w.settings.rules.length, 27);
  assert.ok(w.settings.quotaConfig, 'quota defaults are filled in on the server');
  assert.equal(w.settings.meta.cycleLabel, 'FY2026 RTD Cycle');
  assert.deepEqual(w.options.practice, ['Actuarial & Risk', 'Broking Excellence', 'Claims Transformation', 'InsurTech & Digital', 'Underwriting Advisory']);
  assert.ok(w.options.region.length && w.options.localGrade.length && w.options.globalGrade.length);
  assert.deepEqual(w.uploadBatches, [], 'reviewers get no upload list');
  assert.ok(r.text.length < 60000, `workspace payload stays small (${r.text.length} bytes)`);

  await admin.post('/api/data-load/commit', { fileName: 'x.csv', rows: [row({ ggid: 'GGW', name: 'W' })] });
  const a = (await admin.get('/api/workspace')).body;
  assert.equal(a.uploadBatches.length, 1);
  assert.equal(a.counts.employees, 301);
  assert.equal((await reviewer.get('/api/workspace')).body.uploadBatches.length, 0);
});

// ------------------------------------------------------------ dashboards ----

test('executive: KPIs and charts match the engine, with and without quick filters', async () => {
  const { engine, cases } = await expectedCases();
  for (const qf of [{}, { regionType: 'EMEA' }, { region: 'India', practice: 'Broking Excellence' }]) {
    const scoped = cases.filter((c) => engine.matchesQuickFilters(c.employee, qf));
    const r = await reviewer.get('/api/dashboards/executive' + (Object.keys(qf).length ? qs(qf) : ''));
    assert.equal(r.status, 200);
    const d = r.body;
    assert.equal(d.total, scoped.length);
    RATINGS.forEach((rt) => assert.equal(d.ratingCounts[rt], scoped.filter((c) => c.rating.finalRating === rt).length, rt));
    assert.equal(d.eligibilityCounts.Eligible, scoped.filter((c) => c.eligibility.status === 'Eligible').length);
    assert.equal(d.atRiskTotal, scoped.filter((c) => c.risk.length).length);
    assert.equal(d.promotionRecommendations, scoped.filter((c) => c.employee.promotionRecommendation).length);
    assert.equal(d.learningCompliant, scoped.filter((c) => c.learning.status === 'Meets Requirement').length);
    assert.ok(d.atRisk.length <= 8);
    d.atRisk.forEach((x) => assert.ok(x.risk.length && x.id && x.name));
  }
  const none = await reviewer.get('/api/dashboards/executive?region=Atlantis');
  assert.deepEqual(none.body, { total: 0 });
});

test('executive: the search box narrows only the flagged-case list', async () => {
  const all = (await reviewer.get('/api/dashboards/executive')).body;
  const flagged = all.atRisk[0];
  const r = (await reviewer.get('/api/dashboards/executive?q=' + encodeURIComponent(flagged.ggid))).body;
  assert.equal(r.total, all.total);
  assert.equal(r.atRiskTotal, all.atRiskTotal);
  assert.equal(r.atRiskMatching, 1);
  assert.equal(r.atRisk[0].id, flagged.id);
});

test('rtd: KPIs, filters, sorting and paging', async () => {
  const { cases } = await expectedCases();
  let d = (await reviewer.get('/api/dashboards/rtd')).body;
  assert.equal(d.total, 300);
  assert.equal(d.eligible, cases.filter((c) => c.eligibility.status !== 'Not Eligible').length);
  assert.equal(d.avgConfidence, Math.round(cases.reduce((s, c) => s + c.ratingConfidence.score, 0) / 300));
  assert.ok(d.topBlockers.length > 0 && d.topBlockers.length <= 4);
  assert.equal(d.rows.length, 100, 'first page only');
  assert.equal(d.filteredTotal, 300);
  const names = d.rows.map((x) => x.name);
  assert.deepEqual(names, names.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'sorted by name');
  assert.equal(d.rows[0].accounts, undefined, 'rows carry no linked records');

  // Paging covers every case exactly once.
  const seen = new Set();
  for (let offset = 0; offset < 300; offset += 120) {
    (await reviewer.get(`/api/dashboards/rtd?offset=${offset}&limit=120`)).body.rows.forEach((x) => seen.add(x.id));
  }
  assert.equal(seen.size, 300);
  assert.equal((await reviewer.get('/api/dashboards/rtd?limit=100000')).body.rows.length, 300, 'limit is capped at 500');

  d = (await reviewer.get('/api/dashboards/rtd?rating=Exceptional&eligibility=Not%20Eligible')).body;
  assert.equal(d.filteredTotal, cases.filter((c) => c.rating.finalRating === 'Exceptional' && c.eligibility.status === 'Not Eligible').length);
  assert.equal(d.total, 300, 'KPIs ignore the table filters');
  d.rows.forEach((x) => assert.equal(x.finalRating, 'Exceptional'));

  d = (await reviewer.get('/api/dashboards/rtd?risk=1')).body;
  assert.equal(d.filteredTotal, cases.filter((c) => c.risk.length).length);

  d = (await reviewer.get('/api/dashboards/rtd?sort=rating&dir=-1&limit=500')).body;
  const order = { 'Needs Improvement': 0, Succeeding: 1, Exceeding: 2, Exceptional: 3 };
  for (let i = 1; i < d.rows.length; i++) assert.ok(order[d.rows[i - 1].finalRating] >= order[d.rows[i].finalRating]);
  // Achievement tie-break: within Exceptional, ranked rows come first, in rank order.
  const ranked = d.rows.filter((x) => x.finalRating === 'Exceptional' && x.achievementRank).map((x) => x.achievementRank.rank);
  assert.deepEqual(ranked, ranked.slice().sort((a, b) => a - b));
  assert.ok(ranked.length > 1);

  d = (await reviewer.get('/api/dashboards/rtd?q=underwriting')).body;
  assert.ok(d.filteredTotal > 0 && d.rows.every((x) => x.practice.toLowerCase().includes('underwriting') || x.name.toLowerCase().includes('underwriting')));
});

test('rtd export: every filtered row, HR Admin only', async () => {
  assert.equal((await reviewer.get('/api/dashboards/rtd/export')).status, 403);
  const all = (await admin.get('/api/dashboards/rtd/export')).body;
  assert.equal(all.rows.length, 300, 'not limited to one page');
  assert.equal(all.cycleLabel, 'FY2026 RTD Cycle');
  const ni = (await admin.get('/api/dashboards/rtd/export?rating=Needs%20Improvement')).body;
  assert.ok(ni.rows.length > 0 && ni.rows.every((x) => x.finalRating === 'Needs Improvement'));
  assert.ok(all.rows.some((x) => x.quotaRank), 'quota positions included');
});

test('promotions: funnel, KPIs, candidates and quota positions', async () => {
  const { engine, cases } = await expectedCases();
  const d = (await reviewer.get('/api/dashboards/promotions')).body;
  assert.equal(d.funnel[0].value, cases.filter((c) => c.employee.promotionRecommendation).length);
  assert.equal(d.funnel[2].value, cases.filter((c) => c.eligibility.status === 'Eligible').length);
  const candidates = cases.filter((c) => c.employee.promotionRecommendation || c.eligibility.status !== 'Not Eligible');
  assert.equal(d.candidatesTotal, candidates.length);
  assert.ok(d.readyForReview.length <= 3);
  const expectedQuota = {};
  engine.promotionQuotaExceptions(cases).forEach((ex) => ex.ranked.forEach((c, i) => {
    expectedQuota[c.employee.id] = { rank: i + 1, total: ex.total, quota: ex.quota, note: engine.promotionOverflowReason(ex, i + 1, c) };
  }));
  const all = (await reviewer.get('/api/dashboards/promotions?limit=500')).body.candidates;
  all.forEach((x) => {
    const q = expectedQuota[x.id];
    if (!q) return assert.equal(x.quota, null, x.id);
    assert.deepEqual([x.quota.rank, x.quota.total, x.quota.quota, x.quota.overQuota, x.quota.suggestedNote], [q.rank, q.total, q.quota, q.rank > q.quota, q.note], x.id);
  });
  const over = all.filter((x) => x.quota && x.quota.overQuota);
  assert.ok(over.length > 0, 'the demo data has over-quota grades');
  over.forEach((x) => {
    assert.ok(x.quota.rank > x.quota.quota);
    assert.match(x.quota.suggestedNote, /^Promotion-quota review, /);
    assert.ok(RATINGS.indexOf(x.quota.suggestedRating) <= RATINGS.indexOf('Succeeding'));
  });
  const elig = (await reviewer.get('/api/dashboards/promotions?eligibility=Eligible')).body;
  assert.ok(elig.candidates.every((x) => x.eligibilityStatus === 'Eligible'));
  assert.equal(elig.funnel[0].value, d.funnel[0].value, 'funnel ignores table filters');
  const page2 = (await reviewer.get('/api/dashboards/promotions?offset=10&limit=5')).body;
  assert.deepEqual(page2.candidates.map((x) => x.id), d.candidates.slice(10, 15).map((x) => x.id));
});

test('calibration: rating and readiness distributions', async () => {
  const { cases } = await expectedCases();
  const d = (await reviewer.get('/api/dashboards/calibration')).body;
  assert.equal(d.total, 300);
  assert.equal(Object.values(d.ratingCounts).reduce((a, b) => a + b, 0), 300);
  assert.equal(d.readinessCounts['Ready Now'], cases.filter((c) => c.employee.promotionReadiness === 'Ready Now').length);
});

// ------------------------------------------------------------- employees ----

test('dossier: one employee with linked records and the computed case', async () => {
  const { s, engine } = await expectedCases();
  const e = s.employees.find((x) => s.accounts.some((a) => a.employeeId === x.id) && x.isPeopleManager);
  const r = await reviewer.get('/api/employees/' + e.id);
  assert.equal(r.status, 200);
  const d = r.body;
  assert.deepEqual(d.employee, e);
  assert.deepEqual(d.accounts, s.accounts.filter((a) => a.employeeId === e.id));
  assert.deepEqual(d.contributions, s.contributions.filter((a) => a.employeeId === e.id));
  assert.deepEqual(d.managerRecord, s.managerRecords.find((m) => m.employeeId === e.id) || null);
  assert.deepEqual(d.workflow, s.workflow[e.id]);
  const c = engine.fullCase(e);
  assert.deepEqual(d.case.rating.trace, c.rating.trace);
  assert.deepEqual(d.case.eligibility, c.eligibility);
  assert.deepEqual(d.case.risk, c.risk);
  assert.equal((await reviewer.get('/api/employees/EMP-nope')).status, 404);
});

test('search: by name or GGID, else whether a practice matches', async () => {
  let d = (await reviewer.get('/api/employees/search?q=GG200001')).body;
  assert.equal(d.employees[0].ggid, 'GG200001');
  d = (await reviewer.get('/api/employees/search?q=nadia')).body;
  assert.ok(d.employees.some((x) => x.name === 'Nadia Kowalski'));
  d = (await reviewer.get('/api/employees/search?q=broking')).body;
  assert.equal(d.employees.length, 0);
  assert.equal(d.practiceMatch, true);
  d = (await reviewer.get('/api/employees/search?q=zzzz')).body;
  assert.deepEqual(d, { employees: [], practiceMatch: false });
});

// ------------------------------------------------------------ rules, audit ----

test('rule impact matches the engine; HR Admin only', async () => {
  const { s, engine, cases } = await expectedCases();
  for (const id of ['rule1', 'rule3', 'ruleA2', 'ruleM1', 'ruleL2', 'ruleA12']) {
    const r = await admin.get(`/api/rules/${id}/impact`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, engine.ruleImpactStats(s.rules.find((x) => x.id === id), cases, s.employees, s.managerRecords), id);
  }
  assert.equal((await reviewer.get('/api/rules/rule1/impact')).status, 403);
  assert.equal((await admin.get('/api/rules/nope/impact')).status, 404);
});

test('audit: newest first, entity and field-prefix filters, paging; HR Admin only', async () => {
  const mk = (i, entity, field) => ({ id: 'AUD-t' + i, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), user: 'T', entity, field, oldValue: i, newValue: i + 1, action: 'X' });
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push(mk(i, i % 2 ? 'Rule Configuration' : 'Rating Override', i % 2 ? 'Rule_% ' + i : 'ratingOverride'));
  await admin.post('/api/sync', { audit: entries });
  assert.equal((await reviewer.get('/api/audit')).status, 403);
  let d = (await admin.get('/api/audit?limit=10')).body;
  assert.equal(d.total, 31);
  assert.equal(d.entries.length, 10);
  assert.ok(d.entities.includes('Rule Configuration'));
  d = (await admin.get('/api/audit?entity=Rule%20Configuration&limit=500')).body;
  assert.equal(d.total, 15);
  assert.ok(d.entries.every((x) => x.entity === 'Rule Configuration'));
  d = (await admin.get('/api/audit?fieldPrefix=' + encodeURIComponent('Rule_% 1'))).body;
  assert.deepEqual(d.entries.map((x) => x.field).sort(), ['Rule_% 1', 'Rule_% 11', 'Rule_% 13', 'Rule_% 15', 'Rule_% 17', 'Rule_% 19'], '% and _ are matched literally');
  d = (await admin.get('/api/audit?fieldPrefix=Rule&offset=5&limit=5')).body;
  assert.equal(d.entries.length, 5);
});

test('archived cases: quick filters, counts and paging; HR Admin only', async () => {
  await admin.post('/api/cycles/archive', { nextLabel: 'FY2027 RTD Cycle' });
  const id = (await admin.get('/api/workspace')).body.archives[0].id;
  assert.equal((await reviewer.get(`/api/archives/${id}/cases`)).status, 403);
  let d = (await admin.get(`/api/archives/${id}/cases`)).body;
  assert.equal(d.totalArchived, 300);
  assert.equal(d.total, 300);
  assert.equal(d.cases.length, 100);
  assert.equal(Object.values(d.ratingCounts).reduce((a, b) => a + b, 0), 300);
  d = (await admin.get(`/api/archives/${id}/cases?region=India&limit=500`)).body;
  assert.ok(d.total > 0 && d.total < 300 && d.cases.every((c) => c.region === 'India'));
  assert.equal((await admin.get('/api/archives/ARC-nope/cases')).status, 404);
});

// ------------------------------------------------------- saves and cache ----

test('patch: changes only the given fields and dashboards reflect it immediately', async () => {
  const before = (await reviewer.get('/api/dashboards/executive')).body;
  const s = (await dbState()).data;
  const target = s.employees.find((e) => e.ratingOverride == null && e.activeBOTP === false);
  const exp = await reviewer.get('/api/employees/' + target.id);
  const prevRating = exp.body.case.rating.finalRating;
  const newRating = prevRating === 'Needs Improvement' ? 'Exceptional' : 'Needs Improvement';

  // Someone else changes another field of the same record first; the patch must not undo it.
  await admin.post('/api/sync', { patch: { employees: [{ id: target.id, set: { businessImpactNotes: 'Edited elsewhere' } }] } });
  const r = await admin.post('/api/sync', { patch: { employees: [{ id: target.id, set: { ratingOverride: newRating, ratingOverrideNote: 'calibration' } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const after = (await dbState()).data.employees.find((e) => e.id === target.id);
  assert.equal(after.ratingOverride, newRating);
  assert.equal(after.businessImpactNotes, 'Edited elsewhere');
  const dossier = (await reviewer.get('/api/employees/' + target.id)).body;
  assert.equal(dossier.case.rating.finalRating, newRating);
  const exec = (await reviewer.get('/api/dashboards/executive')).body;
  assert.equal(exec.ratingCounts[newRating], before.ratingCounts[newRating] + 1);
  assert.equal(exec.ratingCounts[prevRating], before.ratingCounts[prevRating] - 1);
});

test('patch: indexed GGID/email/year columns follow the record', async () => {
  const id = (await dbState()).data.employees[0].id;
  await admin.post('/api/sync', { patch: { employees: [{ id, set: { ggid: 'GGNEWID', email: ' New.Mail@X.com ', year: 2030 } }] } });
  const r = (await pool.query('select ggid, email_key, year from employees where id = $1', [id])).rows[0];
  assert.deepEqual(r, { ggid: 'GGNEWID', email_key: 'new.mail@x.com', year: 2030 });
});

test('patch: validation, unknown records and atomicity', async () => {
  const [a, b] = (await dbState()).data.employees;
  for (const body of [{ patch: { employees: 'x' } }, { patch: { employees: [{ id: a.id }] } }, { patch: { employees: [{ id: a.id, set: [] }] } }, { patch: { employees: [{ id: a.id, set: { id: 'EMP-other' } }] } }]) {
    assert.equal((await admin.post('/api/sync', body)).status, 400, JSON.stringify(body));
  }
  const r = await admin.post('/api/sync', { patch: { employees: [{ id: a.id, set: { name: 'Should roll back' } }, { id: 'EMP-gone', set: { name: 'x' } }] } });
  assert.equal(r.status, 404);
  assert.equal((await dbState()).data.employees.find((e) => e.id === a.id).name, a.name, 'nothing applied');
  assert.ok(b);
});

test('reviewers may only pick a primary account; everything else needs HR Admin', async () => {
  const s = (await dbState()).data;
  const e = s.employees.find((x) => s.accounts.some((acc) => acc.employeeId === x.id));
  const acc = s.accounts.find((x) => x.employeeId === e.id);
  const history = (e.changeHistory || []).concat([{ at: new Date().toISOString(), by: 'reviewer', field: 'primaryAccountOverride', before: null, after: acc.accountName }]);
  let r = await reviewer.post('/api/sync', {
    patch: { employees: [{ id: e.id, set: { primaryAccountOverride: acc.id, changeHistory: history } }] },
    audit: [{ id: 'AUD-rev1', user: 'reviewer', entity: 'Primary Account', field: 'primaryAccountOverride', employeeId: e.id }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await reviewer.get('/api/employees/' + e.id)).body.case.rating.primaryAccount.id, acc.id);

  r = await reviewer.post('/api/sync', { patch: { employees: [{ id: e.id, set: { ratingOverride: 'Exceptional', name: 'x' } }] } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /ratingOverride, name/);
  for (const body of [{ upsert: { employees: [e] } }, { remove: { employees: [e.id] } }, { upsert: { accounts: [acc] } }, { upsert: { workflow: [s.workflow[e.id]] } }]) {
    assert.equal((await reviewer.post('/api/sync', body)).status, 403, JSON.stringify(Object.keys(body)));
  }
  assert.equal((await dbState()).data.employees.find((x) => x.id === e.id).ratingOverride, e.ratingOverride);
});

test('cache: a data load is reflected in every dashboard and in search', async () => {
  const before = (await reviewer.get('/api/dashboards/rtd')).body.total;
  await admin.post('/api/data-load/commit', { rows: [row({ ggid: 'GGCACHE', name: 'Cache Tester', email: 'cache@example.test' })] });
  assert.equal((await reviewer.get('/api/dashboards/rtd')).body.total, before + 1);
  assert.equal((await reviewer.get('/api/dashboards/executive')).body.total, before + 1);
  assert.equal((await reviewer.get('/api/employees/search?q=GGCACHE')).body.employees[0].name, 'Cache Tester');
  await admin.post('/api/data-load/remove-all', {});
  assert.deepEqual((await reviewer.get('/api/dashboards/executive')).body, { total: 0 });
  assert.equal((await reviewer.get('/api/dashboards/rtd')).body.rows.length, 0);
});

test('a settings change (rule toggle) changes computed outcomes everywhere', async () => {
  const w = (await admin.get('/api/workspace')).body;
  const before = (await reviewer.get('/api/dashboards/executive')).body;
  const settings = JSON.parse(JSON.stringify(w.settings));
  settings.rules.find((r) => r.id === 'rule3').enabled = false; // Active BOTP no longer forces Needs Improvement
  const r = await admin.post('/api/sync', { settings, baseVersion: w.version });
  assert.equal(r.status, 200);
  const after = (await reviewer.get('/api/dashboards/executive')).body;
  assert.ok(after.ratingCounts['Needs Improvement'] < before.ratingCounts['Needs Improvement']);
  assert.equal((await admin.get('/api/rules/rule3/impact')).body.changed, 0);
});
