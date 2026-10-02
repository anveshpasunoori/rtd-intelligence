// Deterministic engine test scenarios built from the demo roster (db/seed.json). Used by
// test/engine.parity.test.js and by the script that recorded test/fixtures/engine-golden.json
// from the original browser engine.

const seed = require('../../db/seed.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

function base() {
  const s = clone(seed);
  s.meta.cycleLabel = s.meta.cycleLabel || 'FY2026 RTD Cycle';
  s.employees.forEach((e) => { if (e.year == null) e.year = 2026; });
  return s;
}

// 1: the demo data as shipped.
function seedAsIs() { return base(); }

// 2: rules switched off, HR overrides, BOTP exceptions, manual primary accounts.
function overridesAndToggles() {
  const s = base();
  ['rule7', 'rule8', 'rule2'].forEach((id) => { s.rules.find((r) => r.id === id).enabled = false; });
  s.rules.find((r) => r.id === 'rule4').params.capRating = 'Needs Improvement';
  s.employees.forEach((e, i) => {
    if (e.activeBOTP && i % 2 === 0) e.botpExceptionApproved = true;
    if (i % 17 === 0) { e.ratingOverride = ['Exceptional', 'Needs Improvement', 'Exceeding'][i % 3]; e.ratingOverrideNote = i % 2 ? 'Calibrated' : null; }
    if (i % 23 === 0) e.promotionEligibilityOverride = ['Eligible', 'Not Eligible', 'Eligible With Exception'][i % 3];
    if (i % 29 === 0) e.dataQualityIssues = ['Missing Region'];
  });
  return s;
}

// 3: grade configuration that matches the roster (so TIG, certification, learning-hours and quota
// logic all engage), multiple accounts per person (primary-account choice and tie confidence),
// and custom rules.
function customRulesAndThresholds() {
  const s = base();
  const titles = [];
  s.employees.forEach((e) => { if (titles.indexOf(e.localGrade) < 0) titles.push(e.localGrade); });
  const gradeOf = {};
  s.employees.forEach((e) => { gradeOf[e.localGrade] = gradeOf[e.localGrade] || e.globalGrade; });
  s.adminConfig.localGrades = titles.map((t, i) => ({ name: t, globalGrade: gradeOf[t], localGrade: 'L' + (i + 1), region: '' }));
  const grades = [];
  s.employees.forEach((e) => { if (grades.indexOf(e.globalGrade) < 0) grades.push(e.globalGrade); });
  const r6 = s.rules.find((r) => r.id === 'rule6');
  r6.params.l1MinGrade = grades[2];
  r6.params.l2MinGrade = grades[5];
  s.tigConfig = {};
  grades.forEach((g, i) => { s.tigConfig[g] = 0.5 + (i % 4) * 0.5; });
  s.ldHoursConfig = {};
  s.employees.forEach((e) => {
    const c = (s.ldHoursConfig[e.country] = s.ldHoursConfig[e.country] || {});
    const p = (c[e.practice] = c[e.practice] || {});
    p[e.localGrade] = 30 + (e.localGrade.length % 5) * 10;
  });
  s.quotaConfig = {};
  s.adminConfig.localGrades.forEach((r, i) => { s.quotaConfig[r.localGrade] = { promotions: i % 3 === 0 ? null : 5 + i, 'Needs Improvement': null, Succeeding: null, Exceeding: null, Exceptional: null }; });
  // Extra accounts: some clear winners, some within 2 months (a "close call").
  const extra = [];
  s.accounts.forEach((a, i) => {
    if (i % 4 === 0) extra.push(Object.assign({}, a, { id: a.id + '-b', accountName: a.accountName + ' II', durationMonths: a.durationMonths + (i % 8 === 0 ? 1 : 9), accountRating: ['Exceeding', 'Needs Improvement', 'Exceptional', 'Succeeding'][i % 4] }));
  });
  s.accounts = s.accounts.concat(extra);
  s.employees.forEach((e, i) => { if (i % 31 === 0) { const acc = s.accounts.find((a) => a.employeeId === e.id); if (acc) e.primaryAccountOverride = acc.id; } });
  s.rules.push({
    id: 'custom1', ruleId: 'R100', name: 'Low utilization cap', category: 'Rating', severity: 'Medium', enabled: true, builtin: false,
    description: 'Cap at Succeeding when utilization is low.', params: {}, conditionLogic: 'AND',
    conditions: [{ field: 'utilization', operator: '<', value: '75' }, { field: 'currentRating', operator: '!=', value: 'Needs Improvement' }],
    action: { type: 'capRating', value: 'Succeeding' },
  });
  s.rules.push({
    id: 'custom2', ruleId: 'R101', name: 'Top practice boost', category: 'Rating', severity: 'Low', enabled: true, builtin: false,
    description: '', params: {}, conditionLogic: 'OR',
    conditions: [{ field: 'practice', operator: '==', value: 'Claims Transformation' }, { field: 'promotedPriorYear', operator: 'isTrue' }],
    action: { type: 'setRating', value: 'Exceeding' },
  });
  s.rules.push({
    id: 'custom3', ruleId: 'R102', name: 'Disabled custom', category: 'Rating', severity: 'Low', enabled: false, builtin: false,
    description: 'Never applies.', params: {}, conditions: [{ field: 'utilization', operator: '>=', value: '0' }], action: { type: 'setRating', value: 'Needs Improvement' },
  });
  return s;
}

const SCENARIOS = { seedAsIs, overridesAndToggles, customRulesAndThresholds };

const QUICK_FILTERS = [
  {},
  { regionType: 'EMEA' },
  { region: 'India', practice: 'Broking Excellence' },
  { localGrade: 'Sr. Consultant' },
];

module.exports = { SCENARIOS, QUICK_FILTERS };
