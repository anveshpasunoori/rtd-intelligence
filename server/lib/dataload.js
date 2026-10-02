// Annual Data Load: the rules for turning an uploaded HRIS extract into employee records.
// Pure functions (no database), so they're unit-testable and shared by preview and commit:
// planDataLoad() decides everything, and commit just writes out the plan, so what the preview
// shows is exactly what a commit does.

const crypto = require('crypto');

const RATINGS = ['Needs Improvement', 'Succeeding', 'Exceeding', 'Exceptional'];
const DUPLICATE_GGID_PREFIX = 'Duplicate GGID';

// 'year' is exported (so a roster export shows each record's cycle year) but ignored on upload:
// every loaded record is stamped with the active cycle's year.
const TEMPLATE_HEADERS = ['ggid', 'year', 'name', 'email', 'region', 'country', 'globalGrade', 'localGrade', 'practice',
  'subPractice', 'supervisor', 'peopleManager', 'priorYearRating', 'performanceTrack', 'promotionReadiness',
  'promotionRecommendation', 'timeInGrade', 'lpdDate', 'mandatoryTrainingStatus', 'learningHoursCompleted',
  'certificationLevel', 'certificationDate', 'promotedPriorYear', 'activeBOTP', 'botpCompleted', 'utilization'];

// Common HRIS header spellings that don't normalize to a template key on their own.
const HEADER_ALIASES = {
  employeename: 'name', fullname: 'name', employeefullname: 'name',
  emailid: 'email', emailaddress: 'email', workemail: 'email',
  employeeid: 'ggid', empid: 'ggid',
  supervisorname: 'supervisor', supervisorfullname: 'supervisor',
  peoplemanager: 'peopleManager', peoplemanagername: 'peopleManager', managername: 'peopleManager',
};

const MAX_ROWS = 50000;

function normalizeHeaderKey(h) { return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function resolveHeader(h) {
  const norm = normalizeHeaderKey(h);
  if (!norm) return '';
  if (HEADER_ALIASES[norm]) return HEADER_ALIASES[norm];
  const hit = TEMPLATE_HEADERS.find((k) => normalizeHeaderKey(k) === norm);
  return hit || String(h || '').trim();
}

// Validates the request body's rows and returns them with resolved header keys and trimmed string
// values. Throws an Error with .status = 400 on malformed input.
function normalizeRows(rows) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!Array.isArray(rows)) throw bad('rows must be an array of objects.');
  if (!rows.length) throw bad('The file has no data rows.');
  if (rows.length > MAX_ROWS) throw bad(`Too many rows (${rows.length}); the limit is ${MAX_ROWS} per upload.`);
  return rows.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(`Row ${i + 2} is not an object.`);
    const out = {};
    Object.keys(r).forEach((k) => {
      const key = resolveHeader(k);
      if (!key) return;
      const v = r[k];
      if (v != null && typeof v === 'object') throw bad(`Row ${i + 2}, column "${k}" must be a plain value.`);
      out[key] = v == null ? '' : String(v).trim();
    });
    return out;
  });
}

function cycleYear(cycleLabel) {
  const m = String(cycleLabel || '').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

function emailKey(v) { return String(v || '').trim().toLowerCase(); }

function uid(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 7).toLowerCase(); }

const yesNo = (v) => /^y/i.test(v || '');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function issuesForCreate(r) {
  const issues = [];
  if (!r.ggid) issues.push('Missing GGID from source upload — could not be matched to an existing employee, and a future upload with the correct GGID will create a separate case rather than updating this one until it\'s corrected');
  if (!r.name) issues.push('Missing Name');
  if (!r.region) issues.push('Missing Region');
  if (!r.globalGrade) issues.push('Missing Global Grade');
  if (!r.practice) issues.push('Missing Practice');
  if (!r.priorYearRating || RATINGS.indexOf(r.priorYearRating) < 0) issues.push('Missing/invalid Prior Year Rating — defaulted to "Succeeding"');
  return issues;
}

function issuesForUpdate(r, existing) {
  const issues = [];
  if (!(r.name || existing.name)) issues.push('Missing Name');
  if (!(r.region || existing.region)) issues.push('Missing Region');
  if (!(r.globalGrade || existing.globalGrade)) issues.push('Missing Global Grade');
  if (!(r.practice || existing.practice)) issues.push('Missing Practice');
  return issues;
}

