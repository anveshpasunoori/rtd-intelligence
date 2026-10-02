// RTD Intelligence — self-hosted backend.
// Serves the app (public/index.html) and its JSON API: email+password login (bcrypt + a signed
// httpOnly session cookie) plus the shared workspace and Annual Data Load endpoints in
// routes/api.js, stored in Postgres tables (db/schema.sql). See README.md for deployment and the
// API reference.

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const apiRoutes = require('./routes/api');
const dashboardRoutes = require('./routes/dashboards');

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET is not set (or too short). Set a long random value in your .env — see .env.example.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // the app is a single inline-script page; a CSP would need real tuning per deployment
}));
app.use(compression()); // gzip API responses and the page itself
app.use(express.json({ limit: '50mb' })); // a large annual upload (tens of thousands of rows) can run tens of MB
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signSession(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: SESSION_DAYS + 'd' });
}

// Whether the session cookie is marked Secure (sent over HTTPS only). COOKIE_SECURE=auto (the
// default) follows the connection: Secure over HTTPS — including behind a TLS-terminating proxy
// when TRUST_PROXY=true — and not over plain http, where browsers would silently drop a Secure
// cookie and the login would never stick. true/false force it either way.
function cookieSecure(req) {
  const mode = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return req.secure;
}

function setSessionCookie(req, res, token) {
  res.cookie('rtd_session', token, {
    httpOnly: true,
    secure: cookieSecure(req),
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// Verifies the session cookie, then reads the account's current email and role from the database
// so a role change (or a deleted account) takes effect on the very next request.
async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.rtd_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
  try {
    const result = await pool.query('select id, email, role from users where id = $1', [payload.sub]);
    if (!result.rows.length) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error('auth lookup error', err);
    res.status(500).json({ error: 'Could not verify your session right now.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'HR Admin') return res.status(403).json({ error: 'This action needs HR Admin access.' });
  next();
}

// ---------------------------------------------------------------- auth ----

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const existing = await pool.query('select id from users where email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with that email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const inserted = await pool.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, role',
      [email, hash]
    );
    const user = inserted.rows[0];
    setSessionCookie(req, res, signSession(user));
    res.status(201).json({ ok: true, email: user.email, role: user.role });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const result = await pool.query('select id, email, role, password_hash from users where email = $1', [email]);
    const user = result.rows[0];
    // Same generic error whether the email doesn't exist or the password is wrong — don't reveal
    // which one, and always run bcrypt.compare (against a dummy hash if there's no user) so the
    // response time doesn't itself leak whether an account exists.
    const hashToCheck = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const matches = await bcrypt.compare(password, hashToCheck);
    if (!user || !matches) return res.status(401).json({ error: 'Invalid email or password.' });

    setSessionCookie(req, res, signSession(user));
    res.json({ ok: true, email: user.email, role: user.role });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Could not log in right now. Try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('rtd_session', { path: '/' });
  res.json({ ok: true });
});

// Role comes from requireAuth's fresh database read, so granting or revoking access in psql takes
// effect on the user's next page load without them logging out.
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, role: req.user.role });
});

// ---------------------------------------------- workspace / data load ----

app.use('/api', requireAuth, apiRoutes({ pool, requireAdmin }), dashboardRoutes({ pool, requireAdmin }));

// -------------------------------------------------------------- static ----

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Body-parser failures (malformed JSON, payload too large) as JSON instead of an HTML error page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON request body.' });
  console.error(req.method, req.path, err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

// Brings the database schema up to date (db/schema.sql is idempotent) and creates the shared
// workspace on first run.
async function prepareDatabase() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  await store.ensureWorkspace(pool);
}

async function start(port = PORT) {
  // Fail fast and loud if the database isn't reachable or can't be migrated, rather than starting
  // a server that will 500 on every single request.
  try {
    await pool.query('select 1');
  } catch (err) {
    console.error('FATAL: could not reach the database. Check DATABASE_URL.', err.message);
    process.exit(1);
  }
  try {
    await prepareDatabase();
  } catch (err) {
    console.error('FATAL: could not prepare the database schema.', err);
    process.exit(1);
  }
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`RTD Intelligence server listening on port ${server.address().port}`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { app, pool, start, prepareDatabase };
