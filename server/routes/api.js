// Workspace, Annual Data Load and archive endpoints. Auth endpoints live in server.js.

const express = require('express');
const dl = require('../lib/dataload');
const store = require('../lib/store');
const { createEngine, applySettingsDefaults } = require('../lib/engine');

const SYNC_KEYS = Object.keys(store.RECORD_COLLECTIONS);

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function actorName(req) {
  const n = req.body && typeof req.body.actorName === 'string' ? req.body.actorName.trim().slice(0, 200) : '';
  return n || req.user.email;
}

function auditEntry(fields) {
  return Object.assign({ id: dl.uid('AUD'), timestamp: new Date().toISOString(), employeeId: null, employeeName: null }, fields);
}

// Wraps an async route so thrown errors become JSON responses (status from err.status, else 500).
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json(Object.assign({ error: err.message }, err.body || {}));
      console.error(req.method, req.path, err);
      res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
    }
  };
}

// Validates /api/sync's record lists: each item must be an object with a string key.
function validateRecords(key, list, label) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw httpError(400, `${label}.${key} must be an array.`);
  const idField = key === 'workflow' ? 'employeeId' : 'id';
  list.forEach((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x[idField] !== 'string' || !x[idField]) {
      throw httpError(400, `Every ${label}.${key} entry needs a string "${idField}".`);
    }
  });
  return list;
}

// Employee fields an RTD Reviewer may change (choosing the primary account, which records itself
// in the employee's change history). Everything else needs HR Admin.
const REVIEWER_EMPLOYEE_FIELDS = ['primaryAccountOverride', 'changeHistory'];

// Merges the patch into the stored record and refreshes the indexed copies of ggid/email/year.
const PATCH_EMPLOYEE_SQL = `
  update employees set data = data || $2::jsonb,
    ggid = nullif((data || $2::jsonb)->>'ggid', ''),
    email_key = nullif(lower(trim((data || $2::jsonb)->>'email')), ''),
    year = case when jsonb_typeof((data || $2::jsonb)->'year') = 'number' then ((data || $2::jsonb)->>'year')::int end,
    updated_at = now()
  where id = $1`;

function validatePatches(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw httpError(400, 'patch.employees must be an array.');
  return list.map((p) => {
    if (!p || typeof p.id !== 'string' || !p.id || !p.set || typeof p.set !== 'object' || Array.isArray(p.set)) {
      throw httpError(400, 'Every patch.employees entry needs a string "id" and a "set" object.');
    }
    if ('id' in p.set) throw httpError(400, 'An employee\'s id cannot be changed.');
    return p;
  });
}

function validateIds(key, list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw httpError(400, `remove.${key} must be an array of ids.`);
  return list;
}

// Re-derives duplicate-GGID flags over the whole roster and saves the records whose flags changed.
async function refreshDuplicateFlags(client) {
  const all = await store.loadEmployees(client);
  const changed = new Set(dl.recomputeDuplicateFlags(all));
  await store.upsertRecords(client, 'employees', all.filter((e) => changed.has(e.id)));
  return all;
}

async function lockedWorkspace(client) {
  const ws = await store.getWorkspace(client, { forUpdate: true });
  if (!ws) throw httpError(503, 'Workspace is not initialized yet.');
  return ws;
}

function csvResponse(res, filename, text) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(text);
}

