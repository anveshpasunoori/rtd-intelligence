// Unit tests for the Annual Data Load rules (lib/dataload.js) — no database needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const dl = require('../lib/dataload');

const LABEL = 'FY2026 RTD Cycle';
function emp(o) {
  return Object.assign({
    id: 'EMP-' + Math.random().toString(36).slice(2, 9), ggid: 'GG1', name: 'Ann Lee', email: 'ann@x.com', region: 'India', globalGrade: 'C1',
    practice: 'P', ratingsHistory: ['Succeeding', 'Succeeding', 'Exceeding'], dataQualityIssues: [], year: 2025,
  }, o);
}

test('header resolution: template keys, normalized spellings and aliases', () => {
  assert.equal(dl.resolveHeader('Global Grade'), 'globalGrade');
  assert.equal(dl.resolveHeader('GGID'), 'ggid');
  assert.equal(dl.resolveHeader('Employee Name'), 'name');
  assert.equal(dl.resolveHeader('Work Email'), 'email');
  assert.equal(dl.resolveHeader('Emp ID'), 'ggid');
  assert.equal(dl.resolveHeader('Manager Name'), 'peopleManager');
  assert.equal(dl.resolveHeader('  Something Else '), 'Something Else');
  assert.equal(dl.resolveHeader(''), '');
});

test('normalizeRows trims values, resolves headers and rejects bad input', () => {
  const rows = dl.normalizeRows([{ 'Employee Name': '  Bo Chan ', GGID: 'G9', utilization: 80, blank: null }]);
  assert.deepEqual(rows[0], { name: 'Bo Chan', ggid: 'G9', utilization: '80', blank: '' });
  assert.throws(() => dl.normalizeRows('x'), /array/);
  assert.throws(() => dl.normalizeRows([]), /no data rows/);
  assert.throws(() => dl.normalizeRows([1]), /Row 2 is not an object/);
  assert.throws(() => dl.normalizeRows([{ a: { nested: 1 } }]), /plain value/);
  assert.throws(() => dl.normalizeRows(new Array(dl.MAX_ROWS + 1).fill({})), /Too many rows/);
  try { dl.normalizeRows([]); } catch (e) { assert.equal(e.status, 400); }
});

test('cycle year comes from the cycle label', () => {
  assert.equal(dl.cycleYear('FY2027 RTD Cycle'), 2027);
  assert.equal(dl.cycleYear('No year'), new Date().getFullYear());
});

test('matching: GGID first, then case-insensitive email, else a new case', () => {
  const a = emp({ ggid: 'GG1', email: 'ann@x.com' });
  const b = emp({ ggid: 'GG2', email: 'Bob@X.com' });
  const plan = dl.planDataLoad([a, b], dl.normalizeRows([
    { ggid: 'GG1', name: 'Ann Lee-Smith' },
    { ggid: '', email: ' bob@x.COM ', region: 'Canada' },
    { ggid: 'GG3', name: 'New Person', region: 'India', globalGrade: 'C2', practice: 'P', priorYearRating: 'Exceptional' },
  ]), LABEL);
  assert.deepEqual(plan.outcomes.map((o) => o.action), ['update', 'update', 'create']);
  assert.equal(plan.outcomes[0].employeeId, a.id);
  assert.equal(plan.outcomes[1].employeeId, b.id);
  assert.deepEqual(plan.summary, { total: 3, creates: 1, updates: 2, flagged: 0 });
  assert.equal(plan.updated.find((u) => u.after.id === a.id).after.name, 'Ann Lee-Smith');
  assert.equal(plan.updated.find((u) => u.after.id === b.id).after.region, 'Canada');
});

test('planning never mutates the roster it was given', () => {
  const a = emp({ ggid: 'GG1' });
  const before = JSON.stringify(a);
  dl.planDataLoad([a], dl.normalizeRows([{ ggid: 'GG1', name: 'Changed', priorYearRating: 'Exceptional' }]), LABEL);
  assert.equal(JSON.stringify(a), before);
});

test('updates: blanks keep values, ratings shift, booleans/numbers parse, year is stamped', () => {
  const a = emp({ ggid: 'GG1', utilization: 50, activeBOTP: false });
  const plan = dl.planDataLoad([a], dl.normalizeRows([{ ggid: 'GG1', name: '', priorYearRating: 'Exceptional', utilization: '91.5', activeBOTP: 'yes', timeInGrade: 'abc' }]), LABEL);
  const { before, after } = plan.updated[0];
  assert.equal(before, a);
  assert.equal(after.name, 'Ann Lee');
  assert.deepEqual(after.ratingsHistory, ['Succeeding', 'Exceeding', 'Exceptional']);
  assert.equal(after.utilization, 91.5);
  assert.equal(after.activeBOTP, true);
  assert.equal(after.timeInGrade, undefined, 'non-numeric value is ignored, not stored as NaN');
  assert.equal(after.year, 2026);
});

test('an invalid prior-year rating does not shift the rating history on update', () => {
  const a = emp({ ggid: 'GG1' });
  const plan = dl.planDataLoad([a], dl.normalizeRows([{ ggid: 'GG1', priorYearRating: 'Great' }]), LABEL);
  assert.deepEqual(plan.updated[0].after.ratingsHistory, a.ratingsHistory);
});

