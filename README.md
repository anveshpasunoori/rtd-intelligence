# RTD Intelligence

RTD (Rating, Talent & Development) review and promotion decision platform: annual data load,
rules-driven ratings and promotion eligibility, dashboards, employee dossiers, calibration,
archives and an audit trail.

The app lives in [`server/`](server/): a Node.js server with a Postgres database, both run with
Docker. [`server/README.md`](server/README.md) covers production deployment, the data model and
the full API reference. This page gets you running on your own machine.

> The `index.html` at the top of this repo is the old browser-only prototype, kept for reference.
> Don't use it — it doesn't share data with the server.

## Run it on your machine

You need **Docker Desktop** (or Docker with the Compose plugin) and **git**. Nothing else —
Node and Postgres run inside containers.

1. Get the code (or `git pull` if you already have it):
   ```bash
   git clone https://github.com/anveshpasunoori/rtd-intelligence.git
   cd rtd-intelligence/server
   ```

2. Create your settings file. `.env` holds passwords, so it is **not** in git — every machine
   needs its own:
   ```bash
   cp .env.example .env
   ```

3. Put long random values after `JWT_SECRET=` and `POSTGRES_PASSWORD=` in `.env`. To generate
   them automatically on macOS:
   ```bash
   sed -i '' "s|^JWT_SECRET=$|JWT_SECRET=$(openssl rand -hex 48)|; s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
   ```
   On Linux, use `sed -i` instead of `sed -i ''`.

4. Build and start (the first build takes a minute or two):
   ```bash
   docker compose up -d --build
   ```

5. Check it's running — you should see `RTD Intelligence server listening on port 8080`:
   ```bash
   docker compose logs --tail 5 app
   ```

6. Open **http://localhost:8080** and click **Create an account**.

7. New accounts are **RTD Reviewers** (read-only dashboards and dossiers). To make yourself an
   **HR Admin** (data load, overrides, archives, Administration, audit log), run this with your
   email, then reload the page:
   ```bash
   docker compose exec db psql -U rtd -d rtd -c "update users set role='HR Admin' where email='you@example.com';"
   ```

A new database starts with **300 demo employees** so there's something to look at. Clear them
from **Annual Data Load → Danger zone** before loading real data, or set `SEED_DEMO_DATA=false`
in `.env` before the very first start.

## Everyday commands

Run these from the `server/` folder:

| To… | Run |
|---|---|
| Stop | `docker compose stop` |
| Start again | `docker compose up -d` |
| Restart | `docker compose restart` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| See the server log | `docker compose logs -f app` |
| Run the tests | see [Running the tests](server/README.md#running-the-tests) |

Your data is kept in a Docker volume, so stopping, restarting and rebuilding don't lose it.
`docker compose down -v` **deletes** it.

## Moving your data to another machine

Data lives only in that machine's database — `git` carries the code, not the data. To copy it:

1. On the old machine, from `server/`:
   ```bash
   docker compose exec db pg_dump -U rtd --clean rtd > rtd_backup.sql
   ```
2. Copy `rtd_backup.sql` to the new machine, set it up with the steps above, then from `server/`:
   ```bash
   docker compose exec -T db psql -U rtd -d rtd < rtd_backup.sql
   ```
   This replaces the new machine's data (including its accounts) with the old machine's.

## Troubleshooting

- **Login doesn't stick** — if you open the app from another computer over plain `http://`
  (not `localhost`), set `COOKIE_SECURE=false` in `.env`, then `docker compose up -d`.
- **Port 8080 is already in use** — set `APP_PORT=8081` (or any free port) in `.env`, then
  `docker compose up -d` and use that port in the browser.
- **`docker compose up` fails with a password error** — `.env` is missing or its
  `POSTGRES_PASSWORD` is empty; redo steps 2–3.
- **"could not reach the database" after changing `POSTGRES_PASSWORD`** — the database keeps the
  password it was created with. If it holds nothing you need, reset it with
  `docker compose down -v && docker compose up -d` (this deletes all data).
