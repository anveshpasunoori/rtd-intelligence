# RTD Intelligence — self-hosted server

This replaces the old browser-only version of RTD Intelligence (a single HTML file that saved to
that browser's local storage, or to a published Claude Artifact) with a real backend: a small
Node.js API in front of Postgres, plus real email/password login. It's meant to run on your own
company infrastructure — nothing here talks to any third-party service.

## What this actually is

- `public/index.html` — the app itself (unchanged in almost every feature; the only difference from
  the version you already know is *how* it saves and loads data).
- `server.js` — a small Express server: serves the app, handles login/registration, and stores/
  loads each user's data in Postgres instead of that browser's local storage.
- `db/init.sql` — the two tables this needs (`users`, `app_state`). Runs automatically the first
  time the database container starts.
- `Dockerfile` + `docker-compose.yml` — packages the app and a Postgres database together so this
  can be deployed with two commands on a server that has nothing else installed on it yet.

**Design note:** rather than break every piece of app state (employees, archives, rules, quotas,
audit log, …) into a dozen separate relational tables, this stores the whole app state as one JSON
document per logged-in user — the same shape the app already keeps in memory. That's what actually
fixes what was broken (data disappearing, no real login, hardcoded default users) without a risky
rewrite of every feature's internals. Splitting it into normalized tables for real cross-employee
SQL reporting is a reasonable next step later; it isn't required for this to work correctly today.

**Data model today:** one account, one dataset. Whoever registers an account gets their own private
copy of the data (starting from the same seed data the app always shipped with), which follows them
across machines and browsers as long as they log in. If down the road multiple people need to see
and edit the *same* shared dataset, that's a small extension of this same design (a shared
workspace instead of one dataset per account) — flag it and it can be added without starting over.

## Deploying it (for IT / DevOps)

**Prerequisites on the server:** Docker and the Docker Compose plugin. Nothing else — Postgres and
Node both run inside containers this brings with it.

1. Copy this whole folder onto the server.
2. Copy `.env.example` to `.env` and fill in real values:
   ```
   cp .env.example .env
   ```
   - `JWT_SECRET` — generate with `openssl rand -base64 48`
   - `POSTGRES_PASSWORD` — generate with `openssl rand -base64 24`
   - `APP_PORT` — the port on this server the app should be reachable on (default 8080)
   - `COOKIE_SECURE` — leave `true` unless this server is reachable *only* over plain http with no
     TLS anywhere in front of it (see the comments in `.env.example`)
   - `TRUST_PROXY` — set `true` if this sits behind an nginx/load-balancer that terminates TLS
3. Build and start everything:
   ```
   docker compose up -d --build
   ```
4. Check it's healthy:
   ```
   docker compose ps
   docker compose logs -f app
   ```
   You should see `RTD Intelligence server listening on port 8080` in the app logs.
5. Open `http://<this-server>:<APP_PORT>/` in a browser. You'll land on a login screen — click
   "Create an account" to register the first user.

Data lives in a Docker-managed volume (`rtd_pgdata`) that survives container restarts and rebuilds.
**Back it up** the same way you'd back up any other production database on this server — e.g.
`docker compose exec db pg_dump -U rtd rtd > backup.sql` on whatever schedule your normal backup
process uses.

### Putting this behind your normal web server / TLS

This app listens on plain HTTP inside its container. If your standard setup is to put a reverse
proxy (nginx, an internal load balancer, etc.) in front of internal apps to handle the public
hostname and TLS certificate, do that the same way you would for any other internal app, pointing
it at `127.0.0.1:<APP_PORT>` on this server, and set `TRUST_PROXY=true` in `.env` so the app
correctly recognizes the connection as secure.

### Updating it later

```
git pull        # or copy over the new files, however you're tracking this
docker compose up -d --build
```
Existing data is untouched — it lives in the `rtd_pgdata` volume, separate from the app containers.

## Local development / testing (without Docker)

If you want to run this directly instead of through Docker (e.g. to test a change):

```
npm install
# Postgres must already be running locally, with a database matching db/init.sql applied
cp .env.example .env   # then edit DATABASE_URL to point at your local Postgres
node server.js
```

## Security notes

- Passwords are hashed with bcrypt (cost 12); never stored in plain text.
- Sessions are a signed, httpOnly cookie (`rtd_session`) — not readable by JavaScript, so a typical
  XSS bug can't steal it the way it could steal a token sitting in localStorage.
- Login and registration are rate-limited (30 attempts per 15 minutes per IP) to slow brute-forcing.
- `JWT_SECRET` and `POSTGRES_PASSWORD` live only in `.env` on the server, which is excluded from git
  via `.gitignore` — never commit real secrets into version control.
