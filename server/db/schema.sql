-- RTD Intelligence application schema. Idempotent: server.js runs this on every start, so it both
-- creates a fresh database and upgrades an existing one. (db/init.sql only creates the users table
-- the first time the Postgres container starts; everything else lives here.)
--
-- Data is one shared, org-wide workspace (not one copy per login): an HR Admin's Annual Data Load
-- is what every reviewer sees.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);
-- Access level: 'HR Admin' (full access: overrides, data load, archives, administration, audit
-- log) or 'RTD Reviewer' (read access). Granted by hand in psql; see README.md.
alter table users add column if not exists role text not null default 'RTD Reviewer'
  check (role in ('HR Admin', 'RTD Reviewer'));

-- Singleton row (id = 1) holding workspace-wide settings that aren't per-record: cycle label,
-- rules engine, administration reference data, L&D/manager/time-in-grade config, workflow step
-- names. `version` is bumped on every change so concurrent edits are detected (HTTP 409).
create table if not exists workspace (
  id int primary key check (id = 1),
  data jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- One row per employee case. The full record (as the app uses it) lives in `data`; the columns
-- beside it are copies of the fields the server matches and filters on.
create table if not exists employees (
  id text primary key,
  seq bigint generated always as identity,
  ggid text,
  email_key text,
  year int,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists employees_ggid_idx on employees (ggid);
create index if not exists employees_email_key_idx on employees (email_key);
create index if not exists employees_year_ggid_idx on employees (year, ggid);

-- Per-employee RTD workflow status (current step, history).
create table if not exists workflow (
  employee_id text primary key,
  seq bigint generated always as identity,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Records linked to an employee: client accounts, contributions, people-manager records.
create table if not exists accounts (
  id text primary key,
  seq bigint generated always as identity,
  employee_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists accounts_employee_idx on accounts (employee_id);

create table if not exists contributions (
  id text primary key,
  seq bigint generated always as identity,
  employee_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists contributions_employee_idx on contributions (employee_id);

create table if not exists manager_records (
  id text primary key,
  seq bigint generated always as identity,
  employee_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists manager_records_employee_idx on manager_records (employee_id);

-- Annual Data Load: one row per committed upload in the active cycle ...
create table if not exists upload_batches (
  id text primary key,
  file_name text not null,
  cycle_label text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by text not null,
  uploaded_by_user uuid references users(id) on delete set null,
  row_count int not null,
  created_count int not null,
  updated_count int not null,
  flagged_count int not null,
  duplicate_count int not null
);

-- ... and, per batch, which employees it created and the exact pre-upload record of each one it
-- updated, so removing the batch can undo it.
create table if not exists upload_batch_items (
  batch_id text not null references upload_batches(id) on delete cascade,
  employee_id text not null,
  kind text not null check (kind in ('created', 'updated')),
  before jsonb,
  primary key (batch_id, employee_id)
);

-- Read-only snapshot of a finished cycle.
create table if not exists archives (
  id text primary key,
  cycle_label text not null,
  archived_at timestamptz not null default now(),
  archived_by text not null,
  employee_count int not null,
  snapshot jsonb not null
);

-- Org-wide audit trail.
create table if not exists audit_log (
  id text primary key,
  seq bigint generated always as identity,
  ts timestamptz not null default now(),
  user_name text,
  user_id uuid references users(id) on delete set null,
  employee_id text,
  employee_name text,
  entity text,
  field text,
  old_value jsonb,
  new_value jsonb,
  action text
);
create index if not exists audit_log_ts_idx on audit_log (ts desc);