test('new cases: defaults and missing-data flags', () => {
  const plan = dl.planDataLoad([], dl.normalizeRows([{ email: 'x@y.com' }]), LABEL);
  const e = plan.created[0];
  assert.match(e.id, /^EMP-[a-z0-9]{7}$/);
  assert.equal(e.name, 'Unnamed (missing data)');
  assert.equal(e.globalGrade, 'C1');
  assert.equal(e.utilization, 70);
  assert.equal(e.year, 2026);
  assert.deepEqual(e.ratingsHistory, ['Succeeding', 'Succeeding', 'Succeeding']);
  assert.equal(e.dataQualityIssues.length, 6);
  assert.ok(e.dataQualityIssues[0].startsWith('Missing GGID'));
  assert.equal(plan.summary.flagged, 1);
});

test('a complete new row is not flagged', () => {
  const plan = dl.planDataLoad([], dl.normalizeRows([{ ggid: 'G5', name: 'Z Q', region: 'India', globalGrade: 'C2', practice: 'P', priorYearRating: 'Succeeding' }]), LABEL);
  assert.deepEqual(plan.created[0].dataQualityIssues, []);
  assert.equal(plan.summary.flagged, 0);
});

test('a later row in the same file updates the record an earlier row created', () => {
  const plan = dl.planDataLoad([], dl.normalizeRows([
    { ggid: 'G7', name: 'First Version', region: 'India', globalGrade: 'C2', practice: 'P', priorYearRating: 'Succeeding' },
    { ggid: 'G7', name: 'Second Version' },
  ]), LABEL);
  assert.deepEqual(plan.outcomes.map((o) => o.action), ['create', 'update']);
  assert.equal(plan.created.length, 1);
  assert.equal(plan.updated.length, 0, 'not recorded as an update of a pre-existing employee');
  assert.equal(plan.created[0].name, 'Second Version');
});

test('the same existing employee touched twice keeps its original pre-upload snapshot', () => {
  const a = emp({ ggid: 'GG1', name: 'Orig' });
  const plan = dl.planDataLoad([a], dl.normalizeRows([{ ggid: 'GG1', name: 'One' }, { ggid: 'GG1', name: 'Two' }]), LABEL);
  assert.equal(plan.updated.length, 1);
  assert.equal(plan.updated[0].before.name, 'Orig');
  assert.equal(plan.updated[0].after.name, 'Two');
});

test('an ambiguous GGID is not matched; falls back to email', () => {
  const a = emp({ ggid: 'DUP', email: 'a@x.com' });
  const b = emp({ ggid: 'DUP', email: 'b@x.com' });
  const plan = dl.planDataLoad([a, b], dl.normalizeRows([{ ggid: 'DUP', email: 'b@x.com' }, { ggid: 'DUP' }]), LABEL);
  assert.equal(plan.outcomes[0].employeeId, b.id);
  // b's GGID is now registered again, so the second DUP row matches b (most recent registration).
  assert.equal(plan.outcomes[1].action, 'update');
});

test('duplicate GGID flags: same GGID + same year flags both; cleared when resolved', () => {
  const a = emp({ ggid: 'G1', year: 2026 });
  const b = emp({ ggid: 'G1', year: 2026 });
  const c = emp({ ggid: 'G1', year: 2025 });
  const changed = dl.recomputeDuplicateFlags([a, b, c]);
  assert.deepEqual(changed.sort(), [a.id, b.id].sort());
  assert.ok(dl.hasDuplicateFlag(a) && dl.hasDuplicateFlag(b) && !dl.hasDuplicateFlag(c));
  assert.match(a.dataQualityIssues[0], /2 records share this GGID in 2026/);
  assert.deepEqual(dl.recomputeDuplicateFlags([a, b, c]), [], 'idempotent');
  b.year = 2025;
  dl.recomputeDuplicateFlags([a, b, c]);
  assert.ok(!dl.hasDuplicateFlag(a));
  assert.ok(dl.hasDuplicateFlag(b) && dl.hasDuplicateFlag(c));
});

test('CSV output escapes commas, quotes and newlines', () => {
  const csv = dl.csvStringify(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }, { a: 'line\nbreak', b: null }]);
  assert.equal(csv, 'a,b\n"x,y","say ""hi"""\n"line\nbreak",');
});

test('roster export row round-trips through an upload unchanged', () => {
  const a = emp({ ggid: 'GG1', promotionRecommendation: true, activeBOTP: false, utilization: 77, timeInGrade: 1.5 });
  const exported = dl.rosterRow(a);
  assert.equal(exported.promotionRecommendation, 'Yes');
  assert.equal(exported.priorYearRating, 'Exceeding');
  const plan = dl.planDataLoad([a], dl.normalizeRows([exported]), LABEL);
  const after = plan.updated[0].after;
  assert.equal(after.promotionRecommendation, true);
  assert.equal(after.activeBOTP, false);
  assert.equal(after.utilization, 77);
  // Re-uploading last year's rating shifts history (that's what a prior-year rating column means).
  assert.deepEqual(after.ratingsHistory, ['Succeeding', 'Exceeding', 'Exceeding']);
});
