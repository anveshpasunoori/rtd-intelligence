// Computed cases for the whole roster, cached in memory and rebuilt only when the workspace has
// changed since the last build (every write path bumps workspace.updated_at via touchWorkspace).
// Dashboards and dossiers read from here, so the browser never needs the full roster.

const { createEngine, applySettingsDefaults } = require('./engine');

let cached = null;   // { stamp, ... }
let building = null; // { stamp, promise } while a rebuild is in flight

// Postgres timestamps carry microseconds that a JS Date drops, so compare the text form.
const STAMP_SQL = "select version || '@' || to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US') as stamp from workspace where id = 1";

async function currentStamp(pool) {
  const r = await pool.query(STAMP_SQL);
  return r.rows.length ? r.rows[0].stamp : null;
}

async function build(pool) {
  const client = await pool.connect();
  try {
    // One snapshot of every table, so the cases are internally consistent; the stamp is read
    // inside the same snapshot, so it labels exactly the data the cases were built from.
    await client.query('begin isolation level repeatable read read only');
    const q = (sql) => client.query(sql).then((r) => r.rows);
    const stamp = (await q(STAMP_SQL))[0].stamp;
    const ws = (await q('select data, version, updated_at from workspace where id = 1'))[0];
    const employees = (await q('select data from employees order by seq')).map((x) => x.data);
    const accounts = (await q('select data from accounts order by seq')).map((x) => x.data);
    const contributions = (await q('select data from contributions order by seq')).map((x) => x.data);
    const managerRecords = (await q('select data from manager_records order by seq')).map((x) => x.data);
    const workflow = {};
    (await q('select employee_id, data from workflow order by seq')).forEach((w) => { workflow[w.employee_id] = w.data; });
    await client.query('commit');

    const settings = applySettingsDefaults(Object.assign({}, ws.data));
    const engine = createEngine(settings, { accounts, contributions, workflow });
    const cases = employees.map(engine.fullCase);
    return {
      stamp, version: ws.version, updatedAt: ws.updated_at, settings, engine,
      employees, accounts, contributions, managerRecords, workflow, cases,
      byId: new Map(cases.map((c) => [c.employee.id, c])),
      achievementRanks: engine.achievementRanks(cases),
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getCases(pool) {
  const stamp = await currentStamp(pool);
  if (stamp == null) throw Object.assign(new Error('Workspace is not initialized yet.'), { status: 503 });
  if (cached && cached.stamp === stamp) return cached;
  if (building && building.stamp === stamp) return building.promise;
  const promise = build(pool).then((result) => {
    cached = result;
    if (building && building.promise === promise) building = null;
    return result;
  }, (err) => {
    if (building && building.promise === promise) building = null;
    throw err;
  });
  building = { stamp, promise };
  return promise;
}

function clearCache() { cached = null; building = null; }

module.exports = { getCases, clearCache };