// Builds GGID / email lookups over the current roster. A key shared by more than one record is
// ambiguous and left out, so a row for it falls through to the next match rule (or becomes a new
// case) rather than overwriting an arbitrary one of the duplicates.
function buildIndexes(employees) {
  const ggidCounts = {}, emailCounts = {};
  employees.forEach((e) => {
    if (e.ggid) ggidCounts[e.ggid] = (ggidCounts[e.ggid] || 0) + 1;
    const ek = emailKey(e.email);
    if (ek) emailCounts[ek] = (emailCounts[ek] || 0) + 1;
  });
  const byGgid = {}, byEmail = {};
  employees.forEach((e) => {
    if (e.ggid && ggidCounts[e.ggid] === 1) byGgid[e.ggid] = e;
    const ek = emailKey(e.email);
    if (ek && emailCounts[ek] === 1) byEmail[ek] = e;
  });
  return { byGgid, byEmail };
}

function matchRow(r, idx) {
  if (r.ggid && idx.byGgid[r.ggid]) return idx.byGgid[r.ggid];
  const ek = emailKey(r.email);
  if (ek && idx.byEmail[ek]) return idx.byEmail[ek];
  return null;
}

function register(e, idx) {
  if (e.ggid) idx.byGgid[e.ggid] = e;
  const ek = emailKey(e.email);
  if (ek) idx.byEmail[ek] = e;
}

// Applies an uploaded row onto an existing record in place. Blank cells leave the field unchanged.
function applyUpdate(e, r, year) {
  const issues = issuesForUpdate(r, e);
  const copy = ['name', 'email', 'region', 'country', 'globalGrade', 'localGrade', 'practice', 'subPractice', 'supervisor',
    'peopleManager', 'performanceTrack', 'promotionReadiness', 'lpdDate', 'mandatoryTrainingStatus', 'certificationLevel', 'certificationDate'];
  copy.forEach((k) => { if (r[k]) e[k] = r[k]; });
  if (r.priorYearRating && RATINGS.indexOf(r.priorYearRating) >= 0) {
    e.ratingsHistory = (e.ratingsHistory || []).slice(1).concat([r.priorYearRating]);
  }
  if (r.promotionRecommendation) e.promotionRecommendation = yesNo(r.promotionRecommendation);
  ['timeInGrade', 'learningHoursCompleted', 'utilization'].forEach((k) => {
    if (r[k] && num(r[k]) != null) e[k] = num(r[k]);
  });
  ['promotedPriorYear', 'activeBOTP', 'botpCompleted'].forEach((k) => { if (r[k]) e[k] = yesNo(r[k]); });
  e.dataQualityIssues = issues;
  e.year = year;
  return issues;
}

function buildNew(r, year) {
  const issues = issuesForCreate(r);
  const name = r.name || '';
  const rating = (r.priorYearRating && RATINGS.indexOf(r.priorYearRating) >= 0) ? r.priorYearRating : 'Succeeding';
  const e = {
    id: uid('EMP'), ggid: r.ggid || '', name: r.name || r.ggid || 'Unnamed (missing data)',
    firstName: name.split(' ')[0] || '', lastName: name.split(' ').slice(1).join(' '),
    email: r.email || '', regionType: 'Region', region: r.region || '', country: r.country || '',
    globalGrade: r.globalGrade || 'C1', localGrade: r.localGrade || '',
    practice: r.practice || '', subPractice: r.subPractice || '', supervisor: r.supervisor || '', peopleManager: r.peopleManager || '',
    isPeopleManager: false,
    ratingsHistory: [rating, 'Succeeding', 'Succeeding'].slice(-3),
    performanceTrack: r.performanceTrack || 'Consulting Track',
    promotionEligibilityOverride: null, promotionReadiness: r.promotionReadiness || 'Not Ready',
    promotionRecommendation: yesNo(r.promotionRecommendation),
    timeInGrade: num(r.timeInGrade) || 0, lpdDate: r.lpdDate || '', awards: [],
    mandatoryTrainingStatus: r.mandatoryTrainingStatus || 'Not Started',
    learningHoursCompleted: num(r.learningHoursCompleted) || 0, industryCertifications: [],
    certificationLevel: r.certificationLevel || 'None', certificationDate: r.certificationDate || null,
    promotedPriorYear: yesNo(r.promotedPriorYear), activeBOTP: yesNo(r.activeBOTP), botpCompleted: yesNo(r.botpCompleted),
    botpExceptionApproved: false, primaryAccountOverride: null, utilization: num(r.utilization) || 70,
    businessImpactNotes: '', ratingOverride: null, ratingOverrideNote: null, dataQualityIssues: issues, changeHistory: [],
    year,
  };
  return { employee: e, issues };
}