// Mounted behind requireAuth (see server.js).
module.exports = function apiRoutes({ pool, requireAdmin }) {
  const router = express.Router();

  // ------------------------------------------------------------ workspace ----

  // Saves changes made in the app:
  //   patch.employees: [{id, set: {field: value}}] — changes only the given fields of a record
  //   upsert / remove: whole records per collection (HR Admin)
  //   audit: new audit entries
  //   settings + baseVersion: the workspace settings document (HR Admin; 409 if stale)
  // An RTD Reviewer may only change the fields in REVIEWER_EMPLOYEE_FIELDS.
  router.post('/sync', handle(async (req, res) => {
    const body = req.body || {};
    const isAdmin = req.user.role === 'HR Admin';
    const upsert = body.upsert || {};
    const remove = body.remove || {};
    const ups = {}, rems = {};
    SYNC_KEYS.forEach((k) => {
      ups[k] = validateRecords(k, upsert[k], 'upsert');
      rems[k] = validateIds(k, remove[k]);
    });
    const patches = validatePatches(body.patch && body.patch.employees);
    const audit = Array.isArray(body.audit) ? body.audit.filter((a) => a && typeof a === 'object' && a.id) : [];
    const settings = body.settings;
    if (settings !== undefined) {
      if (!isAdmin) throw httpError(403, 'Only an HR Admin can change workspace settings.');
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw httpError(400, 'settings must be an object.');
    }
    if (!isAdmin) {
      if (SYNC_KEYS.some((k) => ups[k].length || rems[k].length)) throw httpError(403, 'Only an HR Admin can add, replace or remove records.');
      const denied = [];
      patches.forEach((p) => Object.keys(p.set).forEach((f) => { if (REVIEWER_EMPLOYEE_FIELDS.indexOf(f) < 0 && denied.indexOf(f) < 0) denied.push(f); }));
      if (denied.length) throw httpError(403, `Only an HR Admin can change: ${denied.join(', ')}.`);
    }
    const version = await store.withTx(pool, async (client) => {
      const ws = await lockedWorkspace(client);
      if (settings !== undefined && body.baseVersion !== ws.version) {
        throw Object.assign(httpError(409, 'Someone else changed the workspace settings since you loaded them.'), { body: { version: ws.version } });
      }
      for (const k of SYNC_KEYS) {
        if (k === 'employees') continue;
        await store.deleteRecords(client, k, rems[k]);
      }
      await store.deleteEmployeesCascade(client, rems.employees);
      for (const k of SYNC_KEYS) await store.upsertRecords(client, k, ups[k]);
      for (const p of patches) {
        const r = await client.query(PATCH_EMPLOYEE_SQL, [p.id, JSON.stringify(p.set)]);
        if (!r.rowCount) throw httpError(404, 'That employee no longer exists — reload the page.');
      }
      await store.appendAudit(client, audit, req.user.id);
      return store.touchWorkspace(client, req.user.email, settings !== undefined ? store.workspaceSettings(settings) : null);
    });
    res.json({ ok: true, version });
  }));

  router.get('/archives/:id', requireAdmin, handle(async (req, res) => {
    const r = await pool.query('select * from archives where id = $1', [req.params.id]);
    if (!r.rows.length) throw httpError(404, 'Archive not found.');
    const a = r.rows[0];
    res.json({ id: a.id, cycleLabel: a.cycle_label, archivedAt: a.archived_at, archivedBy: a.archived_by, employeeCount: a.employee_count, snapshot: a.snapshot });
  }));

  // ---------------------------------------------------- annual data load ----

  router.get('/data-load/template', requireAdmin, (req, res) => {
    csvResponse(res, 'rtd_annual_data_template.csv', dl.csvStringify(dl.TEMPLATE_HEADERS, []));
  });

  router.get('/data-load/export', requireAdmin, handle(async (req, res) => {
    const ws = await store.getWorkspace(pool);
    const employees = await store.loadEmployees(pool);
    const label = ((ws && ws.data.meta && ws.data.meta.cycleLabel) || 'roster').replace(/\s+/g, '_');
    csvResponse(res, `rtd_current_roster_${label}.csv`, dl.csvStringify(dl.TEMPLATE_HEADERS, employees.map(dl.rosterRow)));
  }));

  router.get('/data-load/batches', requireAdmin, handle(async (req, res) => {
    res.json({ batches: await store.listBatches(pool) });
  }));

  router.post('/data-load/preview', requireAdmin, handle(async (req, res) => {
    const rows = dl.normalizeRows(req.body && req.body.rows);
    const ws = await store.getWorkspace(pool);
    const plan = dl.planDataLoad(await store.loadEmployees(pool), rows, ws.data.meta.cycleLabel);
    res.json({ year: plan.year, summary: plan.summary, rows: plan.outcomes });
  }));

  router.post('/data-load/commit', requireAdmin, handle(async (req, res) => {
    const rows = dl.normalizeRows(req.body && req.body.rows);
    const fileName = (typeof req.body.fileName === 'string' && req.body.fileName.trim().slice(0, 255)) || 'Uploaded file';
    const actor = actorName(req);
    const result = await store.withTx(pool, async (client) => {
      const ws = await lockedWorkspace(client);
      const employees = await store.loadEmployees(client);
      const plan = dl.planDataLoad(employees, rows, ws.data.meta.cycleLabel);
      const now = new Date().toISOString();
      const firstStep = (ws.data.stepNames && ws.data.stepNames[0]) || 'Step 1';

      await store.upsertRecords(client, 'employees', plan.created.concat(plan.updated.map((u) => u.after)));
      await store.upsertRecords(client, 'workflow', plan.created.map((e) => ({
        employeeId: e.id, currentStep: 1, status: 'In Progress',
        history: [{ step: 1, stepName: firstStep, completedBy: 'System', completedAt: now, notes: 'Loaded via annual data upload' }],
      })));

      const all = await refreshDuplicateFlags(client);
      const touched = new Set(plan.created.map((e) => e.id).concat(plan.updated.map((u) => u.after.id)));
      const duplicates = all.filter((e) => touched.has(e.id) && dl.hasDuplicateFlag(e)).length;
      const { creates, updates, flagged } = plan.summary;

      const batchId = dl.uid('BATCH');
      await client.query(
        `insert into upload_batches (id, file_name, cycle_label, uploaded_by, uploaded_by_user, row_count, created_count, updated_count, flagged_count, duplicate_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [batchId, fileName, ws.data.meta.cycleLabel, actor, req.user.id, rows.length, plan.created.length, plan.updated.length, flagged, duplicates]
      );
      const items = plan.created.map((e) => [e.id, 'created', null]).concat(plan.updated.map((u) => [u.before.id, 'updated', JSON.stringify(u.before)]));
      if (items.length) {
        await client.query(
          `insert into upload_batch_items (batch_id, employee_id, kind, before)
           select $1, * from unnest($2::text[], $3::text[], $4::jsonb[])`,
          [batchId, items.map((i) => i[0]), items.map((i) => i[1]), items.map((i) => i[2])]
        );
      }
      const summaryText = `${updates} updated, ${creates} created` + (flagged ? `, ${flagged} flagged for missing data` : '') + (duplicates ? `, ${duplicates} with a duplicate GGID this year` : '');
      await store.appendAudit(client, [auditEntry({
        user: actor, entity: 'Data Load', field: 'Employees', oldValue: `${employees.length} existing`, newValue: summaryText, action: 'Annual Data Upload',
      })], req.user.id);
      await store.touchWorkspace(client, req.user.email);
      const message = `Loaded ${updates} updates and ${creates} new cases` +
        (flagged ? ` — ${flagged} flagged for missing data` : '') +
        (duplicates ? `${flagged ? ' and ' : ' — '}${duplicates} with a duplicate GGID this year` : '') +
        ((flagged || duplicates) ? ' (see RTD Review)' : '');
      return { batchId, summary: { rows: rows.length, updated: updates, created: creates, flagged, duplicates }, message };
    });
    res.status(201).json(result);
  }));

  // Undoes one upload: deletes the employees it created (and their linked records) and restores
  // the ones it updated to their pre-upload values.
  router.delete('/data-load/batches/:id', requireAdmin, handle(async (req, res) => {
    const actor = actorName(req);
    const result = await store.withTx(pool, async (client) => {
      await lockedWorkspace(client);
      const b = await client.query('select * from upload_batches where id = $1', [req.params.id]);
      if (!b.rows.length) throw httpError(404, 'That upload no longer exists.');
      const batch = b.rows[0];
      const items = (await client.query('select employee_id, kind, before from upload_batch_items where batch_id = $1', [batch.id])).rows;
      const createdIds = items.filter((i) => i.kind === 'created').map((i) => i.employee_id);
      await store.deleteEmployeesCascade(client, createdIds);
      const updatedItems = items.filter((i) => i.kind === 'updated');
      const stillThere = new Set((await client.query('select id from employees where id = any($1::text[])', [updatedItems.map((i) => i.employee_id)])).rows.map((r) => r.id));
      const restore = updatedItems.filter((i) => stillThere.has(i.employee_id)).map((i) => i.before);
      await store.upsertRecords(client, 'employees', restore);
      await refreshDuplicateFlags(client);
      await client.query('delete from upload_batches where id = $1', [batch.id]);
      await store.appendAudit(client, [auditEntry({
        user: actor, entity: 'Data Load', field: 'Upload batch', oldValue: batch.file_name,
        newValue: `Removed — ${createdIds.length} deleted, ${restore.length} reverted`, action: 'Upload Removed',
      })], req.user.id);
      await store.touchWorkspace(client, req.user.email);
      return { deleted: createdIds.length, reverted: restore.length, message: `Removed upload "${batch.file_name}" — ${createdIds.length} deleted, ${restore.length} reverted` };
    });
    res.json(result);
  }));

  router.post('/data-load/remove-all', requireAdmin, handle(async (req, res) => {
    const actor = actorName(req);
    const result = await store.withTx(pool, async (client) => {
      await lockedWorkspace(client);
      const count = (await client.query('select count(*)::int as n from employees')).rows[0].n;
      for (const t of ['accounts', 'contributions', 'manager_records', 'workflow', 'employees', 'upload_batches']) await client.query(`delete from ${t}`);
      await store.appendAudit(client, [auditEntry({
        user: actor, entity: 'DataLoad', field: 'employees', oldValue: `${count} records`, newValue: '0 records', action: 'All Records Removed',
      })], req.user.id);
      await store.touchWorkspace(client, req.user.email);
      return { removed: count, message: `Removed all ${count} records` };
    });
    res.json(result);
  }));

  router.post('/data-load/factory-reset', requireAdmin, handle(async (req, res) => {
    if (!req.body || req.body.confirm !== 'DELETE EVERYTHING') throw httpError(400, 'Factory reset needs confirm: "DELETE EVERYTHING".');
    const actor = actorName(req);
    const result = await store.withTx(pool, async (client) => {
      await lockedWorkspace(client);
      const count = (await client.query('select count(*)::int as n from employees')).rows[0].n;
      const archives = (await client.query('select count(*)::int as n from archives')).rows[0].n;
      for (const t of ['accounts', 'contributions', 'manager_records', 'workflow', 'employees', 'upload_batches', 'archives', 'audit_log']) await client.query(`delete from ${t}`);
      await store.appendAudit(client, [auditEntry({
        user: actor, entity: 'DataLoad', field: 'all data', oldValue: `${count} records, ${archives} archives`, newValue: '0', action: 'Factory Reset',
      })], req.user.id);
      await store.touchWorkspace(client, req.user.email);
      return { removed: count, archivesRemoved: archives, message: 'Deleted all data — factory reset' };
    });
    res.json(result);
  }));

  // Archives the active cycle and starts the next one: snapshots every record plus each case's
  // computed outcome (final rating, eligibility), resets workflows and switches the cycle label.
  router.post('/cycles/archive', requireAdmin, handle(async (req, res) => {
    const nextLabel = typeof req.body.nextLabel === 'string' ? req.body.nextLabel.trim().slice(0, 100) : '';
    if (!nextLabel) throw httpError(400, 'Enter a label for the next cycle.');
    const actor = actorName(req);
    const result = await store.withTx(pool, async (client) => {
      const ws = await lockedWorkspace(client);
      const prevLabel = ws.data.meta.cycleLabel;
      if (nextLabel === prevLabel) throw httpError(400, 'The next cycle needs a different label from the current one.');
      const q = (sql) => client.query(sql).then((r) => r.rows.map((x) => x.data));
      const employees = await q('select data from employees order by seq');
      const accounts = await q('select data from accounts order by seq');
      const contributions = await q('select data from contributions order by seq');
      const workflow = {};
      (await client.query('select employee_id, data from workflow')).rows.forEach((w) => { workflow[w.employee_id] = w.data; });
      const engine = createEngine(applySettingsDefaults(Object.assign({}, ws.data)), { accounts, contributions, workflow });
      const snapshot = {
        cases: employees.map((e) => {
          const c = engine.fullCase(e);
          return { employeeId: e.id, name: e.name, ggid: e.ggid, region: e.region, country: e.country, practice: e.practice,
            globalGrade: e.globalGrade, localGrade: e.localGrade, finalRating: c.rating.finalRating,
            eligibilityStatus: c.eligibility.status, promotionRecommendation: e.promotionRecommendation };
        }),
        employees,
        accounts,
        contributions,
        managerRecords: await q('select data from manager_records order by seq'),
        rules: ws.data.rules || [],
      };
      const archiveId = dl.uid('ARC');
      await client.query('insert into archives (id, cycle_label, archived_by, employee_count, snapshot) values ($1, $2, $3, $4, $5)',
        [archiveId, prevLabel, actor, employees.length, snapshot]);
      const now = new Date();
      const firstStep = (ws.data.stepNames && ws.data.stepNames[0]) || 'Step 1';
      await client.query(
        `update workflow set updated_at = now(), data = jsonb_build_object('employeeId', employee_id, 'currentStep', 1, 'status', 'In Progress',
           'history', jsonb_build_array(jsonb_build_object('step', 1, 'stepName', $1::text, 'completedBy', $2::text, 'completedAt', $3::text, 'notes', 'New cycle started')))`,
        [firstStep, actor, now.toISOString()]
      );
      await client.query('delete from upload_batches');
      const settings = Object.assign({}, ws.data, { meta: Object.assign({}, ws.data.meta, { cycleLabel: nextLabel }) });
      const version = await store.touchWorkspace(client, req.user.email, settings);
      await store.appendAudit(client, [
        auditEntry({ timestamp: now.toISOString(), user: actor, entity: 'Archive', field: 'Cycle', oldValue: prevLabel, newValue: 'Archived', action: 'Cycle Archived' }),
        auditEntry({ timestamp: new Date(now.getTime() + 1).toISOString(), user: actor, entity: 'Cycle', field: 'cycleLabel', oldValue: prevLabel, newValue: nextLabel, action: 'New Cycle Started' }),
      ], req.user.id);
      return { archiveId, version, message: `Archived ${prevLabel} — now in ${nextLabel}` };
    });
    res.status(201).json(result);
  }));

  return router;
};
