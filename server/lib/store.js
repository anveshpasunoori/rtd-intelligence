// Database access for the shared workspace: reading the whole app state, writing changed records,
// seeding, and the audit log. Every write function takes a client that is already inside a
// transaction (see withTx).

const fs = require('fs');
const path = require('path');
const { emailKey, cycleYear } = require('./dataload');
const { applySettingsDefaults } = require('./engine');

// App-state keys stored in their own tables. Everything else in the app state (meta, rules,
// adminConfig, ...) is workspace settings, stored as one JSON document in workspace.data.
const RECORD_COLLECTIONS = {
  employees: { table: 'employees' },
  accounts: { table: 'accounts', linked: true },
  contributions: { table: 'contributions', linked: true },
  managerRecords: { table: 'manager_records', linked: true },
  workflow: { table: 'workflow' },
};
const TABLE_KEYS = ['employees', 'accounts', 'contributions', 'managerRecords', 'workflow', 'auditLog', 'archives', 'uploadBatches'];

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function workspaceSettings(state) {
  const out = {};
  Object.keys(state).forEach((k) => { if (TABLE_KEYS.indexOf(k) < 0) out[k] = state[k]; });
  return out;
}

async function getWorkspace(client, { forUpdate = false } = {}) {
  const r = await client.query(`select data, version, updated_at from workspace where id = 1${forUpdate ? ' for update' : ''}`);
  return r.rows[0] || null;
}

// Marks the workspace as changed (feeds meta.lastUpdated). Pass `data` to also replace the
// settings document, which bumps the version so concurrent editors get a 409.
async function touchWorkspace(client, by, data) {
  if (data) {
    const r = await client.query('update workspace set data = $1, version = version + 1, updated_at = now(), updated_by = $2 where id = 1 returning version', [data, by]);
    return r.rows[0].version;
  }
  const r = await client.query('update workspace set updated_at = now(), updated_by = $1 where id = 1 returning version', [by]);
  return r.rows[0].version;
}

async function upsertRecords(client, key, records) {
  if (!records.length) return;
  const spec = RECORD_COLLECTIONS[key];
  if (key === 'employees') {
    await client.query(
      `insert into employees (id, ggid, email_key, year, data)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::jsonb[])
       on conflict (id) do update set ggid = excluded.ggid, email_key = excluded.email_key, year = excluded.year,
         data = excluded.data, updated_at = now()`,
      [records.map((e) => e.id), records.map((e) => e.ggid || null), records.map((e) => emailKey(e.email) || null),
        records.map((e) => (Number.isInteger(e.year) ? e.year : null)), records.map((e) => JSON.stringify(e))]
    );
  } else if (key === 'workflow') {
    await client.query(
      `insert into workflow (employee_id, data) select * from unnest($1::text[], $2::jsonb[])
       on conflict (employee_id) do update set data = excluded.data, updated_at = now()`,
      [records.map((w) => w.employeeId), records.map((w) => JSON.stringify(w))]
    );
  } else {
    await client.query(
      `insert into ${spec.table} (id, employee_id, data) select * from unnest($1::text[], $2::text[], $3::jsonb[])
       on conflict (id) do update set employee_id = excluded.employee_id, data = excluded.data, updated_at = now()`,
      [records.map((x) => x.id), records.map((x) => x.employeeId || ''), records.map((x) => JSON.stringify(x))]
    );
  }
}

async function deleteRecords(client, key, ids) {
  if (!ids.length) return;
  const col = key === 'workflow' ? 'employee_id' : 'id';
  await client.query(`delete from ${RECORD_COLLECTIONS[key].table} where ${col} = any($1::text[])`, [ids]);
}

// Deletes employees together with everything linked to them.
async function deleteEmployeesCascade(client, ids) {
  if (!ids.length) return;
  for (const t of ['accounts', 'contributions', 'manager_records']) {
    await client.query(`delete from ${t} where employee_id = any($1::text[])`, [ids]);
  }
  await client.query('delete from workflow where employee_id = any($1::text[])', [ids]);
  await client.query('delete from employees where id = any($1::text[])', [ids]);
}

async function loadEmployees(client) {
  const r = await client.query('select data from employees order by seq');
  return r.rows.map((x) => x.data);
}

function auditRowToEntry(r) {
  return {
    id: r.id, timestamp: r.ts.toISOString(), user: r.user_name, employeeId: r.employee_id, employeeName: r.employee_name,
    entity: r.entity, field: r.field, oldValue: r.old_value, newValue: r.new_value, action: r.action,
  };
}

async function appendAudit(client, entries, userId) {
  if (!entries.length) return;
  await client.query(
    `insert into audit_log (id, ts, user_name, user_id, employee_id, employee_name, entity, field, old_value, new_value, action)
     select * from unnest($1::text[], $2::timestamptz[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::jsonb[], $11::text[])
     on conflict (id) do nothing`,
    [
      entries.map((a) => String(a.id)),
      entries.map((a) => (a.timestamp && !isNaN(Date.parse(a.timestamp)) ? a.timestamp : new Date().toISOString())),
      entries.map((a) => (a.user == null ? null : String(a.user))),
      entries.map(() => userId || null),
      entries.map((a) => (a.employeeId == null ? null : String(a.employeeId))),
      entries.map((a) => (a.employeeName == null ? null : String(a.employeeName))),
      entries.map((a) => (a.entity == null ? null : String(a.entity))),
      entries.map((a) => (a.field == null ? null : String(a.field))),
      entries.map((a) => JSON.stringify(a.oldValue === undefined ? null : a.oldValue)),
      entries.map((a) => JSON.stringify(a.newValue === undefined ? null : a.newValue)),
      entries.map((a) => (a.action == null ? null : String(a.action))),
    ]
  );
}

