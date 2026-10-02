// End-to-end API tests: real server + real Postgres (TEST_DATABASE_URL), demo workspace seeded.

const test = require('node:test');
const { assert, pool, startServer, stopServer, resetDatabase, Client, newUser, dbState, row } = require('./helpers');

let admin, reviewer;

test.before(async () => {
  await startServer();
});
test.after(stopServer);
test.beforeEach(async () => {
  await resetDatabase();
  admin = await newUser('HR Admin');
  reviewer = await newUser();
});

const count = async (table) => (await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n;

// ------------------------------------------------------------------ auth ----

test('auth: register, me, wrong password, logout', async () => {
  const c = new Client();
  let r = await c.post('/api/auth/register', { email: 'New.Person@Example.test', password: 'short' });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { email: 'not-an-email', password: 'password-123' });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { email: 'New.Person@Example.test', password: 'password-123' });
  assert.equal(r.status, 201);
  assert.equal(r.body.role, 'RTD Reviewer');
  r = await c.post('/api/auth/register', { email: 'new.person@example.test', password: 'password-123' });
  assert.equal(r.status, 409, 'emails are case-insensitive');
  r = await c.get('/api/auth/me');
  assert.deepEqual(r.body, { email: 'new.person@example.test', role: 'RTD Reviewer' });

  const other = new Client();
  r = await other.post('/api/auth/login', { email: 'new.person@example.test', password: 'wrong-password' });
  assert.equal(r.status, 401);
  r = await other.post('/api/auth/login', { email: 'nobody@example.test', password: 'password-123' });
  assert.equal(r.status, 401);
  r = await other.post('/api/auth/login', { email: 'NEW.PERSON@example.test', password: 'password-123' });
  assert.equal(r.status, 200);

  await c.post('/api/auth/logout');
  r = await c.get('/api/auth/me');
  assert.equal(r.status, 401);
});

test('auth: role changes and deleted accounts take effect on the next request', async () => {
  let r = await reviewer.get('/api/data-load/batches');
  assert.equal(r.status, 403);
  await pool.query("update users set role = 'HR Admin' where email = $1", [reviewer.email]);
  r = await reviewer.get('/api/data-load/batches');
  assert.equal(r.status, 200);
  await pool.query('delete from users where email = $1', [reviewer.email]);
  r = await reviewer.get('/api/workspace');
  assert.equal(r.status, 401);
});

test('auth: a tampered session cookie is rejected', async () => {
  const c = new Client();
  c.cookie = admin.cookie.slice(0, -3) + 'abc';
  assert.equal((await c.get('/api/workspace')).status, 401);
  assert.equal((await new Client().get('/api/workspace')).status, 401);
});

// -------------------------------------------------------------- workspace ----

