# RTD Intelligence — self-hosted server

This replaces the old browser-only version of RTD Intelligence (a single HTML file that saved to
that browser's local storage, or to a published Claude Artifact) with a real backend: a small
Node.js API in front of Postgres, plus real email/password login. It's meant to run on your own
company infrastructure — nothing here talks to any third-party service.

## What this actually is

- `public/index.html` — the app itself.
- `server.js` — Express server: serves the app, login/registration, and mounts the API.
- `routes/api.js` — saving (`/api/sync`), Annual Data Load and cycle-archive endpoints (see **API** below).
- `lib/dataload.js` — the Annual Data Load rules (matching, merging, data-quality flags).
- `lib/engine.js` — the RTD rules engine (ratings, eligibility, risk, confidence, quotas, rule impact).
- `lib/cases.js` — computed cases for the whole roster, cached and rebuilt after each change.
- `routes/dashboards.js` — workspace, dashboard, dossier, search, rule-impact, audit and archive reads.
- `lib/store.js` — database access.
- `db/schema.sql` — every table; run automatically on each server start (creates or upgrades).
- `db/seed.json` — demo roster loaded into a brand-new database (skip with `SEED_DEMO_DATA=false`).
- `test/` — automated tests (see **Running the tests**).
- `Dockerfile` + `docker-compose.yml` — packages the app and a Postgres database together so this
  can be deployed with two commands on a server that has nothing else installed on it yet.

**Data model:** one shared, org-wide workspace. Everyone who logs in sees the same data: when an HR
Admin runs the Annual Data Load, every reviewer sees the new roster. Records live in their own
tables (`employees`, `workflow`, `accounts`, `contributions`, `manager_records`, `upload_batches` +
`upload_batch_items`, `archives`, `audit_log`); workspace-wide settings (cycle label, rules engine,
Administration reference data) are one JSON document in `workspace`. The browser sends only what
changed when you save, so two people editing different employees don't overwrite each other; two
admins editing *settings* at once get a "changed by someone else" message instead of a silent
overwrite.

A brand-new database starts with the demo roster. Clear it from **Annual Data Load → Danger zone**
before loading real data, or set `SEED_DEMO_DATA=false` in `.env` before the first start.

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

### Granting admin access

New accounts start as **RTD Reviewer** (read access). To give someone **HR Admin** (full access:
overrides, data load, archives, Administration, audit log), run:
```
docker compose exec db psql -U rtd -d rtd -c "update users set role='HR Admin' where email='someone@example.com';"
```
Set `role='RTD Reviewer'` to revoke. It takes effect the next time they load the page.

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

## API

All endpoints are JSON under `/api`, authenticated by the session cookie. The browser never downloads
the roster: the rules engine (`lib/engine.js`) runs on the server, which keeps every computed case in
memory and rebuilds them after any change (`lib/cases.js`); each screen asks for its aggregates and one
page of rows. Responses are gzip-compressed. **Admin** = HR Admin only
(403 otherwise); a missing/expired session gets 401.

| Method & path | Who | What it does |
|---|---|---|
| `POST /api/auth/register` · `/login` · `/logout`, `GET /api/auth/me` | anyone | Accounts and sessions; `me` returns `{email, role}` |
| `GET /api/workspace` | any user | Settings (rules, admin config, cycle), record counts, filter options, archived-cycle list, and (Admin) this cycle's uploads — no records |
| `GET /api/dashboards/executive` | any user | KPIs, rating/eligibility counts, compliance and the first flagged cases |
| `GET /api/dashboards/rtd` | any user | RTD Review KPIs, top blockers and one page of rows (`rating`, `eligibility`, `risk=1`, `q`, `sort`, `dir`, `offset`, `limit`) |
| `GET /api/dashboards/rtd/export` | Admin | Every row the RTD Review filters match, with the Excel export columns |
| `GET /api/dashboards/promotions` | any user | Funnel, KPIs, insights and one page of candidates with promotion-quota positions (`eligibility`, `globalGrade`, `q`, paging) |
| `GET /api/dashboards/calibration` | any user | Rating and promotion-readiness distributions |
| `GET /api/employees/:id` | any user | One dossier: the record, its accounts, contributions, manager record, workflow and computed case |
| `GET /api/employees/search?q=` | any user | Employees matching a name or GGID, and whether any practice matches |
| `GET /api/rules/:id/impact` | Admin | How many cases a rule affects (Rules Engine → Test) |
| `GET /api/audit` | Admin | Audit log, newest first (`entity`, `fieldPrefix`, `offset`, `limit`) |
| `GET /api/archives/:id/cases` | Admin | An archived cycle's case summaries with rating/eligibility counts (quick filters, paging) |
| `GET /api/archives/:id` | Admin | One archived cycle with its full snapshot |
| `POST /api/sync` | any user (see below) | Saves changes: `patch.employees` (`[{id, set}]` — only the given fields), `upsert`/`remove` per collection (Admin), new `audit` entries, and `settings` + `baseVersion` (Admin; 409 if stale). An RTD Reviewer may only change an employee's primary account |
| `GET /api/data-load/template` | Admin | CSV template |
| `GET /api/data-load/export` | Admin | Current roster as CSV (same columns; re-uploadable) |
| `POST /api/data-load/preview` | Admin | `{rows}` → per-row action (`create`/`update`), matched employee and data-quality issues; saves nothing |
| `POST /api/data-load/commit` | Admin | `{fileName, rows, actorName}` → applies the upload in one transaction; returns a summary |
| `GET /api/data-load/batches` | Admin | Uploads committed this cycle |
| `DELETE /api/data-load/batches/:id` | Admin | Undoes one upload: deletes what it created, restores what it updated |
| `POST /api/data-load/remove-all` | Admin | Deletes every employee record (keeps archives and the audit log) |
| `POST /api/data-load/factory-reset` | Admin | `{confirm: "DELETE EVERYTHING"}` → also deletes archives and the audit log |
| `POST /api/cycles/archive` | Admin | `{nextLabel}` → snapshots every record and each case's computed outcome, resets every workflow to step 1, starts the next cycle |

Upload rows are objects keyed by column header; headers are matched to the template loosely
("Global Grade", "Employee Name", "Work Email", ... all work). A row matches an existing employee
by GGID, else by email (case-insensitive); otherwise it's a new case. Rows with missing data are
still loaded and flagged. Up to 50,000 rows per upload.

## Running the tests

The suite runs the real server against a throwaway database whose name must end in `_test` (it is
wiped on every run):

```
docker compose exec db psql -U rtd -d rtd -c "create database rtd_test owner rtd"   # once
docker compose build app
docker compose run --rm --no-deps -e TEST_DATABASE_URL="postgres://rtd:<POSTGRES_PASSWORD>@db:5432/rtd_test" app npm test
```

## Local development (without Docker)

```
npm install
cp .env.example .env   # then set DATABASE_URL to your local Postgres
node server.js         # creates/upgrades the tables on start
```

## Security notes

- Passwords are hashed with bcrypt (cost 12); never stored in plain text.
- Sessions are a signed, httpOnly cookie (`rtd_session`) — not readable by JavaScript, so a typical
  XSS bug can't steal it the way it could steal a token sitting in localStorage.
- Login and registration are rate-limited (30 attempts per 15 minutes per IP) to slow brute-forcing.
- `JWT_SECRET` and `POSTGRES_PASSWORD` live only in `.env` on the server, which is excluded from git
  via `.gitignore` — never commit real secrets into version control.