function batchRowToEntry(b) {
  return {
    id: b.id, fileName: b.file_name, cycleLabel: b.cycle_label, uploadedAt: b.uploaded_at.toISOString(), uploadedBy: b.uploaded_by,
    rowCount: b.row_count, createdCount: b.created_count, updatedCount: b.updated_count,
    flaggedCount: b.flagged_count, duplicateCount: b.duplicate_count,
  };
}

async function listBatches(client) {
  const r = await client.query('select * from upload_batches order by uploaded_at desc');
  return r.rows.map(batchRowToEntry);
}

// The complete app state in the shape the browser app keeps in memory. Archives carry only the
// case summaries the app displays; the full snapshot is at GET /api/archives/:id.
async function loadState(client) {
  const ws = await getWorkspace(client);
  if (!ws) return null;
  const q = (sql) => client.query(sql).then((r) => r.rows);
  const [employees, accounts, contributions, managerRecords, workflowRows, auditRows, archiveRows, batches] = await Promise.all([
    q('select data from employees order by seq'),
    q('select data from accounts order by seq'),
    q('select data from contributions order by seq'),
    q('select data from manager_records order by seq'),
    q('select employee_id, data from workflow order by seq'),
    q('select * from audit_log order by ts desc, seq desc'),
    q(`select id, cycle_label, archived_at, archived_by, employee_count, jsonb_build_object('cases', snapshot->'cases') as snapshot
       from archives order by archived_at desc`),
    listBatches(client),
  ]);
  const workflow = {};
  workflowRows.forEach((w) => { workflow[w.employee_id] = w.data; });
  const data = Object.assign({}, ws.data);
  data.meta = Object.assign({}, data.meta, { lastUpdated: ws.updated_at.toISOString().slice(0, 10) });
  Object.assign(data, {
    employees: employees.map((x) => x.data),
    accounts: accounts.map((x) => x.data),
    contributions: contributions.map((x) => x.data),
    managerRecords: managerRecords.map((x) => x.data),
    workflow,
    auditLog: auditRows.map(auditRowToEntry),
    archives: archiveRows.map((a) => ({
      id: a.id, cycleLabel: a.cycle_label, archivedAt: a.archived_at.toISOString(), archivedBy: a.archived_by,
      employeeCount: a.employee_count, snapshot: a.snapshot,
    })),
    uploadBatches: batches,
  });
  return { version: ws.version, data };
}

// Writes a complete app state into empty tables (first start, and in tests).
async function writeFullState(client, state, by) {
  await client.query(
    `insert into workspace (id, data, version, updated_by) values (1, $1, 1, $2)
     on conflict (id) do update set data = excluded.data, version = workspace.version + 1, updated_at = now(), updated_by = excluded.updated_by`,
    [workspaceSettings(state), by]
  );
  await upsertRecords(client, 'employees', state.employees || []);
  await upsertRecords(client, 'accounts', state.accounts || []);
  await upsertRecords(client, 'contributions', state.contributions || []);
  await upsertRecords(client, 'managerRecords', state.managerRecords || []);
  await upsertRecords(client, 'workflow', Object.values(state.workflow || {}));
  await appendAudit(client, state.auditLog || [], null);
}

const DEFAULT_CYCLE_LABEL = 'FY2026 RTD Cycle';

// The demo data predates cycle labels and per-record years; fill both in (the same defaults the
// app applies) so every stored record has them.
function readSeed() {
  const seed = applySettingsDefaults(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.json'), 'utf8')));
  seed.meta = Object.assign({}, seed.meta);
  if (!seed.meta.cycleLabel) seed.meta.cycleLabel = DEFAULT_CYCLE_LABEL;
  const year = cycleYear(seed.meta.cycleLabel);
  (seed.employees || []).forEach((e) => { if (e.year == null) e.year = year; });
  return seed;
}

// On a brand-new database, creates the workspace. With SEED_DEMO_DATA=false it starts empty;
// otherwise it loads the demo roster from db/seed.json (clear it later from Annual Data Load →
// Danger zone).
async function ensureWorkspace(pool) {
  await withTx(pool, async (client) => {
    await client.query('lock table workspace in exclusive mode');
    const existing = await getWorkspace(client);
    if (existing) {
      // Older workspaces may lack settings the app used to fill in in the browser.
      const before = JSON.stringify(existing.data);
      const data = applySettingsDefaults(JSON.parse(before));
      if (JSON.stringify(data) !== before) await touchWorkspace(client, 'system', data);
      return;
    }
    const seed = readSeed();
    if (process.env.SEED_DEMO_DATA === 'false') {
      const empty = Object.assign({}, seed, {
        employees: [], accounts: [], contributions: [], managerRecords: [], workflow: {}, auditLog: [], archives: [], uploadBatches: [],
      });
      await writeFullState(client, empty, 'system');
    } else {
      await writeFullState(client, seed, 'system');
    }
    console.log('Workspace created' + (process.env.SEED_DEMO_DATA === 'false' ? ' (empty).' : ' with demo data from db/seed.json.'));
  });
}

module.exports = {
  RECORD_COLLECTIONS, TABLE_KEYS,
  withTx, workspaceSettings, getWorkspace, touchWorkspace, upsertRecords, deleteRecords, deleteEmployeesCascade,
  loadEmployees, appendAudit, auditRowToEntry, listBatches, loadState, writeFullState, readSeed, ensureWorkspace,
};
