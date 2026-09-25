-- RTD Intelligence: database schema for the self-hosted server.
-- Runs automatically the first time the Postgres container starts (see docker-compose.yml, which
-- mounts this file into /docker-entrypoint-initdb.d/). Safe to also run by hand via psql if you're
-- not using the Docker setup.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- The whole app state (employees, archives, upload batches, rules, audit log, ...) as one JSON
-- document per user, the same shape the app already keeps in memory. See server.js/README.md for
-- why: it gets real persistence and real login without a risky rewrite of every feature's
-- internals into separate relational tables. One row per user for now (single-tenant per login);
-- extending this to a shared team workspace later is a small change, not a redesign.
create table if not exists app_state (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null unique references users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function set_app_state_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_state_set_updated_at on app_state;
create trigger app_state_set_updated_at
before update on app_state
for each row execute function set_app_state_updated_at();
