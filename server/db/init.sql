-- RTD Intelligence: database schema for the self-hosted server.
-- Runs automatically the first time the Postgres container starts (see docker-compose.yml, which
-- mounts this file into /docker-entrypoint-initdb.d/). Safe to also run by hand via psql if you're
-- not using the Docker setup.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  -- Access level: 'HR Admin' (full access: overrides, data load, archives, administration, audit
  -- log) or 'RTD Reviewer' (read access). Granted by hand in psql — see README.md.
  role text not null default 'RTD Reviewer' check (role in ('HR Admin', 'RTD Reviewer')),
  created_at timestamptz not null default now()
);

-- All other tables (shared workspace, employees, workflow, upload batches, archives, audit log, ...)
-- are created and upgraded by db/schema.sql, which server.js runs on every start.
