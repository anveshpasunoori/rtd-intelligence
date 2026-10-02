// Test harness: runs the real server in-process against a throwaway database and gives tests a
// small cookie-keeping HTTP client. Set TEST_DATABASE_URL to a database whose name ends in
// "_test"; it is wiped and rebuilt by resetDatabase().

const assert = require('node:assert/strict');

const url = process.env.TEST_DATABASE_URL;
if (!url || !/_test(\?|$)/.test(url)) {
  throw new Error('Set TEST_DATABASE_URL to a database whose name ends in "_test" (it gets wiped).');
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_RATE_LIMIT = '100000';

const { pool, start, prepareDatabase } = require('../server');

let server, base;

async function startServer() {
  if (!server) {
    const origLog = console.log;
    console.log = () => {};
    try {
      await resetDatabase();
      server = await start(0);
    } finally {
      console.log = origLog;
    }
    base = `http://127.0.0.1:${server.address().port}`;
  }
  return base;
}

async function stopServer() {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  await pool.end();
}

// Drops every table and recreates the schema plus the demo workspace (300 employees).
async function resetDatabase() {
  await pool.query('drop schema public cascade; create schema public;');
  const origLog = console.log;
  console.log = () => {};
  try {
    await prepareDatabase();
  } finally {
    console.log = origLog;
  }
}

class Client {
  constructor() { this.cookie = ''; }

  async req(method, path, body, { raw = false } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const resp = await fetch(base + path, { method, headers, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/rtd_session=([^;]*)/);
      this.cookie = m && m[1] ? `rtd_session=${m[1]}` : '';
    }
    const text = await resp.text();
    let json = null;
    if (!raw) { try { json = JSON.parse(text); } catch (e) { json = null; } }
    return { status: resp.status, body: json, text, headers: resp.headers };
  }

  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b) { return this.req('POST', p, b === undefined ? {} : b); }
  del(p, b) { return this.req('DELETE', p, b === undefined ? {} : b); }
}

let userSeq = 0;
// Registers a fresh account (optionally promoted to HR Admin) and returns a logged-in client.
async function newUser(role = 'RTD Reviewer') {
  const c = new Client();
  const email = `user${Date.now()}${++userSeq}@example.test`;
  const r = await c.post('/api/auth/register', { email, password: 'password-123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (role !== 'RTD Reviewer') await pool.query('update users set role = $1 where email = $2', [role, email]);
  c.email = email;
  return c;
}

// The whole workspace as stored, read straight from the database (no API returns it all).
async function dbState() {
  const client = await pool.connect();
  try {
    return await require('../lib/store').loadState(client);
  } finally {
    client.release();
  }
}

function row(overrides) {
  return Object.assign({
    ggid: '', name: '', email: '', region: 'United States', country: 'United States', globalGrade: 'C1', localGrade: 'Associate Consultant',
    practice: 'Underwriting Advisory', subPractice: 'Commercial Lines', priorYearRating: 'Exceeding',
  }, overrides);
}

module.exports = { assert, pool, startServer, stopServer, resetDatabase, Client, newUser, dbState, row };
