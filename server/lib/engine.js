// RTD rules engine: computes each employee's case — final rating (with the trace of rules that
// shaped it), promotion eligibility, learning/certification compliance, risk flags, AI confidence
// scores and achievement score — plus the cross-case calculations dashboards need (achievement
// tie-break ranks, promotion-quota exceptions, rule impact).
//
// Ported unchanged in behavior from the browser app (test/engine.parity.test.js checks the output
// against the original browser engine for the demo roster). Pure: no database access.
//
//   const engine = createEngine(settings, { accounts, contributions, workflow, managerRecords })
//   engine.fullCase(employee)

const RATINGS = ['Needs Improvement', 'Succeeding', 'Exceeding', 'Exceptional'];
const RATING_RANK = { 'Needs Improvement': 0, Succeeding: 1, Exceeding: 2, Exceptional: 3 };
const CERT_RANK = { None: 0, Foundation: 1, L1: 2, L2: 3, L3: 4 };
const READINESS_ORDER = ['Not Ready', 'Ready 2+ Yrs', 'Ready 1-2 Yrs', 'Ready Now'];
const ELIGIBILITY_STATUSES = ['Eligible', 'Eligible With Exception', 'Not Eligible'];

const DEFAULT_LOCAL_GRADE_QUOTAS = {
  B1: { promotions: 25, 'Needs Improvement': 10, Succeeding: null, Exceeding: 30, Exceptional: 10 },
  B2: { promotions: 20, 'Needs Improvement': 10, Succeeding: null, Exceeding: 25, Exceptional: 10 },
  C1: { promotions: 20, 'Needs Improvement': 5, Succeeding: null, Exceeding: 25, Exceptional: 10 },
  C2: { promotions: 15, 'Needs Improvement': 5, Succeeding: null, Exceeding: 20, Exceptional: 10 },
  D1: { promotions: 10, 'Needs Improvement': 5, Succeeding: null, Exceeding: 15, Exceptional: 5 },
  D2: { promotions: 10, 'Needs Improvement': 0, Succeeding: null, Exceeding: 10, Exceptional: 5 },
  E1: { promotions: 5, 'Needs Improvement': 0, Succeeding: null, Exceeding: 10, Exceptional: 5 },
  E2: { promotions: 5, 'Needs Improvement': 0, Succeeding: null, Exceeding: 5, Exceptional: 5 },
};

function fmtDate(d) {
  if (!d) return '—';
  const parts = d.split('-');
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
}
function byId(arr, id) { for (let i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; } return null; }
function capRating(rating, cap) { return RATING_RANK[cap] < RATING_RANK[rating] ? cap : rating; }
function confidenceLevel(score) { return score >= 85 ? 'High' : score >= 60 ? 'Medium' : 'Low'; }

// Distinct values of one field of adminConfig.localGrades, in first-appearance order.
function orderedDistinct(adminConfig, field) {
  const seen = {}, list = [];
  ((adminConfig && adminConfig.localGrades) || []).forEach((r) => {
    const g = r[field];
    if (g && !seen[g]) { seen[g] = true; list.push(g); }
  });
  return list;
}

// Fills in workspace settings older data may lack (same defaults the app always applied).
function applySettingsDefaults(settings) {
  if (!settings.quotaConfig) {
    settings.quotaConfig = {};
    orderedDistinct(settings.adminConfig, 'localGrade').forEach((g) => {
      settings.quotaConfig[g] = DEFAULT_LOCAL_GRADE_QUOTAS[g] || { promotions: null, 'Needs Improvement': null, Succeeding: null, Exceeding: null, Exceptional: null };
    });
  }
  return settings;
}

function groupByEmployee(list) {
  const map = new Map();
  (list || []).forEach((x) => {
    let arr = map.get(x.employeeId);
    if (!arr) { arr = []; map.set(x.employeeId, arr); }
    arr.push(x);
  });
  return map;
}