test('seed: a new database holds the demo workspace', async () => {
  const b = await dbState();
  assert.equal(typeof b.version, 'number');
  const s = b.data;
  assert.equal(s.employees.length, 300);
  assert.equal(Object.keys(s.workflow).length, 300);
  assert.equal(s.accounts.length, 259);
  assert.equal(s.contributions.length, 165);
  assert.equal(s.managerRecords.length, 149);
  assert.equal(s.rules.length, 27);
  assert.ok(s.adminConfig && s.stepNames.length);
  assert.equal(s.meta.cycleLabel, 'FY2026 RTD Cycle', 'seed gets the default cycle label');
  assert.ok(s.employees.every((e) => e.year === 2026), 'every seeded record has a year');
  assert.match(s.meta.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(s.archives, []);
  assert.deepEqual(s.uploadBatches, []);
  assert.equal(s.auditLog.length, 1);
  // Order is preserved from the seed.
  const seed = require('../db/seed.json');
  assert.deepEqual(s.employees.map((e) => e.id), seed.employees.map((e) => e.id));
});

test('sync: record upserts, cascaded removals and audit entries (HR Admin)', async () => {
  const s = (await dbState()).data;
  const e = s.employees[0];
  e.ratingOverride = 'Exceptional';
  const victim = s.employees[1];
  const audit = { id: 'AUD-test1', timestamp: new Date().toISOString(), user: 'Tester', employeeId: e.id, employeeName: e.name, entity: 'Rating', field: 'override', oldValue: null, newValue: 'Exceptional', action: 'Override' };
  const r = await admin.post('/api/sync', { upsert: { employees: [e] }, remove: { employees: [victim.id] }, audit: [audit] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const after = (await dbState()).data;
  assert.equal(after.employees.find((x) => x.id === e.id).ratingOverride, 'Exceptional');
  assert.ok(!after.employees.some((x) => x.id === victim.id));
  assert.ok(!after.workflow[victim.id], 'workflow removed with the employee');
  assert.ok(!after.accounts.some((a) => a.employeeId === victim.id));
  assert.ok(!after.contributions.some((a) => a.employeeId === victim.id));
  assert.ok(!after.managerRecords.some((a) => a.employeeId === victim.id));
  assert.equal(after.auditLog[0].id, 'AUD-test1');
  assert.equal(after.auditLog[0].newValue, 'Exceptional');
  // The order of the edited employee doesn't change.
  assert.equal(after.employees[0].id, e.id);

  // Re-sending the same audit entry doesn't duplicate it.
  await admin.post('/api/sync', { audit: [audit] });
  assert.equal((await dbState()).data.auditLog.filter((a) => a.id === 'AUD-test1').length, 1);
});

test('sync: workflow, accounts, contributions and manager records', async () => {
  const s = (await dbState()).data;
  const id = s.employees[5].id;
  const wf = Object.assign({}, s.workflow[id], { currentStep: 4, status: 'In Progress' });
  const acc = { id: 'ACC-new1', employeeId: id, accountName: 'Test Account' };
  const con = Object.assign({}, s.contributions[0], { hoursInvested: 999 });
  const mr = s.managerRecords[0];
  let r = await admin.post('/api/sync', { upsert: { workflow: [wf], accounts: [acc], contributions: [con] }, remove: { managerRecords: [mr.id] } });
  assert.equal(r.status, 200);
  const after = (await dbState()).data;
  assert.equal(after.workflow[id].currentStep, 4);
  assert.equal(after.accounts.at(-1).accountName, 'Test Account');
  assert.equal(after.contributions.find((x) => x.id === con.id).hoursInvested, 999);
  assert.ok(!after.managerRecords.some((x) => x.id === mr.id));
});

test('sync: settings need HR Admin and the current version', async () => {
  const b = await dbState();
  const settings = { meta: b.data.meta, rules: b.data.rules, adminConfig: b.data.adminConfig, stepNames: b.data.stepNames, ldHoursConfig: b.data.ldHoursConfig, managerConfig: b.data.managerConfig, tigConfig: b.data.tigConfig };
  settings.rules = settings.rules.map((x, i) => (i === 0 ? Object.assign({}, x, { enabled: !x.enabled }) : x));

  let r = await reviewer.post('/api/sync', { settings, baseVersion: b.version });
  assert.equal(r.status, 403);

  r = await admin.post('/api/sync', { settings, baseVersion: b.version - 1 });
  assert.equal(r.status, 409);
  assert.equal(r.body.version, b.version);

  r = await admin.post('/api/sync', { settings, baseVersion: b.version });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, b.version + 1);
  const after = await dbState();
  assert.equal(after.version, b.version + 1);
  assert.equal(after.data.rules[0].enabled, !b.data.rules[0].enabled);

  // Second editor still holding the old version is rejected; nothing in that request is applied.
  const e = Object.assign({}, b.data.employees[0], { name: 'Should Not Save' });
  r = await admin.post('/api/sync', { settings, baseVersion: b.version, upsert: { employees: [e] } });
  assert.equal(r.status, 409);
  assert.notEqual((await dbState()).data.employees[0].name, 'Should Not Save');
});

test('sync: settings never store table data or lastUpdated', async () => {
  const b = await dbState();
  const settings = Object.assign({}, b.data, { meta: Object.assign({}, b.data.meta, { lastUpdated: '1999-01-01' }) });
  const r = await admin.post('/api/sync', { settings, baseVersion: b.version });
  assert.equal(r.status, 200);
  const ws = (await pool.query('select data from workspace')).rows[0].data;
  assert.equal(ws.employees, undefined);
  assert.equal(ws.auditLog, undefined);
  assert.notEqual((await dbState()).data.meta.lastUpdated, '1999-01-01');
});

test('sync: malformed payloads are rejected with 400', async () => {
  for (const body of [
    { upsert: { employees: 'x' } },
    { upsert: { employees: [{ name: 'no id' }] } },
    { upsert: { workflow: [{ currentStep: 1 }] } },
    { remove: { employees: [1, 2] } },
  ]) {
    const r = await admin.post('/api/sync', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const r = await admin.req('POST', '/api/sync', '{not json');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Malformed JSON request body.');
});

// -------------------------------------------------------- annual data load ----

test('data load: every endpoint needs HR Admin', async () => {
  const calls = [
    ['GET', '/api/data-load/template'], ['GET', '/api/data-load/export'], ['GET', '/api/data-load/batches'],
    ['POST', '/api/data-load/preview', { rows: [row({ ggid: 'X' })] }], ['POST', '/api/data-load/commit', { rows: [row({ ggid: 'X' })] }],
    ['DELETE', '/api/data-load/batches/BATCH-x'], ['POST', '/api/data-load/remove-all'],
    ['POST', '/api/data-load/factory-reset', { confirm: 'DELETE EVERYTHING' }], ['POST', '/api/cycles/archive', { nextLabel: 'FY2027', cases: [] }],
  ];
  for (const [m, p, b] of calls) {
    const r = await reviewer.req(m, p, m === 'GET' ? undefined : (b || {}));
    assert.equal(r.status, 403, `${m} ${p}`);
    const anon = await new Client().req(m, p, m === 'GET' ? undefined : (b || {}));
    assert.equal(anon.status, 401, `${m} ${p} anonymous`);
  }
  assert.equal(await count('employees'), 300, 'nothing changed');
});

test('data load: template and roster export CSVs', async () => {
  let r = await admin.get('/api/data-load/template', { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /rtd_annual_data_template\.csv/);
  assert.equal(r.text.trim(), require('../lib/dataload').TEMPLATE_HEADERS.join(','));

  r = await admin.get('/api/data-load/export', { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /rtd_current_roster_FY2026_RTD_Cycle\.csv/);
  const lines = r.text.split('\n');
  assert.equal(lines.length, 301);
  assert.ok(lines[1].startsWith('GG200001,2026,Nadia Kowalski,'));
});

test('data load: preview reports what a commit would do, without saving anything', async () => {
  const s = (await dbState()).data;
  const existing = s.employees[0];
  const rows = [
    { GGID: existing.ggid, 'Employee Name': existing.name + ' Jr', 'Prior Year Rating': 'Exceptional' },
    row({ ggid: 'GGNEW1', name: 'Pat New', email: 'pat.new@example.test' }),
    { name: 'No Identifiers' },
  ];
  const r = await admin.post('/api/data-load/preview', { rows });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.year, 2026);
  assert.deepEqual(r.body.summary, { total: 3, creates: 2, updates: 1, flagged: 1 });
  assert.equal(r.body.rows[0].action, 'update');
  assert.equal(r.body.rows[0].employeeId, existing.id);
  assert.equal(r.body.rows[2].issues.length, 5);
  assert.equal(await count('employees'), 300);
  assert.equal(await count('upload_batches'), 0);
});

test('data load: preview/commit validation errors', async () => {
  for (const [body, msg] of [
    [{}, /array/], [{ rows: [] }, /no data rows/], [{ rows: [[1, 2]] }, /not an object/], [{ rows: [{ a: [1] }] }, /plain value/],
  ]) {
    for (const p of ['/api/data-load/preview', '/api/data-load/commit']) {
      const r = await admin.post(p, body);
      assert.equal(r.status, 400);
      assert.match(r.body.error, msg);
    }
  }
  assert.equal(await count('upload_batches'), 0);
});

test('data load: commit creates and updates records, workflow, batch and audit', async () => {
  const s = (await dbState()).data;
  const byGgid = s.employees[0];
  const byEmail = s.employees[1];
  const rows = [
    { ggid: byGgid.ggid, name: 'Renamed Person', priorYearRating: 'Exceptional', utilization: '95' },
    { ggid: '', email: byEmail.email.toUpperCase(), region: 'Canada' },
    row({ ggid: 'GGNEW1', name: 'Pat New', email: 'pat.new@example.test', priorYearRating: 'Succeeding' }),
    row({ ggid: 'GGNEW1', name: 'Pat Newer' }),
    { name: 'Missing Lots' },
  ];
  const r = await admin.post('/api/data-load/commit', { fileName: 'roster 2026.csv', rows, actorName: 'A. Tester' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.summary, { rows: 5, updated: 3, created: 2, flagged: 1, duplicates: 0 });
  assert.match(r.body.message, /Loaded 3 updates and 2 new cases — 1 flagged for missing data \(see RTD Review\)/);

  const after = (await dbState()).data;
  assert.equal(after.employees.length, 302);
  const g = after.employees.find((e) => e.id === byGgid.id);
  assert.equal(g.name, 'Renamed Person');
  assert.equal(g.utilization, 95);
  assert.deepEqual(g.ratingsHistory, byGgid.ratingsHistory.slice(1).concat(['Exceptional']));
  assert.equal(g.year, 2026);
  assert.equal(after.employees.find((e) => e.id === byEmail.id).region, 'Canada');

  const pat = after.employees.filter((e) => e.ggid === 'GGNEW1');
  assert.equal(pat.length, 1, 'second row in the same file updated the first instead of duplicating it');
  assert.equal(pat[0].name, 'Pat Newer');
  assert.equal(after.employees.at(-2).id, pat[0].id, 'new records are appended in file order');
  const wf = after.workflow[pat[0].id];
  assert.equal(wf.currentStep, 1);
  assert.equal(wf.history[0].stepName, s.stepNames[0]);
  assert.equal(wf.history[0].notes, 'Loaded via annual data upload');

  const missing = after.employees.at(-1);
  assert.equal(missing.name, 'Missing Lots');
  assert.ok(missing.dataQualityIssues.some((i) => i.startsWith('Missing GGID')));

  assert.equal(after.uploadBatches.length, 1);
  const b = after.uploadBatches[0];
  assert.equal(b.fileName, 'roster 2026.csv');
  assert.equal(b.uploadedBy, 'A. Tester');
  assert.equal(b.cycleLabel, s.meta.cycleLabel);
  assert.deepEqual([b.rowCount, b.createdCount, b.updatedCount, b.flaggedCount, b.duplicateCount], [5, 2, 2, 1, 0]);

  const a = after.auditLog[0];
  assert.equal(a.action, 'Annual Data Upload');
  assert.equal(a.user, 'A. Tester');
  assert.equal(a.newValue, '3 updated, 2 created, 1 flagged for missing data');
  const auditUser = (await pool.query('select u.email from audit_log a join users u on u.id = a.user_id where a.id = $1', [a.id])).rows[0];
  assert.equal(auditUser.email, admin.email, 'audit row records the real login too');
});

test('data load: duplicate GGIDs in the same year are flagged and counted', async () => {
  const s = (await dbState()).data;
  const twin = Object.assign({}, s.employees[0], { id: 'EMP-twin001', email: 'twin@example.test' });
  await admin.post('/api/sync', { upsert: { employees: [twin] } });
  // GGID is now ambiguous, so this row can't match by GGID; its unknown email makes it a 3rd record.
  const r = await admin.post('/api/data-load/commit', { rows: [row({ ggid: s.employees[0].ggid, name: 'Third', email: 'third@example.test' })] });
  assert.equal(r.status, 201);
  assert.equal(r.body.summary.duplicates, 1);
  assert.match(r.body.message, /1 with a duplicate GGID this year/);
  const dups = (await dbState()).data.employees.filter((e) => e.ggid === s.employees[0].ggid);
  assert.equal(dups.length, 3);
  dups.forEach((e) => assert.ok(e.dataQualityIssues.some((i) => i.startsWith('Duplicate GGID ' + e.ggid + ' — 3 records')), e.id));
});

test('data load: removing a batch restores updated records exactly and deletes created ones', async () => {
  const s = (await dbState()).data;
  const original = s.employees[0];
  let r = await admin.post('/api/data-load/commit', { fileName: 'first.csv', rows: [{ ggid: original.ggid, name: 'Changed' }, row({ ggid: 'GGNEW9', name: 'New Nine' })] });
  const batchId = r.body.batchId;
  const created = (await dbState()).data.employees.find((e) => e.ggid === 'GGNEW9');
  // Something else attached to the new employee is removed with it.
  await admin.post('/api/sync', { upsert: { accounts: [{ id: 'ACC-x1', employeeId: created.id }] } });

  r = await admin.del('/api/data-load/batches/' + batchId, { actorName: 'Undoer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.deleted, r.body.reverted], [1, 1]);
  assert.match(r.body.message, /Removed upload "first.csv" — 1 deleted, 1 reverted/);

  const after = (await dbState()).data;
  assert.deepEqual(after.employees.find((e) => e.id === original.id), original);
  assert.ok(!after.employees.some((e) => e.id === created.id));
  assert.ok(!after.workflow[created.id]);
  assert.ok(!after.accounts.some((a) => a.id === 'ACC-x1'));
  assert.equal(after.uploadBatches.length, 0);
  assert.equal(await count('upload_batch_items'), 0);
  assert.equal(after.auditLog[0].action, 'Upload Removed');

  r = await admin.del('/api/data-load/batches/' + batchId);
  assert.equal(r.status, 404);
});

test('data load: undo does not resurrect employees deleted since the upload', async () => {
  const s = (await dbState()).data;
  const [a, b] = s.employees;
  let r = await admin.post('/api/data-load/commit', { rows: [{ ggid: a.ggid, name: 'A2' }, { ggid: b.ggid, name: 'B2' }, row({ ggid: a.ggid + 'X', email: 'z@example.test', name: 'Zed' })] });
  const batchId = r.body.batchId;
  await admin.post('/api/sync', { remove: { employees: [b.id] } });
  r = await admin.del('/api/data-load/batches/' + batchId);
  assert.deepEqual([r.body.deleted, r.body.reverted], [1, 1]);
  const after = (await dbState()).data;
  assert.equal(after.employees.find((e) => e.id === a.id).name, a.name);
  assert.ok(!after.employees.some((e) => e.id === b.id), 'not resurrected');
});

test('data load: concurrent commits are serialized (no duplicate records)', async () => {
  const rows = [row({ ggid: 'GGRACE', name: 'Racer', email: 'racer@example.test' })];
  const [r1, r2] = await Promise.all([admin.post('/api/data-load/commit', { rows }), admin.post('/api/data-load/commit', { rows })]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.deepEqual([r1.body.summary.created, r2.body.summary.created].sort(), [0, 1]);
  const n = (await pool.query("select count(*)::int as n from employees where ggid = 'GGRACE'")).rows[0].n;
  assert.equal(n, 1);
});

test('data load: a 10,000-row upload commits and is fully readable', async () => {
  const rows = [];
  for (let i = 0; i < 10000; i++) rows.push(row({ ggid: 'BULK' + i, name: 'Bulk Person ' + i, email: `bulk${i}@example.test` }));
  const t = Date.now();
  const r = await admin.post('/api/data-load/commit', { fileName: 'bulk.csv', rows });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.summary.created, 10000);
  assert.ok(Date.now() - t < 30000, 'commits within 30s');
  const b = (await dbState()).data;
  assert.equal(b.employees.length, 10300);
  assert.equal(Object.keys(b.workflow).length, 10300);
});

test('data load: remove all records keeps archives and the audit log', async () => {
  await admin.post('/api/cycles/archive', { nextLabel: 'FY2027 RTD Cycle', cases: [] });
  await admin.post('/api/data-load/commit', { rows: [row({ ggid: 'GGA', name: 'A' })] });
  const r = await admin.post('/api/data-load/remove-all', { actorName: 'Wiper' });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 301);
  const after = (await dbState()).data;
  assert.deepEqual([after.employees.length, after.accounts.length, after.contributions.length, after.managerRecords.length, Object.keys(after.workflow).length, after.uploadBatches.length], [0, 0, 0, 0, 0, 0]);
  assert.equal(after.archives.length, 1);
  assert.equal(after.auditLog[0].action, 'All Records Removed');
  assert.ok(after.auditLog.length > 3);
  assert.ok(after.rules.length > 0, 'settings are kept');
});

test('data load: factory reset needs explicit confirmation and wipes everything', async () => {
  await admin.post('/api/cycles/archive', { nextLabel: 'FY2027 RTD Cycle', cases: [] });
  let r = await admin.post('/api/data-load/factory-reset', {});
  assert.equal(r.status, 400);
  assert.equal(await count('employees'), 300);
  r = await admin.post('/api/data-load/factory-reset', { confirm: 'DELETE EVERYTHING' });
  assert.equal(r.status, 200);
  const after = (await dbState()).data;
  assert.equal(after.employees.length, 0);
  assert.equal(after.archives.length, 0);
  assert.equal(after.auditLog.length, 1);
  assert.equal(after.auditLog[0].action, 'Factory Reset');
});

// --------------------------------------------------------------- archives ----

test('archive: snapshots the cycle, resets workflow and starts the next cycle', async () => {
  const before = await dbState();
  await admin.post('/api/data-load/commit', { rows: [row({ ggid: 'GGARC', name: 'Arc Person' })] });
  const cases = before.data.employees.map((e) => ({ employeeId: e.id, name: e.name, finalRating: 'Succeeding' }));

  let r = await admin.post('/api/cycles/archive', { nextLabel: '', cases });
  assert.equal(r.status, 400);
  r = await admin.post('/api/cycles/archive', { nextLabel: before.data.meta.cycleLabel, cases });
  assert.equal(r.status, 400);

  r = await admin.post('/api/cycles/archive', { nextLabel: 'FY2027 RTD Cycle', cases, actorName: 'Archivist' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.message, /Archived FY2026 RTD Cycle — now in FY2027 RTD Cycle/);

  const after = await dbState();
  assert.equal(after.version, r.body.version);
  assert.equal(after.data.meta.cycleLabel, 'FY2027 RTD Cycle');
  assert.equal(after.data.uploadBatches.length, 0);
  assert.equal(after.data.archives.length, 1);
  const a = after.data.archives[0];
  assert.deepEqual([a.cycleLabel, a.archivedBy, a.employeeCount], ['FY2026 RTD Cycle', 'Archivist', 301]);
  assert.equal(a.snapshot.cases.length, 301, 'the server computes a case for every employee');
  const arcCase = a.snapshot.cases.find((c) => c.ggid === 'GGARC');
  assert.ok(arcCase && arcCase.finalRating && arcCase.eligibilityStatus, 'computed outcome stored with each case');
  Object.values(after.data.workflow).forEach((w) => {
    assert.equal(w.currentStep, 1);
    assert.equal(w.history.length, 1);
    assert.equal(w.history[0].notes, 'New cycle started');
  });
  assert.deepEqual(after.data.auditLog.slice(0, 2).map((x) => x.action), ['New Cycle Started', 'Cycle Archived']);

  assert.equal((await reviewer.get('/api/archives/' + a.id)).status, 403, 'full snapshots are HR Admin only');
  const full = await admin.get('/api/archives/' + a.id);
  assert.equal(full.status, 200);
  assert.equal(full.body.snapshot.employees.length, 301);
  assert.equal(full.body.snapshot.rules.length, 27);
  assert.equal((await admin.get('/api/archives/ARC-nope')).status, 404);

  // The next upload is stamped with the new cycle's year.
  r = await admin.post('/api/data-load/commit', { rows: [{ ggid: before.data.employees[0].ggid }] });
  assert.equal((await dbState()).data.employees[0].year, 2027);
});

test('archive: a stale settings save after an archive is rejected (cycle label is protected)', async () => {
  const b = await dbState();
  await admin.post('/api/cycles/archive', { nextLabel: 'FY2027 RTD Cycle', cases: [] });
  const settings = { meta: b.data.meta, rules: b.data.rules };
  const r = await admin.post('/api/sync', { settings, baseVersion: b.version });
  assert.equal(r.status, 409);
  assert.equal((await dbState()).data.meta.cycleLabel, 'FY2027 RTD Cycle');
});

// ------------------------------------------------------------------ misc ----

test('unknown API routes return JSON 404; the app shell is served for page routes', async () => {
  let r = await admin.get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Not found');
  r = await new Client().get('/some/page', { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>RTD Intelligence<\/title>/);
  assert.ok(!r.text.includes('id="app-state"'), 'demo data is no longer embedded in the page');
});

test('empty workspace when SEED_DEMO_DATA=false', async () => {
  await pool.query('drop schema public cascade; create schema public;');
  process.env.SEED_DEMO_DATA = 'false';
  try {
    const log = console.log; console.log = () => {};
    await require('../server').prepareDatabase();
    console.log = log;
  } finally {
    delete process.env.SEED_DEMO_DATA;
  }
  const c = await newUser();
  const w = (await c.get('/api/workspace')).body;
  assert.equal(w.counts.employees, 0);
  assert.ok(w.settings.rules.length > 0, 'settings still come from the seed');
  assert.equal((await c.get('/api/dashboards/executive')).body.total, 0);
});
