# Auth Plan B — Admin console: signup approval, session dashboard, global engine defaults

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give approved admins a `/console` area (web, and opened from the desktop app) to approve/reject/disable signups and change roles, see session data aggregated from existing tables, set global caption-engine defaults, and switch off the legacy password login.

**Architecture:** Everything in the console runs through `security definer` RPCs granted to `service_role` only, called from Next.js route handlers guarded by a new `requireAdmin(request)` (which reuses Plan A's `requireHost` + `SupabaseProfileStore.readByHostId`). The console pages are client components under `app/console/*` behind a server layout that redirects non-admins to `/admin`. Global engine defaults live in a singleton row, are exposed through `/api/live-config`, and seed new Live Call sessions on both the web host and the desktop; they never touch a running session (hot swap is Plan 2).

**Tech Stack:** Next.js 15 App Router, zod 4, Supabase Postgres RPCs, `packages/caption-core/caption-engine-catalog.js` (SSOT for engine choices), Electron main + `public/subtitle-workspace.js` for the desktop "콘솔" entry point, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-02-auth-approval-admin-console-design.md` (sections 1 remaining RPCs, 4, 5, 6, 7, 8). **Prerequisite:** Plan A (`2026-09-02-auth-plan-a-identity-login-desktop.md`) is complete — this plan imports `SupabaseProfileStore`, `ProfileRecord`, `assertHostApproved`, `requireHost`, and the `profiles` / `profile_events` tables.

## Global Constraints

Same as Plan A (working tree is the runtime truth; stage only touched files; no secrets in code, logs, or tests; additive migrations mirrored byte-for-byte into `supabase/bootstrap-new-project.sql`; RPC revoke/grant pattern; new webapp tests registered in `test:live`; ko/en/ja copy via `useSystemText`; SVG icons; ≥44 px targets; keep focus rings). Additional:

- Console RPC invariants are enforced **in SQL**: `LAST_ADMIN_PROTECTED` (refuse to demote/disable/reject the last `approved` admin), `SELF_CHANGE_FORBIDDEN` (an admin cannot change their own status or role), status transitions only `pending→approved|rejected`, `approved→disabled`, `disabled→approved`, `rejected→approved`.
- Engine defaults are validated with `normalizeEngineSelection` from the catalog before storage and again on read; an unreadable stored value falls back to `DEFAULT_ENGINE_SELECTION`.
- Deviations from spec §2/§5, decided here: (1) the `/console` guard runs in `app/console/layout.tsx` (server component) instead of middleware, because middleware would need a Supabase round-trip on every request; middleware keeps the existing cookie gate. (2) Spec's `approve_profile_v1` / `reject_profile_v1` / `set_profile_status_v1` collapse into one `set_profile_status_v1(p_actor_id, p_profile_id, p_status, p_reason)` that writes the matching `profile_events.action` (`approve`, `reject`, `disable`, `enable`).

---

## File map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/202609020003_console_rpcs.sql` | `engine_defaults`, `console_settings` singletons; RPCs `list_profiles_admin_v1`, `count_pending_profiles_v1`, `set_profile_status_v1`, `set_profile_role_v1`, `list_sessions_admin_v1`, `read_console_settings_v1`, `set_engine_defaults_v1`, `set_legacy_password_login_v1` |
| `test/console-rpcs-sql.test.js` | additive + bootstrap mirror + PGlite invariants |
| `webapp/lib/console/console-store.ts` (+ test) | typed RPC wrappers |
| `webapp/lib/console/engine-defaults.ts` (+ test) | normalize/validate stored engine defaults against the catalog; derive `modelPreferences` seed |
| `webapp/lib/auth/require-admin.ts` (+ test) | `requireAdmin(request)` → `{ hostId, profile }` or `AuthorizationError` |
| `webapp/app/api/console/users/route.ts` | `GET` list, `PATCH` status/role |
| `webapp/app/api/console/sessions/route.ts` | `GET ?range=7d|30d|all` |
| `webapp/app/api/console/engine-defaults/route.ts` | `GET`, `PUT` |
| `webapp/app/api/console/settings/route.ts` | `GET`, `PUT { legacyPasswordLoginEnabled }` |
| `webapp/lib/console/console-routes.test.ts` | route contract tests (source + handler tests with fetch fakes) |
| `webapp/app/api/login/route.ts` | refuse when legacy login is disabled |
| `webapp/app/api/live-config/route.ts` | add `engineDefaults` |
| `webapp/lib/live/service.ts` | seed `modelPreferences` from engine defaults when omitted |
| `webapp/lib/system-language/console-messages.ts` | ko/en/ja copy |
| `webapp/app/console/layout.tsx`, `page.tsx`, `users/page.tsx`, `sessions/page.tsx`, `engine/page.tsx` | pages |
| `webapp/components/console/ConsoleShell.tsx`, `UsersPanel.tsx`, `SessionsPanel.tsx`, `EnginePanel.tsx`, `ConfirmDialog.tsx`, `console-model.ts` (+ tests) | UI |
| `webapp/components/live/LiveHostDashboard.tsx`, `webapp/components/auth/host-session-pages.ts` | "콘솔" nav link for admins; session keeper covers `/console/*` |
| `webapp/app/globals.css` | `.console-*` styles |
| `electron/main.js`, `electron/preload.js`, `public/subtitle-workspace.js`, `public/subtitle.html`, `public/subtitle-i18n.js`, `public/subtitle-i18n-ja.js` | desktop "콘솔" button + window; engine defaults seed for Live Call create |
| `test/desktop-console-window.test.js`, `test/host-session-ui.test.js` | root tests |

---

### Task 1: Migration — console singletons and RPCs

**Files:**
- Create: `supabase/migrations/202609020003_console_rpcs.sql`, `test/console-rpcs-sql.test.js`
- Modify: `supabase/bootstrap-new-project.sql` (append verbatim)

**Interfaces (produced):**

```sql
list_profiles_admin_v1(p_status text, p_limit integer, p_before timestamptz)
  returns table (id uuid, email text, display_name text, status text, role text, host_id text, created_at timestamptz, last_login_at timestamptz, approved_at timestamptz)
count_pending_profiles_v1() returns integer
set_profile_status_v1(p_actor_id uuid, p_profile_id uuid, p_status text, p_reason text) returns table (id uuid, status text, role text)   -- raises LAST_ADMIN_PROTECTED / SELF_CHANGE_FORBIDDEN / INVALID_TRANSITION / PROFILE_NOT_FOUND
set_profile_role_v1(p_actor_id uuid, p_profile_id uuid, p_role text) returns table (id uuid, status text, role text)                      -- same guards
list_sessions_admin_v1(p_since timestamptz, p_limit integer)
  returns table (id uuid, title text, host_id text, host_email text, mode text, status text, languages text[], created_at timestamptz, ended_at timestamptz,
                 utterance_count bigint, participant_count bigint, summary_status text)
read_console_settings_v1() returns table (legacy_password_login_enabled boolean, engine jsonb, engine_updated_at timestamptz, engine_updated_by_email text)
set_engine_defaults_v1(p_actor_id uuid, p_engine jsonb) returns boolean
set_legacy_password_login_v1(p_actor_id uuid, p_enabled boolean) returns boolean
```

- [ ] **Step 1: Write the failing test**

```js
// test/console-rpcs-sql.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020003_console_rpcs.sql';
const profilesMigration = '202609020002_auth_profiles_desktop_codes.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
const FUNCTIONS = ['list_profiles_admin_v1', 'count_pending_profiles_v1', 'set_profile_status_v1', 'set_profile_role_v1', 'list_sessions_admin_v1', 'read_console_settings_v1', 'set_engine_defaults_v1', 'set_legacy_password_login_v1'];

test('console migration is additive, service-role only, mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from|grant select)\b/iu);
  for (const fn of FUNCTIONS) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'));
  }
  assert.match(sql, /alter table public\.engine_defaults enable row level security/u);
  assert.match(sql, /alter table public\.console_settings enable row level security/u);
});

test('console RPCs enforce transitions, last-admin and self-change protection, and aggregate sessions', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table public.live_sessions(id uuid primary key, host_id text not null, title text, mode text, status text, languages text[], created_at timestamptz default now(), ended_at timestamptz, archive_deleted_at timestamptz);
    create table public.live_utterances(id uuid primary key, session_id uuid, language text, seq bigint);
    create table public.live_participants(id uuid primary key, session_id uuid, user_id text);
    create table public.live_summary_generation_jobs(session_id uuid, language text, status text, error_code text, primary key (session_id, language));`);
  await db.exec(await readMigration(profilesMigration));
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name));
  const admin = '00000000-0000-4000-8000-000000000011', second = '00000000-0000-4000-8000-000000000022', guest = '00000000-0000-4000-8000-000000000033';
  for (const id of [admin, second, guest]) await db.query('insert into auth.users values($1)', [id]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [admin, 'admin@x.io', 'Admin', true, 'noel']);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [second, 'second@x.io', null, false, null]);
  await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [guest, 'guest@x.io', null, false, null]);
  assert.equal((await db.query('select public.count_pending_profiles_v1() as n')).rows[0].n, 2);
  const pendingList = (await db.query('select * from public.list_profiles_admin_v1($1,$2,$3)', ['pending', 50, null])).rows;
  assert.deepEqual(pendingList.map((r) => r.email).sort(), ['guest@x.io', 'second@x.io']);
  // approve second, then promote to admin
  assert.equal((await db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [admin, second, 'approved', null])).rows[0].status, 'approved');
  assert.equal((await db.query('select * from public.set_profile_role_v1($1,$2,$3)', [admin, second, 'admin'])).rows[0].role, 'admin');
  // reject guest with reason; rejected -> approved allowed; approved -> pending NOT allowed
  await db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [admin, guest, 'rejected', 'duplicate']);
  await assert.rejects(db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [admin, second, 'pending', null]), /INVALID_TRANSITION/u);
  // self change forbidden
  await assert.rejects(db.query('select * from public.set_profile_role_v1($1,$2,$3)', [admin, admin, 'host']), /SELF_CHANGE_FORBIDDEN/u);
  // last admin protected: demote second (ok, admin remains), then try to disable admin from second -> second is host now -> still SELF/LAST rules apply via admin only
  await db.query('select * from public.set_profile_role_v1($1,$2,$3)', [admin, second, 'host']);
  await assert.rejects(db.query('select * from public.set_profile_status_v1($1,$2,$3,$4)', [second, admin, 'disabled', null]), /LAST_ADMIN_PROTECTED|SELF_CHANGE_FORBIDDEN|ACTOR_NOT_ADMIN/u);
  const events = (await db.query('select action, reason from public.profile_events order by id')).rows;
  assert.deepEqual(events.map((e) => e.action), ['bootstrap_admin', 'signup', 'signup', 'approve', 'set_role', 'reject', 'set_role']);
  assert.equal(events.find((e) => e.action === 'reject').reason, 'duplicate');
  // settings + engine defaults
  const initial = (await db.query('select * from public.read_console_settings_v1()')).rows[0];
  assert.equal(initial.legacy_password_login_enabled, true); assert.equal(initial.engine, null);
  assert.equal((await db.query('select public.set_engine_defaults_v1($1,$2::jsonb) as ok', [admin, JSON.stringify({ stt: { provider: 'gemini', model: 'gemini-3.5-transcribe-live', languageMode: 'auto' } })])).rows[0].ok, true);
  assert.equal((await db.query('select public.set_legacy_password_login_v1($1,$2) as ok', [admin, false])).rows[0].ok, true);
  const after = (await db.query('select * from public.read_console_settings_v1()')).rows[0];
  assert.equal(after.legacy_password_login_enabled, false); assert.equal(after.engine.stt.provider, 'gemini'); assert.equal(after.engine_updated_by_email, 'admin@x.io');
  await assert.rejects(db.query('select public.set_engine_defaults_v1($1,$2::jsonb)', [second, '{}']), /ACTOR_NOT_ADMIN/u);
  // sessions aggregate
  const s1 = '00000000-0000-4000-8000-0000000000a1';
  await db.query(`insert into public.live_sessions(id,host_id,title,mode,status,languages,ended_at) values($1,'noel','Kickoff','meeting','stopped','{ko,en}',now())`, [s1]);
  await db.query(`insert into public.live_utterances values(gen_random_uuid(),$1,'ko',1),(gen_random_uuid(),$1,'en',1),(gen_random_uuid(),$1,'ko',2)`, [s1]);
  await db.query(`insert into public.live_participants values(gen_random_uuid(),$1,'u1'),(gen_random_uuid(),$1,'u2')`, [s1]);
  await db.query(`insert into public.live_summary_generation_jobs values($1,'ko','failed','SUMMARY_TIMEOUT')`, [s1]);
  const sessions = (await db.query('select * from public.list_sessions_admin_v1($1,$2)', [null, 50])).rows;
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].host_email, Number(sessions[0].utterance_count), Number(sessions[0].participant_count), sessions[0].summary_status], ['admin@x.io', 3, 2, 'failed']);
});
```

- [ ] **Step 2: Run it (expect ENOENT), then write the migration**

```sql
-- 2026-09-02 console: admin-only RPCs for signup approval, roles, session aggregates,
-- global engine defaults, and the legacy password-login switch. All guards live here.
create table if not exists public.engine_defaults (
  id smallint primary key default 1 check (id = 1),
  engine jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create table if not exists public.console_settings (
  id smallint primary key default 1 check (id = 1),
  legacy_password_login_enabled boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.console_settings (id) values (1) on conflict (id) do nothing;
alter table public.engine_defaults enable row level security;
alter table public.console_settings enable row level security;
revoke all on table public.engine_defaults, public.console_settings from anon, authenticated;

create or replace function public.assert_console_admin_v1(p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_actor_id is null or not exists (select 1 from public.profiles p where p.id = p_actor_id and p.status = 'approved' and p.role = 'admin') then
    raise exception 'ACTOR_NOT_ADMIN' using errcode = '42501';
  end if;
end; $$;
revoke all on function public.assert_console_admin_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.assert_console_admin_v1(uuid) to service_role;

create or replace function public.list_profiles_admin_v1(p_status text, p_limit integer, p_before timestamptz)
returns table (id uuid, email text, display_name text, status text, role text, host_id text, created_at timestamptz, last_login_at timestamptz, approved_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select p.id, p.email, p.display_name, p.status, p.role, p.host_id, p.created_at, p.last_login_at, p.approved_at
  from public.profiles p
  where (p_status is null or p.status = p_status) and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.list_profiles_admin_v1(text,integer,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.list_profiles_admin_v1(text,integer,timestamptz) to service_role;

create or replace function public.count_pending_profiles_v1() returns integer
language sql security definer set search_path = '' stable as $$
  select count(*)::integer from public.profiles p where p.status = 'pending';
$$;
revoke all on function public.count_pending_profiles_v1() from public, anon, authenticated, service_role;
grant execute on function public.count_pending_profiles_v1() to service_role;

create or replace function public.set_profile_status_v1(p_actor_id uuid, p_profile_id uuid, p_status text, p_reason text)
returns table (id uuid, status text, role text)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype; action_name text;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_actor_id = p_profile_id then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501'; end if;
  select * into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not ((target.status = 'pending' and p_status in ('approved','rejected'))
       or (target.status = 'approved' and p_status = 'disabled')
       or (target.status = 'disabled' and p_status = 'approved')
       or (target.status = 'rejected' and p_status = 'approved')) then
    raise exception 'INVALID_TRANSITION' using errcode = '22023';
  end if;
  if target.role = 'admin' and target.status = 'approved' and p_status <> 'approved'
     and (select count(*) from public.profiles p where p.role = 'admin' and p.status = 'approved') <= 1 then
    raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501';
  end if;
  action_name := case p_status when 'approved' then (case when target.status = 'disabled' then 'enable' else 'approve' end)
                               when 'rejected' then 'reject' when 'disabled' then 'disable' end;
  update public.profiles p set status = p_status,
    approved_at = case when p_status = 'approved' then statement_timestamp() else p.approved_at end,
    approved_by = case when p_status = 'approved' then p_actor_id else p.approved_by end,
    updated_at = statement_timestamp()
  where p.id = p_profile_id;
  insert into public.profile_events (profile_id, actor_id, action, reason) values (p_profile_id, p_actor_id, action_name, nullif(left(btrim(coalesce(p_reason,'')),200), ''));
  return query select p.id, p.status, p.role from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.set_profile_status_v1(uuid,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_status_v1(uuid,uuid,text,text) to service_role;

create or replace function public.set_profile_role_v1(p_actor_id uuid, p_profile_id uuid, p_role text)
returns table (id uuid, status text, role text)
language plpgsql security definer set search_path = '' as $$
declare target public.profiles%rowtype;
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_actor_id = p_profile_id then raise exception 'SELF_CHANGE_FORBIDDEN' using errcode = '42501'; end if;
  if p_role not in ('host','admin') then raise exception 'INVALID_ROLE' using errcode = '22023'; end if;
  select * into target from public.profiles p where p.id = p_profile_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  if target.role = 'admin' and p_role = 'host' and target.status = 'approved'
     and (select count(*) from public.profiles p where p.role = 'admin' and p.status = 'approved') <= 1 then
    raise exception 'LAST_ADMIN_PROTECTED' using errcode = '42501';
  end if;
  update public.profiles p set role = p_role, updated_at = statement_timestamp() where p.id = p_profile_id;
  insert into public.profile_events (profile_id, actor_id, action, payload) values (p_profile_id, p_actor_id, 'set_role', jsonb_build_object('from', target.role, 'to', p_role));
  return query select p.id, p.status, p.role from public.profiles p where p.id = p_profile_id;
end; $$;
revoke all on function public.set_profile_role_v1(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_profile_role_v1(uuid,uuid,text) to service_role;

create or replace function public.list_sessions_admin_v1(p_since timestamptz, p_limit integer)
returns table (id uuid, title text, host_id text, host_email text, mode text, status text, languages text[], created_at timestamptz, ended_at timestamptz,
               utterance_count bigint, participant_count bigint, summary_status text)
language sql security definer set search_path = '' stable as $$
  select s.id, s.title, s.host_id, p.email, s.mode, s.status, s.languages, s.created_at, s.ended_at,
    (select count(*) from public.live_utterances u where u.session_id = s.id),
    (select count(distinct lp.user_id) from public.live_participants lp where lp.session_id = s.id),
    (select case when bool_or(j.status = 'failed') then 'failed' when bool_and(j.status = 'succeeded') then 'succeeded'
                 when count(*) = 0 then null else 'running' end
       from public.live_summary_generation_jobs j where j.session_id = s.id)
  from public.live_sessions s
  left join public.profiles p on p.host_id = s.host_id
  where s.archive_deleted_at is null and (p_since is null or s.created_at >= p_since)
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;
revoke all on function public.list_sessions_admin_v1(timestamptz,integer) from public, anon, authenticated, service_role;
grant execute on function public.list_sessions_admin_v1(timestamptz,integer) to service_role;

create or replace function public.read_console_settings_v1()
returns table (legacy_password_login_enabled boolean, engine jsonb, engine_updated_at timestamptz, engine_updated_by_email text)
language sql security definer set search_path = '' stable as $$
  select c.legacy_password_login_enabled, e.engine, e.updated_at, p.email
  from public.console_settings c
  left join public.engine_defaults e on e.id = 1
  left join public.profiles p on p.id = e.updated_by
  where c.id = 1;
$$;
revoke all on function public.read_console_settings_v1() from public, anon, authenticated, service_role;
grant execute on function public.read_console_settings_v1() to service_role;

create or replace function public.set_engine_defaults_v1(p_actor_id uuid, p_engine jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  if p_engine is null or jsonb_typeof(p_engine) <> 'object' or octet_length(p_engine::text) > 4000 then raise exception 'ENGINE_INVALID' using errcode = '22023'; end if;
  insert into public.engine_defaults (id, engine, updated_by, updated_at) values (1, p_engine, p_actor_id, statement_timestamp())
  on conflict (id) do update set engine = excluded.engine, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.profile_events (profile_id, actor_id, action, payload) values (p_actor_id, p_actor_id, 'engine_defaults', p_engine);
  return true;
end; $$;
revoke all on function public.set_engine_defaults_v1(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_engine_defaults_v1(uuid,jsonb) to service_role;

create or replace function public.set_legacy_password_login_v1(p_actor_id uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_console_admin_v1(p_actor_id);
  update public.console_settings c set legacy_password_login_enabled = coalesce(p_enabled, true), updated_by = p_actor_id, updated_at = statement_timestamp() where c.id = 1;
  return found;
end; $$;
revoke all on function public.set_legacy_password_login_v1(uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_legacy_password_login_v1(uuid,boolean) to service_role;
```

Note: `set_profile_status_v1` uses a `case` for `action_name`; the `profile_events` action check already allows `approve|reject|disable|enable`. If the PGlite run fails on `bool_or` over an empty set, replace the summary subquery with a `case when not exists(...) then null ...` form.

- [ ] **Step 3: Append to bootstrap, run the test (both modes), commit**

```bash
printf '\n-- supabase/migrations/202609020003_console_rpcs.sql\n\n' >> supabase/bootstrap-new-project.sql && cat supabase/migrations/202609020003_console_rpcs.sql >> supabase/bootstrap-new-project.sql
node --test test/console-rpcs-sql.test.js
git add supabase/migrations/202609020003_console_rpcs.sql supabase/bootstrap-new-project.sql test/console-rpcs-sql.test.js
git commit -m "feat(console): admin RPCs for signup approval, roles, session aggregates, engine defaults, legacy login switch"
```

---

### Task 2: `ConsoleStore`, `requireAdmin`, engine-defaults helper

**Files:**
- Create: `webapp/lib/console/console-store.ts`, `webapp/lib/console/console-store.test.ts`, `webapp/lib/console/engine-defaults.ts`, `webapp/lib/console/engine-defaults.test.ts`, `webapp/lib/auth/require-admin.ts`, `webapp/lib/auth/require-admin.test.ts`
- Modify: `webapp/package.json` (`test:live`)

**Interfaces (produced):**

```ts
// console-store.ts
export interface ConsoleProfileRow extends ProfileRecord { createdAt: string; lastLoginAt: string | null; approvedAt: string | null }
export interface ConsoleSessionRow { id: string; title: string | null; hostId: string; hostEmail: string | null; mode: string; status: string; languages: string[]; createdAt: string; endedAt: string | null; utteranceCount: number; participantCount: number; summaryStatus: "failed" | "succeeded" | "running" | null }
export interface ConsoleSettings { legacyPasswordLoginEnabled: boolean; engine: unknown; engineUpdatedAt: string | null; engineUpdatedByEmail: string | null }
export class ConsoleStoreError extends Error { code: string; status: number }   // maps SQL messages ACTOR_NOT_ADMIN→403, SELF_CHANGE_FORBIDDEN→403, LAST_ADMIN_PROTECTED→409, INVALID_TRANSITION→409, PROFILE_NOT_FOUND→404, else 503 CONSOLE_STORE_UNAVAILABLE
export class SupabaseConsoleStore {
  constructor(deps?: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess });
  listProfiles(input: { status?: ProfileStatus; limit?: number; before?: string }): Promise<ConsoleProfileRow[]>;
  countPending(): Promise<number>;
  setProfileStatus(input: { actorId: string; profileId: string; status: Exclude<ProfileStatus, "pending">; reason?: string }): Promise<{ id: string; status: ProfileStatus; role: ProfileRole }>;
  setProfileRole(input: { actorId: string; profileId: string; role: ProfileRole }): Promise<{ id: string; status: ProfileStatus; role: ProfileRole }>;
  listSessions(input: { since?: string; limit?: number }): Promise<ConsoleSessionRow[]>;
  readSettings(): Promise<ConsoleSettings>;
  setEngineDefaults(input: { actorId: string; engine: EngineSelection }): Promise<void>;
  setLegacyPasswordLogin(input: { actorId: string; enabled: boolean }): Promise<void>;
}
// engine-defaults.ts
export type EngineSelection = ReturnType<typeof normalizeEngineSelection>;   // from packages/caption-core/caption-engine-catalog.js
export function readStoredEngineDefaults(value: unknown): EngineSelection;    // normalizeEngineSelection or DEFAULT_ENGINE_SELECTION on failure
export function engineDefaultsToModelPreferences(engine: EngineSelection): { source: string; summary: string }; // gemini stt model → source, else catalog default source; summary → engine.summary.model
export const consoleSettingsCache: { get(): Promise<ConsoleSettings>; invalidate(): void };  // 60 s, module singleton, falls back to { legacyPasswordLoginEnabled: true, engine: null, ... } when Supabase env is unconfigured
// require-admin.ts
export async function requireAdmin(request: Pick<NextRequest, "cookies">): Promise<{ hostId: string; profile: ProfileRecord }>; // requireHost → SupabaseProfileStore.readByHostId → role==="admin" && status==="approved" else throw AuthorizationError
```

- [ ] **Step 1: Failing tests** — mirror Plan A's fetch-fake style. Required cases:
  - `console-store.test.ts`: `listProfiles` sends `{ p_status, p_limit, p_before }` and maps snake_case; `setProfileStatus` maps `LAST_ADMIN_PROTECTED` (PostgREST returns `{ "message": "LAST_ADMIN_PROTECTED", "code": "42501" }` with HTTP 403) to `ConsoleStoreError{ code: "LAST_ADMIN_PROTECTED", status: 409 }`; `setEngineDefaults` sends `p_engine` as the normalized object; `readSettings` maps nulls.
  - `engine-defaults.test.ts`: `readStoredEngineDefaults(null)` equals `DEFAULT_ENGINE_SELECTION`; a Soniox stt selection maps `source` to the catalog's default Gemini source; a valid Gemini selection round-trips; garbage falls back without throwing.
  - `require-admin.test.ts`: uses `__setProfileReaderForTests` from Plan A to inject profiles; admin+approved passes; host role → `AuthorizationError`; missing profile (legacy) → `AuthorizationError`; no cookie → `AuthenticationError`.
- [ ] **Step 2: Register + run (expect failure); implement**

`console-store.ts` follows `SupabaseProfileStore.rpc` exactly (copy the private `rpc` helper; do not import it). Error mapping:

```ts
function mapRpcFailure(status: number, body: unknown): ConsoleStoreError {
  const message = typeof (body as { message?: unknown })?.message === "string" ? (body as { message: string }).message : "";
  const known: Record<string, [string, number]> = {
    ACTOR_NOT_ADMIN: ["관리자 권한이 필요합니다.", 403], SELF_CHANGE_FORBIDDEN: ["자기 자신의 상태나 역할은 바꿀 수 없습니다.", 403],
    LAST_ADMIN_PROTECTED: ["마지막 관리자는 강등하거나 비활성화할 수 없습니다.", 409], INVALID_TRANSITION: ["허용되지 않은 상태 변경입니다.", 409],
    PROFILE_NOT_FOUND: ["사용자를 찾을 수 없습니다.", 404], INVALID_ROLE: ["역할 값이 올바르지 않습니다.", 400], ENGINE_INVALID: ["엔진 설정이 올바르지 않습니다.", 400],
  };
  const hit = Object.keys(known).find((k) => message.startsWith(k));
  return hit ? new ConsoleStoreError(known[hit][0], hit, known[hit][1]) : new ConsoleStoreError("콘솔 저장소를 사용할 수 없습니다.", "CONSOLE_STORE_UNAVAILABLE", 503);
}
```

`engine-defaults.ts`:

```ts
import { DEFAULT_ENGINE_SELECTION, normalizeEngineSelection } from "../../../packages/caption-core/caption-engine-catalog.js";
import { readGeminiSelectedModel } from "../../../packages/caption-core/gemini-model-catalog.js";
export type EngineSelection = ReturnType<typeof normalizeEngineSelection>;
export function readStoredEngineDefaults(value: unknown): EngineSelection {
  try { return normalizeEngineSelection(value ?? DEFAULT_ENGINE_SELECTION); } catch { return normalizeEngineSelection(DEFAULT_ENGINE_SELECTION); }
}
export function engineDefaultsToModelPreferences(engine: EngineSelection): { source: string; summary: string } {
  const source = engine.stt.provider === "gemini" ? engine.stt.model : readGeminiSelectedModel("source", undefined);
  return { source: readGeminiSelectedModel("source", source), summary: readGeminiSelectedModel("summary", engine.summary.model) };
}
```

Check the exact shape `normalizeEngineSelection` returns (`{ stt: { provider, model, languageMode }, translation: {...}, summary: {...} }`) in `packages/caption-core/caption-engine-catalog.js:87` and type accordingly. `consoleSettingsCache` is a 60 s memo over `new SupabaseConsoleStore().readSettings()` that returns `{ legacyPasswordLoginEnabled: true, engine: null, engineUpdatedAt: null, engineUpdatedByEmail: null }` when the store throws `LiveSecurityConfigurationError` (unconfigured env) and rethrows other errors only if there is no previous value.

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add webapp/lib/console/console-store.ts webapp/lib/console/console-store.test.ts webapp/lib/console/engine-defaults.ts webapp/lib/console/engine-defaults.test.ts webapp/lib/auth/require-admin.ts webapp/lib/auth/require-admin.test.ts webapp/package.json
git commit -m "feat(console): console store, requireAdmin guard, and engine-defaults normalization"
```

---

### Task 3: Console API routes, legacy-login switch, `/api/live-config` engine defaults, session creation seed

**Files:**
- Create: `webapp/app/api/console/users/route.ts`, `webapp/app/api/console/sessions/route.ts`, `webapp/app/api/console/engine-defaults/route.ts`, `webapp/app/api/console/settings/route.ts`, `webapp/lib/console/console-routes.test.ts`
- Modify: `webapp/app/api/login/route.ts`, `webapp/app/api/live-config/route.ts`, `webapp/lib/live/service.ts` (create path), `webapp/app/api/live-sessions/route.ts` (pass defaults), `webapp/lib/live/live-service.test.ts` (new case), `webapp/package.json`

**Route contracts (consumed by Task 4 and the desktop):**
- `GET /api/console/users?status=pending|approved|rejected|disabled&before=<iso>` → `{ ok, data: { profiles: ConsoleProfileRow[], pendingCount } }`
- `PATCH /api/console/users` body `{ profileId, status?: "approved"|"rejected"|"disabled", reason?: string ≤200, role?: "host"|"admin" }` (exactly one of `status`/`role`) → `{ ok, data: { id, status, role } }`; errors pass through `ConsoleStoreError` status/code.
- `GET /api/console/sessions?range=7d|30d|all` → `{ ok, data: { sessions: ConsoleSessionRow[], summary: { today, live, utterances7d, summaryFailures } } }` (summary computed in the route from the rows: `today` = createdAt on the server's current UTC date, `live` = status "live", `utterances7d` = sum of utteranceCount for createdAt within 7 days, `summaryFailures` = count summaryStatus "failed").
- `GET /api/console/engine-defaults` → `{ ok, data: { engine, catalog: captionEngineCatalogForClient({ hasApiKeys: { gemini: true, soniox: Boolean(process.env.SONIOX_API_KEY) } }), updatedAt, updatedByEmail } }`; `PUT { engine }` → validates with `normalizeEngineSelection` (400 `ENGINE_INVALID`) → `setEngineDefaults` → `consoleSettingsCache.invalidate()`.
- `GET /api/console/settings` → `{ ok, data: { legacyPasswordLoginEnabled } }`; `PUT { legacyPasswordLoginEnabled: boolean }` → refuses `false` unless at least one approved admin exists **other than the actor** or the actor signed in via Supabase (i.e. `profile.hostId !== legacy host id` — simplest: refuse when `readBootstrapAdminConfig().legacyHostId === profile.hostId && !profile.email` never true; instead refuse only when `countPending`… keep it simple: allow, but the console UI shows a confirm dialog explaining that `noel`/password will stop working).
- All routes: `assertStrictOrigin` for mutating methods (middleware already does), `requireAdmin`, `AuthenticationError` → 401, `AuthorizationError` → 403 `ADMIN_REQUIRED`, `ConsoleStoreError` → its status/code, `cache-control: private, no-store`.
- `/api/login`: after config parsing, `const settings = await consoleSettingsCache.get(); if (!settings.legacyPasswordLoginEnabled) return apiError("비밀번호 로그인이 비활성화되었습니다. Google 또는 이메일 로그인을 사용해 주세요.", "LEGACY_LOGIN_DISABLED", 403);`
- `/api/live-config`: `{ gatewayUrl, engineDefaults: readStoredEngineDefaults((await consoleSettingsCache.get()).engine) }`.
- `LiveSessionService.create(hostId, input, options?: { engineDefaults?: EngineSelection })`: when `input.modelPreferences === undefined`, use `readNewLiveModelPreferences(engineDefaultsToModelPreferences(options.engineDefaults))` instead of catalog defaults. `POST /api/live-sessions` passes `{ engineDefaults: readStoredEngineDefaults((await consoleSettingsCache.get()).engine) }`.

- [ ] **Step 1: Failing tests** in `console-routes.test.ts`: (a) source-regex: every console route imports and calls `requireAdmin`; `PATCH users` rejects bodies with both or neither of `status`/`role`; `login/route.ts` contains `LEGACY_LOGIN_DISABLED`; `live-config/route.ts` contains `engineDefaults`. (b) Handler test for `GET /api/console/sessions` using a fake store injected through a module-level `__setConsoleStoreForTests` seam (add it to `console-store.ts` like Plan A's reader seam): 3 rows → summary numbers correct. (c) `live-service.test.ts`: `create` with `modelPreferences` undefined and `engineDefaults` whose summary is `gemini-3.7-flash` stores `summary: "gemini-3.7-flash"`.
- [ ] **Step 2: Implement routes** — one file each, following `webapp/app/api/live-records/route.ts` for the try/catch shape (`AuthenticationError` → 401). Zod schemas:

```ts
const patchUserSchema = z.object({
  profileId: z.string().uuid(),
  status: z.enum(["approved", "rejected", "disabled"]).optional(),
  reason: z.string().trim().max(200).optional(),
  role: z.enum(["host", "admin"]).optional(),
}).strict().refine((v) => (v.status ? 1 : 0) + (v.role ? 1 : 0) === 1, "status 또는 role 중 하나만 지정합니다.");
const rangeSchema = z.enum(["7d", "30d", "all"]).default("7d");
const putEngineSchema = z.object({ engine: z.unknown() }).strict();
const putSettingsSchema = z.object({ legacyPasswordLoginEnabled: z.boolean() }).strict();
```

- [ ] **Step 3: Run `npm --prefix webapp test`, typecheck, commit**

```bash
git add webapp/app/api/console webapp/lib/console/console-routes.test.ts webapp/lib/console/console-store.ts webapp/app/api/login/route.ts webapp/app/api/live-config/route.ts webapp/lib/live/service.ts webapp/app/api/live-sessions/route.ts webapp/lib/live/live-service.test.ts webapp/package.json
git commit -m "feat(console): admin API routes, legacy login switch, and engine defaults seeding new live sessions"
```

---

### Task 4: Console UI (`/console/users`, `/console/sessions`, `/console/engine`) and the admin nav link

**Files:**
- Create: `webapp/lib/system-language/console-messages.ts`, `webapp/components/console/console-model.ts` (+ `console-model.test.ts`), `ConsoleShell.tsx`, `UsersPanel.tsx`, `SessionsPanel.tsx`, `EnginePanel.tsx`, `ConfirmDialog.tsx`, `webapp/components/console/console-layout.test.ts`, `webapp/app/console/layout.tsx`, `webapp/app/console/page.tsx`, `webapp/app/console/users/page.tsx`, `webapp/app/console/sessions/page.tsx`, `webapp/app/console/engine/page.tsx`
- Modify: `webapp/app/globals.css`, `webapp/components/live/LiveHostDashboard.tsx:1798-1806`, `webapp/components/auth/host-session-pages.ts`, `webapp/components/live/host-surface.test.ts` (if the rail assertion counts links), `webapp/package.json`

**Design contract (from spec §5 + ui-ux-pro-max rules):**
- `ConsoleShell`: `main.live-host-shell` + `aside.live-host-rail` (reuse the NOVA dark tokens, `glass` cards, existing rail button/link rules that already enforce ≥44 px) with nav items 사용자 (badge with pending count) · 세션 · 엔진, `aria-current="page"` on the active one, and a "라이브로" link back to `/admin`. Below 1024 px the rail becomes a top tab bar (`@media (max-width: 1023px) { .live-host-rail nav { flex-direction: row; overflow-x: auto } }` scoped to `.console-shell`).
- `UsersPanel`: filter chips (`role="tablist"`-free plain buttons with `aria-pressed`) 대기 N · 승인 · 반려 · 비활성; table (`<table>` inside `.console-table-wrap { overflow-x: auto }`) columns 이메일 · 이름 · 가입일 · 상태 · 역할 · 마지막 로그인 · 작업; rows: pending → 승인 (primary, `live-primary-action`) + 반려 (secondary, opens reason select: 미확인 사용자 · 중복 · 기타 + optional note); approved → role `<select>` + 비활성화 (danger, confirm dialog); disabled → 재활성화; rejected → 승인. `aria-busy` per row while its request is in flight; inline error text in the row's last cell (`role="alert"`). Under 767 px each row renders as a card (`display: grid`) with the same controls. Empty state text per filter.
- `SessionsPanel`: four summary cards (오늘 세션 · 진행 중 · 7일 발언 수 · 요약 실패), range chips 7일/30일/전체, table 제목 · 호스트 · 시작/종료 · 상태 · 언어 · 발언 수 · 참여자 수 · 요약 상태; row is a link to `/records/<id>` (not a click handler on `<tr>`); numbers use `font-variant-numeric: tabular-nums`.
- `EnginePanel` (re-scoped 2026-09-04, spec §9): the primary button is **"배포"** (not "저장"); a `ConfirmDialog` says "진행 중인 세션 n개가 즉시 전환됩니다" (n from `GET /api/console/sessions?range=7d` rows with status `live`/`preparing`); after `PUT` the panel shows the per-session result table returned by Task 6 (`switched` / `queued` / `failed`); three `<select>`s (STT / 번역 / 요약) fed by `catalog` from `GET /api/console/engine-defaults`, showing `label` and disabling `available === false` options (Soniox without a key), plus 입력 언어 모드 select restricted to the STT entry's `languageModes`; combined engines (`requiresSttProvider`) filter the translation options; 저장 button disabled until dirty; "마지막 변경: <email> · <time>" line; success toast text `role="status"`; a hint line: "새 세션에만 적용됩니다. 진행 중인 세션은 바뀌지 않습니다." Also a 계정 섹션 with the legacy-login toggle (checkbox + confirm dialog when turning off).
- `ConfirmDialog`: `<dialog>` element with `showModal()`, title, body, 취소 (autofocus) and the destructive action button (`.console-danger`), `Escape` closes; used for 비활성화 and for turning legacy login off.
- `console-model.ts` pure helpers: `formatRange(range) → since ISO | null`, `summarizeSessions(rows, now)`, `filterTranslationOptions(catalog, stt)`, `languageModesFor(catalog, stt)`, `isEngineDirty(a, b)`, `statusLabelKey(status)`, `rejectReasons = ["unverified", "duplicate", "other"]`.
- Nav link in `LiveHostDashboard`: fetch `/api/auth/session` once on mount (GET, `credentials: "same-origin"`); when `data.role === "admin"` render `<a href="/console">{t("콘솔")}</a>` after 라이브콜 기록 (add `["콘솔", "Console", "コンソール"]` to `host-messages.ts`). `isHostSessionPage` returns true for `pathname.startsWith("/console")`.
- `app/console/layout.tsx` (server): `const { profile } = await requireAdmin({ cookies: await cookies() as unknown as NextRequest["cookies"] })` inside try/catch → `redirect("/admin")` on `AuthorizationError`, `redirect("/login")` on `AuthenticationError`; renders `<ConsoleShell pendingCount={…} email={profile.email}>{children}</ConsoleShell>`. If `cookies()` cannot be adapted to the `Pick<NextRequest,"cookies">` shape, add `requireAdminFromCookieValue(token: string | undefined)` to `require-admin.ts` and use `(await cookies()).get(SESSION_COOKIE)?.value`.

- [ ] **Step 1: Failing tests** — `console-model.test.ts` (each helper with fixed `now`), `console-layout.test.ts` (source/CSS regex: nav order and `aria-current`, `.console-table-wrap{…overflow-x:auto…}`, `<dialog`, `role="alert"` in UsersPanel, no emoji, `tabular-nums`, every message key present in ko/en/ja, `LiveHostDashboard` contains `href="/console"` guarded by `role === "admin"`, `isHostSessionPage("/console/users") === true`).
- [ ] **Step 2: Implement** the files above; every string through `t()`; all fetches `same-origin` with `Content-Type: application/json`; optimistic UI is **not** used — update rows from the server response.
- [ ] **Step 3: Verify** — `npm --prefix webapp test`, typecheck, and a dev-server pass at 375 px and 1280 px (Browser pane): rail/tabs, users table → cards, dialog focus, engine select disabling. Screenshot both.
- [ ] **Step 4: Commit**

```bash
git add webapp/app/console webapp/components/console webapp/lib/system-language/console-messages.ts webapp/lib/system-language/host-messages.ts webapp/components/live/LiveHostDashboard.tsx webapp/components/auth/host-session-pages.ts webapp/app/globals.css webapp/package.json
git commit -m "feat(console): users, sessions, and engine pages with admin-only shell and dashboard entry"
```

---

### Task 5: Desktop — "콘솔" button, console window, engine defaults seed for Live Call create

**Files:**
- Modify: `electron/main.js` (`host-session:get` result already carries `role` from Plan A's `/api/auth/session`; add `ipcMain.handle("console:open")`, `openConsoleWindow()`, Live Call create seed), `electron/preload.js` (`openConsole: () => ipcRenderer.invoke("console:open")`), `public/subtitle.html:548` area (button `id="open-live-console"` next to 로그아웃, `hidden`), `public/subtitle-workspace.js` (`acceptHostSession` shows the button when `result.data.role === "admin"`; click → `bridge.openConsole()`), `public/subtitle-i18n.js` + `public/subtitle-i18n-ja.js` (`settings.openConsole`: "콘솔" / "Console" / "コンソール")
- Create: `test/desktop-console-window.test.js`; extend `test/host-session-ui.test.js`

**Behaviour:**
- `openConsoleWindow()` creates a `BrowserWindow` (1200×800, min 480×640, `session: session.defaultSession`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload) loading `new URL("/console", resolveLiveWorkspaceUrl()).href`; `will-navigate`/`will-redirect` allow only same-origin `/console*`, `/records*`, `/admin`, `/login`; `setWindowOpenHandler` → deny + `openAllowedExternal` for http(s) targets off-origin; one window at a time (focus existing). Media permissions are not granted (the origin is the remote workspace; `configureMediaPermissions` already excludes it).
- `console:open` IPC: origin check (`isAllowedOrigin(event.sender.getURL(), new Set([localAppOrigin]))`), require `isDesktopAuthenticated`, and require the last host-session snapshot role `admin` (`desktopHostSession.getSnapshot().data?.role === "admin"`); else `{ ok: false, code: "ADMIN_REQUIRED" }`.
- Engine seed (re-scoped 2026-09-04, spec §9 — the previous `engineDefaultsSeen` rule is withdrawn): Live Call creation **always** uses the global default from `/api/live-config.engineDefaults` when present (`subtitle.engine` stays local-captions-only); the Live Call form shows the engine read-only as "관리자 지정". Original text kept for reference: in `buildLiveCallConfig` (the block at `electron/main.js:1085-1105`), before building `modelPreferences`, call `/api/live-config` through the existing `liveCallApi(baseUrl, "/api/live-config", …)` helper and, when `configResult.data.engineDefaults` parses with `normalizeEngineSelection`, use `engineDefaults.summary.model` (and `engineDefaults.stt.model` when its provider is gemini) **only if** the local `subtitleSettings.engine` equals `subtitleSettings.engineDefaultsSeen` (a new optional settings field recorded by `saveSettingsAndApply` whenever the desktop adopts a global default). Otherwise keep the local selection. Persist `engineDefaultsSeen = engineDefaults` after adopting. This implements spec §6 "로컬 값이 이전 전역 기본값과 같으면 새 기본값을 따라가고, 사용자가 바꾼 값이면 유지". Add `engineDefaultsSeen` to `src/settings-store.js` validation as an optional engine-shaped object (normalize with `normalizeEngineSelection`, drop when invalid).
- Root tests: `test/desktop-console-window.test.js` regex-pins `ipcMain.handle("console:open"`, `ADMIN_REQUIRED`, `"/console"`, `sandbox: true` in the console window options, and `engineDefaultsSeen` in the create path; `test/host-session-ui.test.js` gets a case: bridge returning `{ ok: true, data: { userId: "noel", role: "admin" } }` un-hides `open-live-console`, role `host` keeps it hidden (extend the `mount` node list with `open-live-console`).

- [ ] **Step 1: Failing tests → Step 2: implement → Step 3: `npm test`, `npm run typecheck`, `npm run desktop` smoke (button appears for an admin session; window opens `/console`) → Step 4: commit**

```bash
git add electron/main.js electron/preload.js public/subtitle.html public/subtitle-workspace.js public/subtitle-i18n.js public/subtitle-i18n-ja.js src/settings-store.js test/desktop-console-window.test.js test/host-session-ui.test.js
git commit -m "feat(desktop): console window for admins and global engine defaults seeding new Live Calls"
```

---

### Task 6: Deploy push — apply the global engine to running sessions (after Plan 2 Task 5)

**Files:**
- Modify: `webapp/app/api/console/engine-defaults/route.ts` (`PUT` → after `setEngineDefaults`, list sessions with status `preparing`/`live`, update each session's `modelPreferences.engine` + `engineHistory` through the Plan 2 Task 4 store method, then call `pushEngineToGateway` per session; respond `{ engine, results: [{ sessionId, result, code? }] }`; record `{ engine, sessionsSwitched, sessionsFailed }` in the `profile_events.engine_defaults` payload via a new store argument), `webapp/lib/console/console-store.ts` (`listActiveSessionIds()` via the existing sessions RPC filtered client-side, `setEngineDefaults` payload), `webapp/lib/live/gateway-engine-push.ts` (from Plan 2 Task 5)
- Tests: `webapp/lib/console/console-routes.test.ts` (PUT with two live sessions → two pushes, mixed results; gateway unreachable → `failed` without aborting the DB write), `console-store.test.ts`

- [ ] TDD as above; commit `feat(console): engine deploy pushes the global engine to running live sessions`.

---

### Task 7: Docs and hand-off

- [ ] Update `AGENTS.md` (Live translation architecture): one paragraph on `/console` (admin-only RPCs, `requireAdmin`, engine defaults → `/api/live-config` → new sessions only). Update `supabase/README.md` migration list with `202609020003_console_rpcs.sql`. Update memory `live-call-host-auth-contract.md` with the legacy-login switch and the last-admin rule.
- [ ] Run everything: `npm test`, `npm run typecheck`, `npm --prefix webapp test`, `npm --prefix webapp run typecheck`.
- [ ] Commit: `docs(console): admin console architecture, migration order, and operator notes`.

## Self-review

- **Spec coverage:** §1 remaining RPCs + `console_settings`/`engine_defaults` + invariants → Task 1; §4 approval/roles/events/badge → Tasks 1, 3, 4; §5 layout, users, sessions, engine pages, desktop button → Tasks 4, 5; §6 engine defaults into `/api/live-config`, web + desktop new-session seed, local-vs-global rule, no hot swap → Tasks 3, 5; §7 admin RPC guards → Task 1, `requireAdmin` → Task 2; §8 tests → each task; legacy login toggle → Tasks 1, 3, 4.
- **Placeholders:** Tasks 2–5 give exact signatures, schemas, and regex pins; component internals are described by contract because they are long JSX — the implementer must still write every handler (no `TODO`s).
- **Type consistency:** `ConsoleProfileRow` extends Plan A's `ProfileRecord` (camelCase `hostId`); `EngineSelection` is the catalog's normalized shape everywhere; `summaryStatus` union matches the SQL `case`.

## Hand-off notes

- Deploy order (needs the user's go): apply `202609020002` then `202609020003` → Vercel deploy → bootstrap admin signs in with Google → verify `/console/users` → DMG → later turn off legacy login from `/console/engine` 계정 섹션.
- Plan 2 (caption engine gateway/webapp) later replaces `modelPreferences` with `engine`; `engineDefaultsToModelPreferences` is the bridge to delete at that point.