function createEngine(settings, data) {
  const S = settings;
  const accountsAll = (data && data.accounts) || [];
  const accountsByEmp = groupByEmployee(accountsAll);
  const contribsByEmp = groupByEmployee(data && data.contributions);
  const workflow = (data && data.workflow) || {};
  const rulesById = new Map((S.rules || []).map((r) => [r.id, r]));
  const accountsById = new Map(accountsAll.map((a) => [a.id, a]));

  function rule(id) { return rulesById.get(id) || null; }
  function ruleOn(id) { const r = rule(id); return r ? !!r.enabled : false; }
  function gradeOrder() { return orderedDistinct(S.adminConfig, 'globalGrade'); }
  function localGradeOrder() { return orderedDistinct(S.adminConfig, 'localGrade'); }
  function localGradeCodeForName(name) {
    const hit = ((S.adminConfig && S.adminConfig.localGrades) || []).find((r) => r.name === name);
    return hit ? hit.localGrade : name;
  }
  function regionTypeForEmployee(e) {
    const hit = ((S.adminConfig && S.adminConfig.regions) || []).find((r) => r.name === e.region);
    return (hit ? hit.regionType : null) || e.regionType || '';
  }
  function getAccounts(employeeId) { return accountsByEmp.get(employeeId) || []; }
  function getContributions(employeeId) { return contribsByEmp.get(employeeId) || []; }

  function getPrimaryAccount(e) {
    const accs = getAccounts(e.id);
    if (!accs.length) return null;
    if (e.primaryAccountOverride) {
      const ov = accountsById.get(e.primaryAccountOverride);
      if (ov) return ov;
    }
    if (!ruleOn('rule7')) return accs[0];
    let best = accs[0];
    for (let i = 1; i < accs.length; i++) { if (accs[i].durationMonths > best.durationMonths) best = accs[i]; }
    return best;
  }

  function gradeAtLeast(grade, minGrade) {
    const order = gradeOrder();
    const gi = order.indexOf(grade), mi = order.indexOf(minGrade);
    if (gi < 0 || mi < 0) return false;
    return gi >= mi;
  }
  function requiredCertLevel(grade) {
    const r6 = rule('rule6');
    if (!r6 || !r6.enabled) return null;
    if (gradeAtLeast(grade, r6.params.l2MinGrade)) return 'L2';
    if (gradeAtLeast(grade, r6.params.l1MinGrade)) return 'L1';
    return null;
  }
  function meetsCertRequirement(e) {
    const req = requiredCertLevel(e.globalGrade);
    if (!req) return true;
    return CERT_RANK[e.certificationLevel || 'None'] >= CERT_RANK[req];
  }
  function trainingCompleteByCutoff(e) { return e.mandatoryTrainingStatus === 'Completed'; }

  function fieldValue(e, ctx, field) {
    switch (field) {
      case 'globalGrade': return e.globalGrade;
      case 'localGrade': return e.localGrade;
      case 'region': return e.region;
      case 'country': return e.country;
      case 'practice': return e.practice;
      case 'currentRating': return ctx.rating;
      case 'promotedPriorYear': return e.promotedPriorYear;
      case 'activeBOTP': return e.activeBOTP;
      case 'timeInGrade': return e.timeInGrade;
      case 'learningHoursCompleted': return e.learningHoursCompleted;
      case 'mandatoryTrainingStatus': return e.mandatoryTrainingStatus;
      case 'promotionReadiness': return e.promotionReadiness;
      case 'certificationLevel': return e.certificationLevel;
      case 'utilization': return e.utilization;
      default: return null;
    }
  }
  function evalCondition(cond, e, ctx) {
    const v = fieldValue(e, ctx, cond.field);
    const target = cond.value;
    switch (cond.operator) {
      case '==': return String(v) === String(target);
      case '!=': return String(v) !== String(target);
      case '>': return parseFloat(v) > parseFloat(target);
      case '>=': return parseFloat(v) >= parseFloat(target);
      case '<': return parseFloat(v) < parseFloat(target);
      case '<=': return parseFloat(v) <= parseFloat(target);
      case 'isTrue': return v === true;
      case 'isFalse': return v === false;
      default: return false;
    }
  }
  function evalCustomRule(r, e, ctx) {
    const conds = r.conditions || [];
    if (!conds.length) return { matched: false };
    const results = conds.map((c) => evalCondition(c, e, ctx));
    const matched = (r.conditionLogic === 'OR') ? results.some(Boolean) : results.every(Boolean);
    if (!matched) return { matched: false };
    const action = r.action || {};
    const out = { matched: true, detail: r.description || (r.name + ' matched.'), forced: false };
    if (action.type === 'capRating') { out.newRating = capRating(ctx.rating, action.value); out.detail = 'Custom rule capped rating at ' + action.value + '.'; out.forced = out.newRating !== ctx.rating; }
    if (action.type === 'setRating') { out.newRating = action.value; out.detail = 'Custom rule set rating to ' + action.value + '.'; out.forced = true; }
    return out;
  }

  // Core rating case: Rules 1, 3, 4, 7, 8, 9, custom rules, then any HR override.
  function computeRatingCase(e) {
    const trace = [];
    const primaryAccount = getPrimaryAccount(e);
    const accountRating = primaryAccount ? primaryAccount.accountRating : 'Succeeding';
    trace.push({ rule: 'Rule 7 · Longest Account Duration', detail: primaryAccount ? ('Primary account: ' + primaryAccount.accountName + ' (' + primaryAccount.durationMonths + ' mo' + (e.primaryAccountOverride ? ', manual override' : '') + ')') : 'No account on file', active: ruleOn('rule7'),
      note: primaryAccount ? ('Rating is anchored to the account this person has spent the most time on, ' + primaryAccount.accountName + ' (' + primaryAccount.durationMonths + ' months' + (e.primaryAccountOverride ? ', manually selected by HR' : '') + ').') : 'No account is on file for this employee, so the rating could not be anchored to actual account performance.' });

    let rating = accountRating;
    if (ruleOn('rule8')) {
      const r8 = rule('rule8');
      const contribs = getContributions(e.id);
      const strongContrib = contribs.some((c) => c.impactRating === 'Significant' || c.impactRating === 'Exceptional');
      const blocked = r8.params.blockLiftFromNeedsImprovement && accountRating === 'Needs Improvement';
      if (strongContrib && !blocked) {
        const lifted = Math.min(RATING_RANK[accountRating] + (r8.params.maxContributionLift || 1), 3);
        rating = RATINGS[lifted];
        trace.push({ rule: 'Rule 8 · Account Performance Baseline', detail: 'Baseline ' + accountRating + ' lifted to ' + rating + ' via strong practice contributions.', active: true,
          note: 'Account performance alone would put this rating at ' + accountRating + ', but strong practice contributions this cycle raised it to ' + rating + '.' });
      } else {
        trace.push({ rule: 'Rule 8 · Account Performance Baseline', detail: blocked ? 'Baseline locked at ' + accountRating + ' — contributions cannot lift out of Needs Improvement.' : 'Baseline set to account rating ' + accountRating + ' (no qualifying lift).', active: true,
          note: blocked ? 'The account performance rating of ' + accountRating + ' stands — strong practice contributions can raise most ratings, but not one that starts at Needs Improvement.' : 'Rating is based on the account performance rating of ' + accountRating + '; no contribution this cycle was strong enough to raise it further.' });
      }
    }

    const caps = [];
    if (e.activeBOTP && ruleOn('rule3')) {
      const r3 = rule('rule3');
      if (e.botpExceptionApproved) {
        trace.push({ rule: 'Rule 3 · Active BOTP', detail: 'Active BOTP normally forces Needs Improvement — exception approved, rule bypassed.', active: true, exception: true,
          note: 'This employee has an active Business On Track Plan, which would normally set the rating to Needs Improvement — an approved exception means that did not apply here.' });
      } else {
        rating = r3.params.forcedRating || 'Needs Improvement';
        trace.push({ rule: 'Rule 3 · Active BOTP', detail: 'Active BOTP with no exception approval — rating forced to ' + rating + '.', active: true, forced: true,
          note: 'This employee has an active Business On Track Plan with no exception approved, so the rating was set to ' + rating + ' regardless of other performance factors.' });
      }
    } else if (e.botpCompleted && ruleOn('rule9')) {
      const r9 = rule('rule9');
      caps.push({ cap: r9.params.capRating || 'Exceeding', label: 'Rule 9 · BOTP Completed', reason: 'this employee completed a Business On Track Plan this cycle, which caps the rating at ' });
    }
    if (e.promotedPriorYear && ruleOn('rule1')) {
      const r1 = rule('rule1');
      caps.push({ cap: r1.params.capRating || 'Exceeding', label: 'Rule 1 · Prior Year Promotion Cap', reason: 'this employee was promoted last year, which caps this year\'s rating at ' });
    }
    const trainingOk = trainingCompleteByCutoff(e);
    if (!trainingOk && ruleOn('rule4')) {
      const r4c = rule('rule4');
      caps.push({ cap: r4c.params.capRating || 'Succeeding', label: 'Rule 4 · Mandatory Training Cutoff (' + fmtDate(r4c.params.rtdCutoffDate) + ')', reason: 'mandatory training was not completed by the ' + fmtDate(r4c.params.rtdCutoffDate) + ' cutoff, which caps the rating at ' });
    }

    let finalRating = rating;
    const forcedByBotp = e.activeBOTP && ruleOn('rule3') && !e.botpExceptionApproved;
    if (!forcedByBotp) {
      caps.forEach((c) => {
        const before = finalRating;
        finalRating = capRating(finalRating, c.cap);
        if (finalRating !== before) trace.push({ rule: c.label, detail: 'Capped rating from ' + before + ' to ' + finalRating + '.', active: true, forced: true,
          note: 'Normally, ' + c.reason + c.cap + '. As a result, this rating was reduced from ' + before + ' to ' + finalRating + '.' });
        else trace.push({ rule: c.label, detail: 'Cap of ' + c.cap + ' did not affect computed rating of ' + before + '.', active: true,
          note: 'Normally, ' + c.reason + c.cap + ', but this rating was already ' + before + ', so nothing changed.' });
      });
    }

    (S.rules || []).filter((r) => !r.builtin && r.enabled).forEach((r) => {
      const res = evalCustomRule(r, e, { rating: finalRating, primaryAccount });
      if (res.matched) {
        trace.push({ rule: r.name + ' (custom)', detail: res.detail, active: true, forced: res.forced, note: res.detail });
        if (res.newRating) finalRating = res.newRating;
      }
    });

    const systemRating = finalRating;
    if (e.ratingOverride) {
      finalRating = e.ratingOverride;
      trace.push({ rule: 'HR Override', detail: 'HR manually set the final rating to ' + finalRating + ' (system-computed: ' + systemRating + ').' + (e.ratingOverrideNote ? ' Note: ' + e.ratingOverrideNote : ''), active: true, forced: true,
        note: 'An HR reviewer manually set the final rating to ' + finalRating + ' (the system had recommended ' + systemRating + ').' + (e.ratingOverrideNote ? ' Reason given: ' + e.ratingOverrideNote : '') });
    }
    return { finalRating, systemRating, baselineRating: accountRating, trace, primaryAccount, trainingOk };
  }

  function tigMeetsRequirement(e) {
    const req = (S.tigConfig || {})[e.globalGrade];
    if (req == null) return true;
    return e.timeInGrade >= req;
  }

  function computeLearningCompliance(e) {
    const byPractice = ((S.ldHoursConfig || {})[e.country] || {})[e.practice] || {};
    const required = byPractice[e.localGrade] != null ? byPractice[e.localGrade] : 50;
    const completed = e.learningHoursCompleted;
    const status = completed >= required ? 'Meets Requirement' : 'Below Requirement';
    return { required, completed, status, onTimeCompletion: e.mandatoryTrainingStatus === 'Completed' };
  }

  function computePromotionEligibility(e) {
    const reasons = [], blocking = [], exceptions = [];
    if (e.promotedPriorYear && ruleOn('rule2')) {
      blocking.push('Rule 2 · Promoted in the prior year — excluded from promotion consideration this cycle.');
    }
    if (ruleOn('rule5')) {
      const r5 = rule('rule5');
      if (e.promotionReadiness !== (r5.params.requiredReadiness || 'Ready Now')) {
        blocking.push('Rule 5 · GetSuccess readiness is "' + e.promotionReadiness + '", requires "' + (r5.params.requiredReadiness || 'Ready Now') + '".');
      }
      if (!e.promotionRecommendation) blocking.push('Rule 5 · No promotion recommendation on file.');
    }
    const learn = computeLearningCompliance(e);
    if (learn.status !== 'Meets Requirement') {
      blocking.push('L&D · Learning hours below requirement (' + e.learningHoursCompleted + ' of ' + learn.required + ' hrs, ' + e.country + ' / ' + e.practice + ' / ' + e.localGrade + ').');
    }
    if (e.mandatoryTrainingStatus !== 'Completed') blocking.push('L&D · Mandatory training not completed.');
    if (ruleOn('rule6') && !meetsCertRequirement(e)) {
      const req = requiredCertLevel(e.globalGrade);
      exceptions.push('Rule 6 · Requires Certification ' + req + ', currently holds "' + (e.certificationLevel || 'None') + '".');
    }
    if (!tigMeetsRequirement(e)) {
      exceptions.push('TIG · ' + e.timeInGrade + ' yrs in grade, requires ' + S.tigConfig[e.globalGrade] + ' yrs for Grade ' + e.globalGrade + '.');
    }
    if (e.activeBOTP) {
      if (e.botpExceptionApproved) exceptions.push('BOTP · Active BOTP with approved exception.');
      else blocking.push('BOTP · Active BOTP with no exception approval.');
    }
    let systemStatus;
    if (blocking.length) systemStatus = 'Not Eligible';
    else if (exceptions.length) systemStatus = 'Eligible With Exception';
    else systemStatus = 'Eligible';
    blocking.forEach((b) => reasons.push({ ok: false, text: b }));
    exceptions.forEach((x) => reasons.push({ ok: 'exception', text: x }));
    if (!blocking.length && !exceptions.length) reasons.push({ ok: true, text: 'All eligibility criteria satisfied.' });
    let status = systemStatus;
    if (e.promotionEligibilityOverride) {
      status = e.promotionEligibilityOverride;
      reasons.push({ ok: true, text: 'HR override applied — set to ' + status + ' (AI/system recommendation: ' + systemStatus + ').' });
    }
    return { status, systemStatus, overridden: !!e.promotionEligibilityOverride, reasons };
  }

  function computeCertGap(e) {
    const req = requiredCertLevel(e.globalGrade);
    if (!req) return { required: 'None', held: e.certificationLevel || 'None', gap: false };
    const gap = CERT_RANK[e.certificationLevel || 'None'] < CERT_RANK[req];
    return { required: req, held: e.certificationLevel || 'None', gap };
  }

  // AI confidence: a proxy for how borderline the (pre-override) recommendation is.
  function ratingConfidence(e, rc) {
    let score = 100;
    const reasons = [];
    const acc = rc.primaryAccount;
    if (!acc) {
      score -= 30;
      reasons.push('No account on file — baseline rating defaulted to "Succeeding" rather than measured from actual account performance.');
    } else {
      const accs = getAccounts(e.id);
      if (accs.length > 1 && !e.primaryAccountOverride) {
        const sorted = accs.slice().sort((a, b) => b.durationMonths - a.durationMonths);
        const gap = sorted[0].durationMonths - sorted[1].durationMonths;
        if (gap <= 2) {
          score -= 15;
          reasons.push('Multiple accounts have similar tenure (' + sorted[0].durationMonths + ' vs ' + sorted[1].durationMonths + ' months) — which one counts as "primary" is a close call.');
        }
      }
    }
    rc.trace.forEach((t) => {
      if (t.rule.indexOf('HR Override') === 0) return;
      if (t.exception) { score -= 10; reasons.push(t.rule + ' — exception applied: ' + t.detail); }
      else if (t.forced) { score -= 12; reasons.push(t.rule + ' — rule intervention changed the computed rating.'); }
    });
    if (rc.trace.some((t) => t.rule.indexOf('Rule 8') === 0 && t.detail.indexOf('lifted') >= 0)) {
      score -= 8;
      reasons.push('Baseline was lifted based on a manager\'s subjective "Significant/Exceptional" contribution rating, not a hard metric.');
    }
    score = Math.max(10, Math.min(100, score));
    return { score, level: confidenceLevel(score), reasons: reasons.length ? reasons : ['Account performance baseline applied cleanly, with no rule interventions or ambiguity.'] };
  }
  function promotionConfidence(e, elig) {
    let score = 100;
    const reasons = [];
    elig.reasons.filter((r) => r.ok === 'exception').forEach((r) => { score -= 15; reasons.push(r.text); });
    const learn = computeLearningCompliance(e);
    if (learn.required > 0) {
      const learnMargin = Math.abs(learn.completed - learn.required) / learn.required;
      if (learnMargin <= 0.1) {
        score -= 15;
        reasons.push('Learning hours (' + learn.completed + ' of ' + learn.required + ') are within ' + Math.round(learnMargin * 100) + '% of the requirement — a close call either way.');
      }
    }
    const tigReq = (S.tigConfig || {})[e.globalGrade];
    if (tigReq != null && Math.abs(e.timeInGrade - tigReq) <= 0.25) {
      score -= 15;
      reasons.push('Time in grade (' + e.timeInGrade + ' yrs) sits right at the ' + tigReq + '-year requirement, with little buffer.');
    }
    if (elig.systemStatus === 'Not Eligible') {
      const blockingCount = elig.reasons.filter((r) => r.ok === false).length;
      if (blockingCount === 1) {
        score -= 10;
        reasons.push('Only one blocking factor is keeping this case from eligibility — resolving it alone would flip the outcome.');
      }
    }
    score = Math.max(10, Math.min(100, score));
    return { score, level: confidenceLevel(score), reasons: reasons.length ? reasons : ['All eligibility criteria are clearly met or clearly unmet, with no borderline factors.'] };
  }

  // Achievement score: orders equally-rated, equally-confident cases (never changes a rating).
  function achievementScore(e) {
    const contribs = getContributions(e.id);
    const significant = contribs.filter((c) => c.impactRating === 'Significant').length;
    const exceptional = contribs.filter((c) => c.impactRating === 'Exceptional').length;
    const certRank = CERT_RANK[e.certificationLevel || 'None'] || 0;
    const awards = (e.awards || []).length;
    const score = (awards * 20) + (significant * 6) + (exceptional * 12) + (certRank * 5) + Math.round((e.utilization || 0) / 10);
    return { score, awards, significantContribs: significant, exceptionalContribs: exceptional, certLevel: e.certificationLevel || 'None', utilization: e.utilization || 0 };
  }

  function fullCase(e) {
    const rc = computeRatingCase(e);
    const elig = computePromotionEligibility(e, rc);
    const learn = computeLearningCompliance(e);
    const cert = computeCertGap(e);
    const wf = workflow[e.id];
    const risk = [];
    if (e.dataQualityIssues && e.dataQualityIssues.length) e.dataQualityIssues.forEach((issue) => risk.push('Data upload: ' + issue));
    if (e.activeBOTP && !e.botpExceptionApproved) risk.push('Active BOTP');
    if (elig.status === 'Not Eligible' && e.promotionRecommendation && e.promotionReadiness === 'Ready Now') risk.push('Recommended & ready, but not eligible');
    if (learn.status === 'Below Requirement' && learn.completed < learn.required - 6) risk.push('Learning hours short');
    if (cert.gap && (e.promotionReadiness === 'Ready Now' || e.promotionRecommendation)) risk.push('Certification gap');
    if (rc.baselineRating === 'Needs Improvement') risk.push('Weak account performance');
    if (rc.finalRating === 'Needs Improvement' && !(e.activeBOTP && !e.botpExceptionApproved)) risk.push('Needs Improvement rating');
    return { employee: e, rating: rc, eligibility: elig, learning: learn, cert, workflow: wf, risk,
      ratingConfidence: ratingConfidence(e, rc), promotionConfidence: promotionConfidence(e, elig), achievement: achievementScore(e) };
  }

  // Among cases sharing a top-tier rating at 100% rating confidence, rank by achievement score.
  // Returns {employeeId: {rank, of, tier}} for members of tied groups only.
  function achievementRanks(cases) {
    const groups = {};
    cases.forEach((c) => {
      if ((c.rating.finalRating === 'Exceptional' || c.rating.finalRating === 'Exceeding') && c.ratingConfidence.score === 100) {
        (groups[c.rating.finalRating] = groups[c.rating.finalRating] || []).push(c);
      }
    });
    const ranks = {};
    Object.keys(groups).forEach((key) => {
      const g = groups[key];
      if (g.length < 2) return;
      g.sort((a, b) => b.achievement.score - a.achievement.score);
      g.forEach((c, i) => { ranks[c.employee.id] = { rank: i + 1, of: g.length, tier: key }; });
    });
    return ranks;
  }

  // Per Local Grade with a configured promotions quota (a % of the grade's whole population) that
  // the promotion-eligible cases exceed: those cases ranked by time in grade, certification, then
  // utilization.
  function promotionQuotaExceptions(cases) {
    const gradeTotalAll = {};
    cases.forEach((c) => { const g = c.employee.localGrade; gradeTotalAll[g] = (gradeTotalAll[g] || 0) + 1; });
    const byGrade = {};
    cases.forEach((c) => {
      if (c.eligibility.status === 'Not Eligible') return;
      (byGrade[c.employee.localGrade] = byGrade[c.employee.localGrade] || []).push(c);
    });
    const out = [];
    Object.keys(byGrade).forEach((g) => {
      const pct = ((S.quotaConfig || {})[localGradeCodeForName(g)] || {}).promotions;
      if (pct == null) return;
      const quota = Math.round(pct / 100 * (gradeTotalAll[g] || 0));
      const ranked = byGrade[g].slice().sort((a, b) => {
        if (b.employee.timeInGrade !== a.employee.timeInGrade) return b.employee.timeInGrade - a.employee.timeInGrade;
        const ca = CERT_RANK[a.employee.certificationLevel || 'None'] || 0, cb = CERT_RANK[b.employee.certificationLevel || 'None'] || 0;
        if (cb !== ca) return cb - ca;
        return (b.employee.utilization || 0) - (a.employee.utilization || 0);
      });
      if (ranked.length > quota) out.push({ localGrade: g, quota, quotaPct: pct, gradeTotal: gradeTotalAll[g] || 0, total: ranked.length, ranked });
    });
    const order = localGradeOrder();
    out.sort((a, b) => order.indexOf(localGradeCodeForName(a.localGrade)) - order.indexOf(localGradeCodeForName(b.localGrade)));
    return out;
  }

  function promotionOverflowReason(ex, rank, c) {
    return 'Promotion-quota review, ' + ex.localGrade + ' (' + localGradeCodeForName(ex.localGrade) + '): ' + ex.total + ' promotion-eligible candidate(s) this cycle against a quota of ' + ex.quota + ' (' + ex.quotaPct + '% of ' + ex.gradeTotal + ' in this grade). Ranked by time-in-grade, certification level, and utilization — ranked ' + rank + ' of ' + ex.total + ' (TIG ' + c.employee.timeInGrade + ' yrs, ' + (c.employee.certificationLevel || 'None') + ' cert, ' + (c.employee.utilization || 0) + '% utilization). Rating capped to a modest bracket rather than advanced this cycle; remains fully promotion-eligible for next cycle.';
  }

  // How many cases a rule touches (Rules Engine → Test). Tracking rules are measured directly
  // against the roster / accounts / manager records.
  function ruleImpactStats(r, cases, employees, managerRecords) {
    if (r.trackType === 'draft') return { total: cases.length, evaluated: 0, changed: 0, needsConfig: true };
    const empById = new Map(employees.map((e) => [e.id, e]));
    const isMgr = (m) => { const e = empById.get(m.employeeId); return e && e.isPeopleManager; };
    if (r.trackType === 'completeness') {
      const items = r.trackOn === 'account' ? accountsAll : employees;
      const complete = items.filter((x) => { const v = x[r.trackField]; return v !== null && v !== undefined && v !== ''; }).length;
      return { total: items.length, evaluated: items.length, changed: complete, tracking: true, trackLabel: 'have this documented' };
    }
    if (r.trackType === 'ratio' || r.trackType === 'boolean') {
      const mgrs = managerRecords.filter(isMgr);
      const complete = mgrs.filter((m) => (r.trackType === 'ratio' ? (m[r.ratioTotalField] === 0 || m[r.ratioCompletedField] >= m[r.ratioTotalField]) : !!m[r.trackField])).length;
      return { total: mgrs.length, evaluated: mgrs.length, changed: complete, tracking: true, trackLabel: 'have this fully completed' };
    }
    if (r.trackType === 'formula' && r.formulaId === 'learningHours') {
      const complete = employees.filter((e) => computeLearningCompliance(e).status === 'Meets Requirement').length;
      return { total: employees.length, evaluated: employees.length, changed: complete, tracking: true, trackLabel: 'meet their learning hours requirement' };
    }
    if (r.trackType === 'checkinRatio') {
      const mgrs = managerRecords.filter(isMgr);
      const perCounselee = (S.managerConfig || {}).minCheckInsRequired || 0;
      const complete = mgrs.filter((m) => { const req = m.counseleeCount * perCounselee; return req === 0 || m.checkInsCompleted >= req; }).length;
      return { total: mgrs.length, evaluated: mgrs.length, changed: complete, tracking: true, trackLabel: 'have completed their required check-ins' };
    }
    if (r.trackType === 'dateCutoff') {
      const mgrs = managerRecords.filter(isMgr);
      const cutoff = (S.managerConfig || {})[r.cutoffConfigField];
      const complete = mgrs.filter((m) => cutoff && m[r.dateField] && m[r.dateField] <= cutoff).length;
      return { total: mgrs.length, evaluated: mgrs.length, changed: complete, tracking: true, trackLabel: 'completed this by the configured due date' };
    }
    const prefix = r.builtin ? ('Rule ' + parseInt(r.id.replace('rule', ''), 10) + ' ·') : (r.name + ' (custom)');
    let total = 0, evaluated = 0, changed = 0;
    cases.forEach((c) => {
      total++;
      const traceHits = (c.rating.trace || []).filter((t) => t.rule && t.rule.indexOf(prefix) === 0);
      const reasonHits = (c.eligibility.reasons || []).filter((x) => x.text && x.text.indexOf(prefix) === 0);
      if (traceHits.length || reasonHits.length) evaluated++;
      if (traceHits.some((t) => t.forced || t.exception) || reasonHits.length) changed++;
    });
    return { total, evaluated, changed };
  }

  // Sidebar quick filters (Region Type / Region / Local Grade / Practice).
  function matchesQuickFilters(e, qf) {
    if (qf.regionType && regionTypeForEmployee(e) !== qf.regionType) return false;
    if (qf.region && e.region !== qf.region) return false;
    if (qf.localGrade && e.localGrade !== qf.localGrade) return false;
    if (qf.practice && e.practice !== qf.practice) return false;
    return true;
  }

  return {
    fullCase, achievementRanks, promotionQuotaExceptions, promotionOverflowReason, ruleImpactStats,
    matchesQuickFilters, computeLearningCompliance, localGradeOrder, localGradeCodeForName, getAccounts, getContributions,
  };
}

module.exports = {
  RATINGS, RATING_RANK, CERT_RANK, READINESS_ORDER, ELIGIBILITY_STATUSES,
  createEngine, applySettingsDefaults, capRating, fmtDate,
};
