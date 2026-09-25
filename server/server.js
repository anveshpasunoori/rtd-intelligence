// RTD Intelligence — self-hosted backend.
// Serves the app (public/index.html) and a small JSON API backing it: real email+password login
// (bcrypt + a signed httpOnly session cookie) and one JSON document per user in Postgres, replacing
// the old localStorage/Claude-Artifact persistence with something durable and shared across
// machines. See README.md for how to deploy this, and db/init.sql for the schema it expects.

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false'; // default true; set false only for plain-http intranet deployments
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
app.use(express.json({ limit: '25mb' })); // the full app-state document (employees, archives, audit log, ...) can run a few MB
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signSession(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: SESSION_DAYS + 'd' });
}

function setSessionCookie(res, token) {
  res.cookie('rtd_session', token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.rtd_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
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
      'insert into users (email, password_hash) values ($1, $2) returning id, email',
      [email, hash]
    );
    const user = inserted.rows[0];
    setSessionCookie(res, signSession(user));
    res.status(201).json({ ok: true, email: user.email });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const result = await pool.query('select id, email, password_hash from users where email = $1', [email]);
    const user = result.rows[0];
    // Same generic error whether the email doesn't exist or the password is wrong — don't reveal
    // which one, and always run bcrypt.compare (against a dummy hash if there's no user) so the
    // response time doesn't itself leak whether an account exists.
    const hashToCheck = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const matches = await bcrypt.compare(password, hashToCheck);
    if (!user || !matches) return res.status(401).json({ error: 'Invalid email or password.' });

    setSessionCookie(res, signSession(user));
    res.json({ ok: true, email: user.email });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Could not log in right now. Try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('rtd_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email });
});

// --------------------------------------------------------------- state ----

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('select data, updated_at from app_state where owner = $1', [req.user.id]);
    if (!result.rows.length) return res.json({ data: null });
    res.json({ data: result.rows[0].data, updatedAt: result.rows[0].updated_at });
  } catch (err) {
    console.error('get state error', err);
    res.status(500).json({ error: 'Could not load your data right now.' });
  }
});

app.put('/api/state', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Malformed state payload.' });
    }
    await pool.query(
      `insert into app_state (owner, data) values ($1, $2)
       on conflict (owner) do update set data = excluded.data`,
      [req.user.id, data]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('put state error', err);
    res.status(500).json({ error: 'Could not save right now.' });
  }
});

// -------------------------------------------------------------- static ----

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

async function start() {
  // Fail fast and loud if the database isn't reachable, rather than starting a server that will
  // 500 on every single request.
  try {
    await pool.query('select 1');
  } catch (err) {
    console.error('FATAL: could not reach the database. Check DATABASE_URL.', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`RTD Intelligence server listening on port ${PORT}`);
  });
}

start();
