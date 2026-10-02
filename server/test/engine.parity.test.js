// The server rules engine (lib/engine.js) must produce exactly what the original browser engine
// produced. test/fixtures/engine-golden.json was recorded by running the browser app's own engine
// functions over these scenarios before that copy was removed from the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine, applySettingsDefaults } = require('../lib/engine');
const { SCENARIOS, QUICK_FILTERS } = require('./fixtures/engine-scenarios');
const { projectCase, projectQuota } = require('./fixtures/engine-projection');
const golden = require('./fixtures/engine-golden.json');

Object.keys(SCENARIOS).forEach((name) => {
  test(`engine parity with the original browser engine: ${name}`, () => {
    const s = SCENARIOS[name]();
    applySettingsDefaults(s);
    const engine = createEngine(s, s);
    const cases = s.employees.map(engine.fullCase);
    const expected = golden[name];

    assert.equal(cases.length, expected.cases.length);
    cases.forEach((c, i) => assert.deepEqual(projectCase(c), expected.cases[i], `case ${c.employee.id}`));
    assert.deepEqual(engine.achievementRanks(cases), expected.achievementRanks);
    assert.deepEqual(projectQuota(engine.promotionQuotaExceptions(cases), engine.promotionOverflowReason), expected.quota);
    assert.deepEqual(s.rules.map((r) => ({ id: r.id, stats: engine.ruleImpactStats(r, cases, s.employees, s.managerRecords) })), expected.ruleImpact);
    assert.deepEqual(QUICK_FILTERS.map((qf) => s.employees.filter((e) => engine.matchesQuickFilters(e, qf)).map((e) => e.id)), expected.quickFilters);
  });
});