// Decides what an upload does, without touching the database. `employees` is the current roster
// (it is not mutated). Returns per-row outcomes plus the records to create and update.
function planDataLoad(employees, rows, cycleLabel) {
  const year = cycleYear(cycleLabel);
  const original = new Map(employees.map((e) => [e.id, e]));
  const working = new Map(employees.map((e) => [e.id, JSON.parse(JSON.stringify(e))]));
  const idx = buildIndexes([...working.values()]);
  const before = new Map(); // employeeId -> record as it was before this upload (first touch only)
  const created = new Map();
  const outcomes = rows.map((r, i) => {
    const existing = matchRow(r, idx);
    if (existing) {
      if (!created.has(existing.id) && !before.has(existing.id)) {
        before.set(existing.id, original.get(existing.id));
      }
      const issues = applyUpdate(existing, r, year);
      register(existing, idx);
      return { row: i + 2, action: 'update', employeeId: existing.id, ggid: r.ggid || existing.ggid, name: r.name || existing.name, issues };
    }
    const { employee, issues } = buildNew(r, year);
    working.set(employee.id, employee);
    created.set(employee.id, employee);
    register(employee, idx);
    return { row: i + 2, action: 'create', employeeId: employee.id, ggid: r.ggid || '', name: r.name || '', issues };
  });
  const updatedIds = [...before.keys()];
  return {
    year,
    outcomes,
    // Final state of each new record (a later row in the same file may have updated it).
    created: [...created.values()],
    updated: updatedIds.map((id) => ({ before: before.get(id), after: working.get(id) })),
    summary: {
      total: rows.length,
      creates: outcomes.filter((o) => o.action === 'create').length,
      updates: outcomes.filter((o) => o.action === 'update').length,
      flagged: outcomes.filter((o) => o.issues.length).length,
    },
  };
}

// Recomputes "Duplicate GGID" flags across the whole roster: two live records with the same GGID
// in the same year are both flagged. Returns the ids whose issue list changed (records are
// updated in place).
function recomputeDuplicateFlags(employees) {
  const groups = {};
  employees.forEach((e) => {
    if (!e.ggid) return;
    const key = e.year + '::' + e.ggid;
    (groups[key] = groups[key] || []).push(e);
  });
  const changed = [];
  employees.forEach((e) => {
    const prev = JSON.stringify(e.dataQualityIssues || []);
    e.dataQualityIssues = (e.dataQualityIssues || []).filter((i) => i.indexOf(DUPLICATE_GGID_PREFIX) !== 0);
    const members = e.ggid ? groups[e.year + '::' + e.ggid] : null;
    if (members && members.length > 1) {
      e.dataQualityIssues.push(`${DUPLICATE_GGID_PREFIX} ${e.ggid} — ${members.length} records share this GGID in ${e.year}.`);
    }
    if (JSON.stringify(e.dataQualityIssues) !== prev) changed.push(e.id);
  });
  return changed;
}

function hasDuplicateFlag(e) {
  return (e.dataQualityIssues || []).some((i) => i.indexOf(DUPLICATE_GGID_PREFIX) === 0);
}

function csvCell(v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csvStringify(headers, rows) {
  return headers.join(',') + '\n' + rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')).join('\n');
}

function rosterRow(e) {
  const yn = (b) => (b ? 'Yes' : 'No');
  const hist = e.ratingsHistory || [];
  return {
    ggid: e.ggid, year: e.year, name: e.name, email: e.email, region: e.region, country: e.country,
    globalGrade: e.globalGrade, localGrade: e.localGrade, practice: e.practice, subPractice: e.subPractice,
    supervisor: e.supervisor || '', peopleManager: e.peopleManager || '', priorYearRating: hist[hist.length - 1],
    performanceTrack: e.performanceTrack, promotionReadiness: e.promotionReadiness,
    promotionRecommendation: yn(e.promotionRecommendation), timeInGrade: e.timeInGrade, lpdDate: e.lpdDate,
    mandatoryTrainingStatus: e.mandatoryTrainingStatus, learningHoursCompleted: e.learningHoursCompleted,
    certificationLevel: e.certificationLevel || 'None', certificationDate: e.certificationDate || '',
    promotedPriorYear: yn(e.promotedPriorYear), activeBOTP: yn(e.activeBOTP), botpCompleted: yn(e.botpCompleted),
    utilization: e.utilization,
  };
}

module.exports = {
  RATINGS, TEMPLATE_HEADERS, DUPLICATE_GGID_PREFIX, MAX_ROWS,
  resolveHeader, normalizeRows, cycleYear, emailKey, uid,
  issuesForCreate, issuesForUpdate, planDataLoad, recomputeDuplicateFlags, hasDuplicateFlag,
  csvStringify, rosterRow,
};
