# Auth Plan A — Supabase Auth identity, login/signup card, approval gate, desktop deep-link login

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the env-only host login with Supabase Auth (Google + email/password) behind an admin-approval gate, keep the existing `rnw_session` cookie as the app session, and give the desktop app a system-browser Google login via a `nova://` deep link.

**Architecture:** Supabase Auth is the identity provider only. The browser signs in with `@supabase/supabase-js` (PKCE), then posts the access token to `POST /api/auth/exchange`, which verifies it server-side (`GET /auth/v1/user`), upserts a `profiles` row through a `security definer` RPC, and issues the existing HMAC cookie **only** when `profiles.status = 'approved'`. Every `requireHost` call keeps returning `{ hostId }`; the profile's `host_id` column is the string placed in the cookie, so the 34 existing `requireHost` call sites and every `host_id = eq.<hostId>` query stay unchanged. Desktop login starts Google in the system browser and returns through `nova://auth/callback?code&state`, which the main process trades for the cookie via `POST /api/auth/desktop-exchange`.

**Tech Stack:** Next.js 15 App Router (webapp), `@supabase/supabase-js` ^2.108 (already a dependency), zod 4, Supabase Postgres (`security definer` RPCs, RLS), Electron main process (`electron/main.js`), `node:test` in all three suites.

**Spec:** `docs/superpowers/specs/2026-09-02-auth-approval-admin-console-design.md` (sections 0–3, 7, 8). Plan B (`2026-09-02-auth-plan-b-admin-console.md`) covers sections 4–6 (console pages, listing RPCs, engine defaults, legacy-login toggle).

## Global Constraints

- Branch `codex/google-live-latency-20260831`. **The working tree is the runtime truth**; `npm test`, `npm --prefix webapp test`, `npm run typecheck`, `npm --prefix webapp run typecheck` on the working tree are the pass criteria. Stage only the files you touched (`git add <paths>`), never `git add -A`. Do not commit `scratch/`.
- Never print, log, echo, or commit API keys, Supabase keys, tokens, deep-link codes, or `state` values. Tests use fixture strings only (`"fixture-access-token"`, `"fixture-key"`).
- Migrations are **additive** (no `drop`, `truncate`, `delete from`, `grant select`); every new migration must also be appended to `supabase/bootstrap-new-project.sql` as `-- supabase/migrations/<file>\n\n<exact sql>` (the root SQL tests assert this byte-for-byte).
- All new RPCs: `security definer`, `set search_path = ''`, `revoke all ... from public, anon, authenticated, service_role;` then `grant execute ... to service_role;` (copy the pattern at the end of `supabase/migrations/202609010005_live_summary_configuration_retry.sql`).
- New webapp `*.test.ts` files must be appended to the `test:live` script string in `webapp/package.json` (root `test/webapp-test-coverage.test.js` fails otherwise).
- Webapp tests run with `node --experimental-strip-types --experimental-loader ./lib/security/test-typescript-loader.mjs --test <file>` from `webapp/`. Use absolute paths in Bash; do not `cd` and rely on persisted cwd.
- Copy in UI is Korean-first through `useSystemText(messages)` with ko/en/ja keys (`SystemMessages` = `Record<"ko"|"en"|"ja", Record<string,string>>`). No emoji icons; SVG only. Interactive targets ≥ 44px tall. Keep focus rings (`:focus-visible` rules already exist in `globals.css`).
- Host id string contract: `HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u` (`webapp/lib/security/host-session-policy.ts`). Auth user UUIDs satisfy it.
- Existing password login (`POST /api/login`, `ADMIN_USER_IDS`/`ADMIN_PASSWORD_HASH`) **stays working** throughout this plan. Plan B adds the console toggle that disables it.
- Deviation from spec §1, decided here: instead of widening every ownership query to `host_id = uuid or host_id = any(legacy_host_ids)`, `profiles` gets a `host_id text not null unique` column that is the **only** id ever placed in the cookie. Bootstrap admins get `host_id = <first ADMIN_USER_IDS entry>` (today `noel`) so their existing `live_sessions` rows stay owned; everyone else gets `host_id = id::text`. Same outcome, zero query changes.

---

## File map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/202609020002_auth_profiles_desktop_codes.sql` | `profiles`, `profile_events`, `desktop_login_codes`, RLS, RPCs `upsert_profile_on_login_v1`, `read_profile_by_host_id_v1`, `issue_desktop_login_code_v1`, `consume_desktop_login_code_v1` |
| `supabase/bootstrap-new-project.sql` | append the migration verbatim |
| `test/auth-profiles-sql.test.js` (root) | additive-migration + bootstrap mirror + PGlite behaviour (skip without `NOVA_PGLITE_MODULE`) |
| `webapp/lib/auth/profile-store.ts` | `SupabaseProfileStore`: token verification via `/auth/v1/user`, RPC wrappers, error class |
| `webapp/lib/auth/profile-store.test.ts` | fetch-fake tests |
| `webapp/lib/auth/bootstrap-admins.ts` | parse `ADMIN_BOOTSTRAP_EMAILS`, derive legacy host id from `ADMIN_USER_IDS` |
| `webapp/lib/auth/exchange.ts` | `exchangeSupabaseLogin(...)` pure orchestration → `approved | pending | forbidden` |
| `webapp/lib/auth/exchange.test.ts` | orchestration tests |
| `webapp/lib/auth/profile-status-cache.ts` | 60 s status cache used by `requireHost` and `/api/auth/session` |
| `webapp/lib/auth/live-auth.ts` | `requireHost` gains the approved-status gate |
| `webapp/app/api/auth/exchange/route.ts` | `POST /api/auth/exchange` |
| `webapp/app/api/auth/desktop-exchange/route.ts` | `POST /api/auth/desktop-exchange` |
| `webapp/app/api/auth/session/route.ts` | accept profile-backed sessions, return `role` |
| `webapp/lib/security/csrf.ts` | public paths for the new routes/pages |
| `webapp/lib/auth/supabase-browser.ts` | browser client factory (PKCE) |
| `webapp/lib/system-language/login-messages.ts` | ko/en/ja copy for the login card, callback, pending page |
| `webapp/components/auth/LoginCard.tsx` | the single login/signup card |
| `webapp/components/auth/GoogleIcon.tsx` | inline Google "G" SVG |
| `webapp/components/auth/login-card-model.ts` | pure helpers: identifier routing (`@` → Supabase, else legacy), validation, desktop URL builders |
| `webapp/components/auth/login-card-model.test.ts` | |
| `webapp/components/auth/login-card-layout.test.ts` | text/regex checks on JSX + CSS (375px stack, ≥44px, one primary action) |
| `webapp/app/(login)/login/page.tsx` | renders `LoginCard` |
| `webapp/app/auth/callback/page.tsx` | finishes Supabase session, calls exchange, navigates |
| `webapp/app/pending/page.tsx` | approval-pending card + logout |
| `webapp/app/globals.css` | `.auth-card*` styles |
| `electron/desktop-auth-deep-link.js` | `createDesktopLoginState()`, `parseDesktopAuthDeepLink(url)`, `buildDesktopGoogleLoginUrl(baseUrl, state)` |
| `electron/desktop-login-preload.js` | exposes `window.novaDesktopLogin.openExternal(url)` |
| `electron/desktop-host-login-window.js` | attaches preload, passes `client=desktop&state`, exposes `verifyExternal` |
| `electron/main.js` | `nova` protocol registration, `open-url` / `second-instance` parsing, `desktop-login:open-external` IPC, `/api/auth/desktop-exchange` call |
| `package.json` (root) | electron-builder `build.protocols` |
| `test/desktop-auth-deep-link.test.js`, `test/desktop-host-login-window.test.js`, `test/desktop-host-auth-boundaries.test.js` | root tests |

---

### Task 1: Migration — profiles, events, desktop codes, RPCs

**Files:**
- Create: `supabase/migrations/202609020002_auth_profiles_desktop_codes.sql`
- Modify: `supabase/bootstrap-new-project.sql` (append at end)
- Test: `test/auth-profiles-sql.test.js`

**Interfaces:**
- Produces RPC signatures used by Task 2:
  - `upsert_profile_on_login_v1(p_user_id uuid, p_email text, p_display_name text, p_bootstrap boolean, p_legacy_host_id text) returns table (id uuid, email text, display_name text, status text, role text, host_id text, created boolean)`
  - `read_profile_by_host_id_v1(p_host_id text) returns table (id uuid, email text, display_name text, status text, role text, host_id text)`
  - `issue_desktop_login_code_v1(p_code_hash bytea, p_profile_id uuid, p_state text, p_expires_at timestamptz) returns boolean`
  - `consume_desktop_login_code_v1(p_code_hash bytea, p_state text) returns table (profile_id uuid, host_id text, status text)`

- [ ] **Step 1: Write the failing root test**

```js
// test/auth-profiles-sql.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const name = '202609020002_auth_profiles_desktop_codes.sql';
const readMigration = (file) => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');

test('auth profiles migration is additive, service-role only, and mirrored into bootstrap', async () => {
  const sql = await readMigration(name);
  const bootstrap = await readFile(new URL('../supabase/bootstrap-new-project.sql', import.meta.url), 'utf8');
  assert.ok(bootstrap.includes(`-- supabase/migrations/${name}\n\n${sql}`));
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate|delete from public\.profiles|grant select)\b/iu);
  for (const fn of ['upsert_profile_on_login_v1', 'read_profile_by_host_id_v1', 'issue_desktop_login_code_v1', 'consume_desktop_login_code_v1']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`, 'u'));
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public,\\s*anon,\\s*authenticated,\\s*service_role;`, 'u'));
  }
  assert.match(sql, /alter table public\.profiles enable row level security/u);
  assert.match(sql, /alter table public\.profile_events enable row level security/u);
  assert.match(sql, /alter table public\.desktop_login_codes enable row level security/u);
  assert.match(sql, /create policy profiles_self_select on public\.profiles for select to authenticated using \(\(select auth\.uid\(\)\) = id\)/u);
});

test('auth profiles PostgreSQL enforces bootstrap, upsert idempotency, and one-shot desktop codes', {
  skip: !process.env.NOVA_PGLITE_MODULE && 'Set NOVA_PGLITE_MODULE for isolated PostgreSQL validation',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(process.env.NOVA_PGLITE_MODULE).href);
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';`);
  await db.exec(await readMigration(name));
  await db.exec(await readMigration(name)); // idempotent
  const user = '00000000-0000-4000-8000-000000000011';
  await db.query('insert into auth.users values($1)', [user]);
  const first = (await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [user, 'Admin@Example.com', 'Admin', true, 'noel'])).rows[0];
  assert.deepEqual([first.status, first.role, first.host_id, first.created, first.email], ['approved', 'admin', 'noel', true, 'admin@example.com']);
  const again = (await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [user, 'admin@example.com', 'Renamed', false, null])).rows[0];
  assert.deepEqual([again.status, again.role, again.host_id, again.created, again.display_name], ['approved', 'admin', 'noel', false, 'Renamed']);
  const other = '00000000-0000-4000-8000-000000000022';
  await db.query('insert into auth.users values($1)', [other]);
  const pending = (await db.query('select * from public.upsert_profile_on_login_v1($1,$2,$3,$4,$5)', [other, 'guest@example.com', null, false, null])).rows[0];
  assert.deepEqual([pending.status, pending.role, pending.host_id], ['pending', 'host', other]);
  const events = (await db.query('select action from public.profile_events order by id')).rows.map((r) => r.action);
  assert.deepEqual(events, ['bootstrap_admin', 'signup']);
  const byHost = (await db.query('select * from public.read_profile_by_host_id_v1($1)', ['noel'])).rows[0];
  assert.equal(byHost.id, user);
  const hash = Buffer.alloc(32, 7);
  assert.equal((await db.query('select public.issue_desktop_login_code_v1($1,$2,$3,now() + interval \'60 seconds\') as ok', [hash, user, 'state-a'])).rows[0].ok, true);
  assert.equal((await db.query('select count(*)::int as n from public.consume_desktop_login_code_v1($1,$2)', [hash, 'state-wrong'])).rows[0].n, 0);
  const consumed = (await db.query('select * from public.consume_desktop_login_code_v1($1,$2)', [hash, 'state-a'])).rows;
  assert.equal(consumed.length, 1); assert.equal(consumed[0].host_id, 'noel');
  assert.equal((await db.query('select count(*)::int as n from public.consume_desktop_login_code_v1($1,$2)', [hash, 'state-a'])).rows[0].n, 0);
  const expired = Buffer.alloc(32, 9);
  await db.query('select public.issue_desktop_login_code_v1($1,$2,$3,now() - interval \'1 second\')', [expired, user, 'state-b']);
  assert.equal((await db.query('select count(*)::int as n from public.consume_desktop_login_code_v1($1,$2)', [expired, 'state-b'])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from public.desktop_login_codes where code_hash=$1', [expired])).rows[0].n, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test /Users/kyeongmankim/Realtime/autopreso/test/auth-profiles-sql.test.js`
Expected: FAIL — `ENOENT ... 202609020002_auth_profiles_desktop_codes.sql`.

- [ ] **Step 3: Write the migration**

```sql
-- 2026-09-02 auth: Supabase Auth becomes the identity provider. Profiles carry the
-- approval state and the host_id string that the app session cookie will carry, so
-- every existing host_id ownership query keeps working unchanged.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','disabled')),
  role text not null default 'host' check (role in ('host','admin')),
  host_id text not null unique check (host_id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$'),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_status_created_idx on public.profiles (status, created_at desc);

create table if not exists public.profile_events (
  id bigserial primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  action text not null check (action in ('signup','approve','reject','disable','enable','set_role','bootstrap_admin','engine_defaults')),
  reason text check (reason is null or char_length(reason) <= 200),
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists profile_events_profile_idx on public.profile_events (profile_id, id desc);

create table if not exists public.desktop_login_codes (
  code_hash bytea primary key check (octet_length(code_hash) = 32),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  state text not null check (state ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.profile_events enable row level security;
alter table public.desktop_login_codes enable row level security;
revoke all on table public.profiles, public.profile_events, public.desktop_login_codes from anon, authenticated;
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated using ((select auth.uid()) = id);
grant select on table public.profiles to authenticated;

create or replace function public.upsert_profile_on_login_v1(
  p_user_id uuid, p_email text, p_display_name text, p_bootstrap boolean, p_legacy_host_id text
)
returns table (id uuid, email text, display_name text, status text, role text, host_id text, created boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(coalesce(p_email, '')));
  trimmed_name text := nullif(left(btrim(coalesce(p_display_name, '')), 80), '');
  existing public.profiles%rowtype;
  chosen_host_id text;
begin
  if p_user_id is null or normalized_email = '' or char_length(normalized_email) > 254 then
    raise exception 'PROFILE_INPUT_INVALID' using errcode = '22023';
  end if;
  select * into existing from public.profiles p where p.id = p_user_id for update;
  if found then
    update public.profiles p
      set email = normalized_email,
          display_name = coalesce(trimmed_name, p.display_name),
          last_login_at = statement_timestamp(),
          updated_at = statement_timestamp()
      where p.id = p_user_id;
    return query select p.id, p.email, p.display_name, p.status, p.role, p.host_id, false
      from public.profiles p where p.id = p_user_id;
    return;
  end if;
  chosen_host_id := p_user_id::text;
  if coalesce(p_bootstrap, false) and p_legacy_host_id is not null
     and p_legacy_host_id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$'
     and not exists (select 1 from public.profiles p where p.host_id = p_legacy_host_id) then
    chosen_host_id := p_legacy_host_id;
  end if;
  insert into public.profiles (id, email, display_name, status, role, host_id, approved_at, last_login_at)
  values (
    p_user_id, normalized_email, trimmed_name,
    case when coalesce(p_bootstrap, false) then 'approved' else 'pending' end,
    case when coalesce(p_bootstrap, false) then 'admin' else 'host' end,
    chosen_host_id,
    case when coalesce(p_bootstrap, false) then statement_timestamp() else null end,
    statement_timestamp()
  );
  insert into public.profile_events (profile_id, actor_id, action, payload)
  values (p_user_id, case when coalesce(p_bootstrap, false) then p_user_id else null end,
          case when coalesce(p_bootstrap, false) then 'bootstrap_admin' else 'signup' end,
          jsonb_build_object('host_id', chosen_host_id));
  return query select p.id, p.email, p.display_name, p.status, p.role, p.host_id, true
    from public.profiles p where p.id = p_user_id;
end;
$$;
revoke all on function public.upsert_profile_on_login_v1(uuid,text,text,boolean,text) from public, anon, authenticated, service_role;
grant execute on function public.upsert_profile_on_login_v1(uuid,text,text,boolean,text) to service_role;

create or replace function public.read_profile_by_host_id_v1(p_host_id text)
returns table (id uuid, email text, display_name text, status text, role text, host_id text)
language sql security definer set search_path = '' stable
as $$
  select p.id, p.email, p.display_name, p.status, p.role, p.host_id
  from public.profiles p where p.host_id = p_host_id limit 1;
$$;
revoke all on function public.read_profile_by_host_id_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.read_profile_by_host_id_v1(text) to service_role;

create or replace function public.issue_desktop_login_code_v1(
  p_code_hash bytea, p_profile_id uuid, p_state text, p_expires_at timestamptz
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_code_hash is null or octet_length(p_code_hash) <> 32 or p_profile_id is null
     or p_state is null or p_state !~ '^[A-Za-z0-9_-]{43}$'
     or p_expires_at is null or p_expires_at > statement_timestamp() + interval '5 minutes' then
    return false;
  end if;
  delete from public.desktop_login_codes d where d.expires_at < statement_timestamp() - interval '10 minutes';
  insert into public.desktop_login_codes (code_hash, profile_id, state, expires_at)
  values (p_code_hash, p_profile_id, p_state, p_expires_at)
  on conflict (code_hash) do nothing;
  return found;
end;
$$;
revoke all on function public.issue_desktop_login_code_v1(bytea,uuid,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.issue_desktop_login_code_v1(bytea,uuid,text,timestamptz) to service_role;

create or replace function public.consume_desktop_login_code_v1(p_code_hash bytea, p_state text)
returns table (profile_id uuid, host_id text, status text)
language plpgsql security definer set search_path = ''
as $$
declare
  code_row public.desktop_login_codes%rowtype;
begin
  if p_code_hash is null or p_state is null then return; end if;
  select * into code_row from public.desktop_login_codes d where d.code_hash = p_code_hash for update;
  if not found then return; end if;
  if code_row.expires_at <= statement_timestamp() then
    delete from public.desktop_login_codes d where d.code_hash = p_code_hash;
    return;
  end if;
  if code_row.consumed_at is not null or code_row.state <> p_state then return; end if;
  update public.desktop_login_codes d set consumed_at = statement_timestamp() where d.code_hash = p_code_hash;
  return query select p.id, p.host_id, p.status from public.profiles p where p.id = code_row.profile_id;
end;
$$;
revoke all on function public.consume_desktop_login_code_v1(bytea,text) from public, anon, authenticated, service_role;
grant execute on function public.consume_desktop_login_code_v1(bytea,text) to service_role;
```

Note on `delete from public.desktop_login_codes`: the additive-migration test forbids `delete from public.profiles` only; expiring one-shot codes is the intended behaviour.

- [ ] **Step 4: Append to bootstrap**

Run from repo root:

```bash
printf '\n-- supabase/migrations/202609020002_auth_profiles_desktop_codes.sql\n\n' >> supabase/bootstrap-new-project.sql && cat supabase/migrations/202609020002_auth_profiles_desktop_codes.sql >> supabase/bootstrap-new-project.sql
```

Check the previous bootstrap tail ends with a newline first (`tail -c1 supabase/bootstrap-new-project.sql | xxd`); if it does not, add one before the marker so the `\n-- supabase/...` framing is exact.

- [ ] **Step 5: Run the test (both modes)**

Run: `node --test /Users/kyeongmankim/Realtime/autopreso/test/auth-profiles-sql.test.js`
Expected: first test PASS, second SKIP. If `NOVA_PGLITE_MODULE` is available on this machine (check `ls node_modules/@electric-sql/pglite/dist/index.js`), run with `NOVA_PGLITE_MODULE=<that path>` and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/202609020002_auth_profiles_desktop_codes.sql supabase/bootstrap-new-project.sql test/auth-profiles-sql.test.js
git commit -m "feat(auth): profiles, profile events, and one-shot desktop login codes with service-role RPCs"
```

---

### Task 2: `SupabaseProfileStore` and bootstrap-admin config

**Files:**
- Create: `webapp/lib/auth/profile-store.ts`, `webapp/lib/auth/bootstrap-admins.ts`
- Test: `webapp/lib/auth/profile-store.test.ts`, `webapp/lib/auth/bootstrap-admins.test.ts`
- Modify: `webapp/package.json` (`test:live` script: append both test paths)

**Interfaces (produced):**

```ts
export type ProfileStatus = "pending" | "approved" | "rejected" | "disabled";
export type ProfileRole = "host" | "admin";
export interface ProfileRecord { id: string; email: string; displayName: string | null; status: ProfileStatus; role: ProfileRole; hostId: string; }
export interface VerifiedAuthUser { id: string; email: string; emailConfirmed: boolean; displayName: string | null; }
export class ProfileStoreError extends Error { constructor(message: string, readonly code: string, readonly status: number) }
export class SupabaseProfileStore {
  constructor(deps?: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess; getPublicAccess?: typeof getSupabasePublicAccess });
  verifyAccessToken(accessToken: string): Promise<VerifiedAuthUser>;   // GET {url}/auth/v1/user
  upsertOnLogin(input: { user: VerifiedAuthUser; bootstrap: boolean; legacyHostId: string | null }): Promise<ProfileRecord & { created: boolean }>;
  readByHostId(hostId: string): Promise<ProfileRecord | null>;
  issueDesktopCode(input: { profileId: string; state: string; expiresAt: Date }): Promise<string>; // returns the raw 64-hex code; stores sha256
  consumeDesktopCode(input: { code: string; state: string }): Promise<{ profileId: string; hostId: string; status: ProfileStatus } | null>;
}
// bootstrap-admins.ts
export function readBootstrapAdminConfig(env?: NodeJS.ProcessEnv): { emails: ReadonlySet<string>; legacyHostId: string | null };
export function isBootstrapAdminEmail(email: string, config: ReturnType<typeof readBootstrapAdminConfig>): boolean;
```

- [ ] **Step 1: Write failing tests**

```ts
// webapp/lib/auth/bootstrap-admins.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { isBootstrapAdminEmail, readBootstrapAdminConfig } from "./bootstrap-admins";

test("bootstrap emails are lower-cased, trimmed, capped, and the legacy host id is the first ADMIN_USER_IDS entry", () => {
  const config = readBootstrapAdminConfig({ ADMIN_BOOTSTRAP_EMAILS: " Noel.Kim@Example.com, second@example.com ", ADMIN_USER_IDS: "noel,other" });
  assert.deepEqual([...config.emails], ["noel.kim@example.com", "second@example.com"]);
  assert.equal(config.legacyHostId, "noel");
  assert.equal(isBootstrapAdminEmail("NOEL.KIM@example.com", config), true);
  assert.equal(isBootstrapAdminEmail("guest@example.com", config), false);
});

test("missing or invalid values fail closed", () => {
  assert.deepEqual([...readBootstrapAdminConfig({}).emails], []);
  assert.equal(readBootstrapAdminConfig({ ADMIN_USER_IDS: "bad id!" }).legacyHostId, null);
  assert.throws(() => readBootstrapAdminConfig({ ADMIN_BOOTSTRAP_EMAILS: Array.from({ length: 21 }, (_, i) => `a${i}@x.io`).join(",") }), /ADMIN_BOOTSTRAP_EMAILS/u);
  assert.throws(() => readBootstrapAdminConfig({ ADMIN_BOOTSTRAP_EMAILS: "not-an-email" }), /ADMIN_BOOTSTRAP_EMAILS/u);
});
```

```ts
// webapp/lib/auth/profile-store.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ProfileStoreError, SupabaseProfileStore } from "./profile-store";

const access = () => ({ url: "https://project.supabase.test", credential: { key: "fixture-secret", kind: "secret" as const } });
const publicAccess = () => ({ url: "https://project.supabase.test", publishableKey: "fixture-publishable" });

function storeWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = new SupabaseProfileStore({
    fetchFn: async (input, init) => { calls.push({ url: String(input), init: init ?? {} }); return handler(String(input), init ?? {}); },
    getServerAccess: access, getPublicAccess: publicAccess,
  });
  return { store, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("verifyAccessToken calls /auth/v1/user with the publishable apikey and the user's bearer token, never the secret", async () => {
  const { store, calls } = storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011", email: "A@Example.com", email_confirmed_at: "2026-09-01T00:00:00Z", user_metadata: { full_name: "Noel Kim" } }));
  const user = await store.verifyAccessToken("fixture-access-token");
  assert.deepEqual(user, { id: "00000000-0000-4000-8000-000000000011", email: "a@example.com", emailConfirmed: true, displayName: "Noel Kim" });
  assert.equal(calls[0].url, "https://project.supabase.test/auth/v1/user");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("apikey"), "fixture-publishable");
  assert.equal(headers.get("authorization"), "Bearer fixture-access-token");
  assert.equal(JSON.stringify(calls).includes("fixture-secret"), false);
});

test("verifyAccessToken rejects 401, missing email, and unconfirmed email with typed errors", async () => {
  await assert.rejects(storeWith(() => json({ message: "invalid" }, 401)).store.verifyAccessToken("x"), (e: ProfileStoreError) => e.code === "AUTH_TOKEN_INVALID" && e.status === 401);
  await assert.rejects(storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011" })).store.verifyAccessToken("x"), (e: ProfileStoreError) => e.code === "AUTH_EMAIL_MISSING");
  const unconfirmed = await storeWith(() => json({ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", email_confirmed_at: null })).store.verifyAccessToken("x");
  assert.equal(unconfirmed.emailConfirmed, false);
});

test("upsertOnLogin posts the RPC with the secret credential and maps the row", async () => {
  const { store, calls } = storeWith(() => json([{ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", display_name: null, status: "approved", role: "admin", host_id: "noel", created: true }]));
  const profile = await store.upsertOnLogin({ user: { id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", emailConfirmed: true, displayName: null }, bootstrap: true, legacyHostId: "noel" });
  assert.deepEqual(profile, { id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", displayName: null, status: "approved", role: "admin", hostId: "noel", created: true });
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/rpc/upsert_profile_on_login_v1");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { p_user_id: "00000000-0000-4000-8000-000000000011", p_email: "a@b.io", p_display_name: null, p_bootstrap: true, p_legacy_host_id: "noel" });
  assert.equal(new Headers(calls[0].init.headers).get("apikey"), "fixture-secret");
});

test("readByHostId returns null on empty result and issue/consume desktop codes hash the raw code", async () => {
  const empty = storeWith(() => json([]));
  assert.equal(await empty.store.readByHostId("nobody"), null);
  let issued: Record<string, unknown> = {};
  const issuing = storeWith((url, init) => { if (url.endsWith("issue_desktop_login_code_v1")) { issued = JSON.parse(String(init.body)); return json(true); } return json([]); });
  const code = await issuing.store.issueDesktopCode({ profileId: "00000000-0000-4000-8000-000000000011", state: "s".repeat(43), expiresAt: new Date("2026-09-02T00:01:00Z") });
  assert.match(code, /^[0-9a-f]{64}$/u);
  assert.equal(issued.p_code_hash, `\\x${createHash("sha256").update(Buffer.from(code, "hex")).digest("hex")}`);
  assert.equal(issued.p_expires_at, "2026-09-02T00:01:00.000Z");
  const consuming = storeWith((url, init) => { assert.equal(JSON.parse(String(init.body)).p_state, "s".repeat(43)); return json([{ profile_id: "00000000-0000-4000-8000-000000000011", host_id: "noel", status: "approved" }]); });
  assert.deepEqual(await consuming.store.consumeDesktopCode({ code, state: "s".repeat(43) }), { profileId: "00000000-0000-4000-8000-000000000011", hostId: "noel", status: "approved" });
  assert.equal(await storeWith(() => json([])).store.consumeDesktopCode({ code, state: "s".repeat(43) }), null);
  await assert.rejects(storeWith(() => json([])).store.consumeDesktopCode({ code: "zz", state: "s".repeat(43) }), (e: ProfileStoreError) => e.code === "DESKTOP_CODE_INVALID");
});

test("RPC failures map to a 503 store error without leaking the body", async () => {
  await assert.rejects(storeWith(() => json({ message: "boom secret" }, 500)).store.readByHostId("noel"), (e: ProfileStoreError) => e.code === "PROFILE_STORE_UNAVAILABLE" && e.status === 503 && !e.message.includes("boom"));
});
```

- [ ] **Step 2: Register the tests and run them to verify failure**

Append ` lib/auth/bootstrap-admins.test.ts lib/auth/profile-store.test.ts` to the end of the `test:live` script string in `webapp/package.json` (inside the closing quote).

Run: `cd /Users/kyeongmankim/Realtime/autopreso/webapp && node --experimental-strip-types --experimental-loader ./lib/security/test-typescript-loader.mjs --test lib/auth/bootstrap-admins.test.ts lib/auth/profile-store.test.ts`
Expected: FAIL — cannot find module `./bootstrap-admins` / `./profile-store`.

- [ ] **Step 3: Implement `bootstrap-admins.ts`**

```ts
import { HOST_ID_PATTERN } from "../security/host-session-policy";

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/u;

export interface BootstrapAdminConfig { emails: ReadonlySet<string>; legacyHostId: string | null; }

export function readBootstrapAdminConfig(env: Readonly<Record<string, string | undefined>> = process.env): BootstrapAdminConfig {
  const emails = (env.ADMIN_BOOTSTRAP_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (emails.length > 20 || emails.some((email) => !EMAIL_PATTERN.test(email))) {
    throw new Error("ADMIN_BOOTSTRAP_EMAILS 설정이 올바르지 않습니다.");
  }
  const firstLegacy = (env.ADMIN_USER_IDS ?? "").split(",").map((v) => v.trim()).find(Boolean) ?? "";
  return { emails: new Set(emails), legacyHostId: HOST_ID_PATTERN.test(firstLegacy) ? firstLegacy : null };
}

export function isBootstrapAdminEmail(email: string, config: BootstrapAdminConfig): boolean {
  return config.emails.has(email.trim().toLowerCase());
}
```

- [ ] **Step 4: Implement `profile-store.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

import { getSupabasePublicAccess, getSupabaseServerAccess, supabaseAdminHeaders } from "../security/supabase-server-access";

export type ProfileStatus = "pending" | "approved" | "rejected" | "disabled";
export type ProfileRole = "host" | "admin";
export interface ProfileRecord { id: string; email: string; displayName: string | null; status: ProfileStatus; role: ProfileRole; hostId: string; }
export interface VerifiedAuthUser { id: string; email: string; emailConfirmed: boolean; displayName: string | null; }

export class ProfileStoreError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATUSES = new Set<ProfileStatus>(["pending", "approved", "rejected", "disabled"]);
const ROLES = new Set<ProfileRole>(["host", "admin"]);
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CODE_PATTERN = /^[0-9a-f]{64}$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mapProfileRow(row: unknown): ProfileRecord & { created: boolean } {
  if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.email !== "string"
    || typeof row.host_id !== "string" || !STATUSES.has(row.status as ProfileStatus) || !ROLES.has(row.role as ProfileRole)) {
    throw new ProfileStoreError("프로필 응답이 올바르지 않습니다.", "PROFILE_ROW_INVALID", 502);
  }
  return {
    id: row.id, email: row.email, displayName: typeof row.display_name === "string" ? row.display_name : null,
    status: row.status as ProfileStatus, role: row.role as ProfileRole, hostId: row.host_id, created: row.created === true,
  };
}

export class SupabaseProfileStore {
  private readonly fetchFn: typeof fetch;
  private readonly getServerAccess: typeof getSupabaseServerAccess;
  private readonly getPublicAccess: typeof getSupabasePublicAccess;

  constructor(deps: { fetchFn?: typeof fetch; getServerAccess?: typeof getSupabaseServerAccess; getPublicAccess?: typeof getSupabasePublicAccess } = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.getServerAccess = deps.getServerAccess ?? getSupabaseServerAccess;
    this.getPublicAccess = deps.getPublicAccess ?? getSupabasePublicAccess;
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedAuthUser> {
    if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 4096 || /\s/u.test(accessToken)) {
      throw new ProfileStoreError("인증 토큰이 올바르지 않습니다.", "AUTH_TOKEN_INVALID", 401);
    }
    const { url, publishableKey } = this.getPublicAccess();
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/auth/v1/user`, {
        method: "GET", cache: "no-store",
        headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" },
      });
    } catch { throw new ProfileStoreError("인증 서비스에 연결할 수 없습니다.", "AUTH_SERVICE_UNAVAILABLE", 503); }
    if (response.status === 401 || response.status === 403) throw new ProfileStoreError("인증 토큰이 올바르지 않습니다.", "AUTH_TOKEN_INVALID", 401);
    if (!response.ok) throw new ProfileStoreError("인증 서비스를 사용할 수 없습니다.", "AUTH_SERVICE_UNAVAILABLE", 503);
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || typeof body.id !== "string" || !UUID.test(body.id)) throw new ProfileStoreError("인증 토큰이 올바르지 않습니다.", "AUTH_TOKEN_INVALID", 401);
    if (typeof body.email !== "string" || !body.email.includes("@")) throw new ProfileStoreError("이메일이 없는 계정은 사용할 수 없습니다.", "AUTH_EMAIL_MISSING", 403);
    const metadata = isRecord(body.user_metadata) ? body.user_metadata : {};
    const rawName = [metadata.full_name, metadata.name].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    return {
      id: body.id, email: body.email.trim().toLowerCase(),
      emailConfirmed: typeof body.email_confirmed_at === "string" || typeof body.confirmed_at === "string",
      displayName: rawName ? rawName.trim().slice(0, 80) : null,
    };
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { url, credential } = this.getServerAccess();
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/rest/v1/rpc/${name}`, {
        method: "POST", cache: "no-store",
        headers: { ...supabaseAdminHeaders(credential), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args),
      });
    } catch { throw new ProfileStoreError("프로필 저장소에 연결할 수 없습니다.", "PROFILE_STORE_UNAVAILABLE", 503); }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ProfileStoreError("프로필 저장소를 사용할 수 없습니다.", "PROFILE_STORE_UNAVAILABLE", 503);
    return body;
  }

  async upsertOnLogin(input: { user: VerifiedAuthUser; bootstrap: boolean; legacyHostId: string | null }): Promise<ProfileRecord & { created: boolean }> {
    const rows = await this.rpc("upsert_profile_on_login_v1", {
      p_user_id: input.user.id, p_email: input.user.email, p_display_name: input.user.displayName,
      p_bootstrap: input.bootstrap, p_legacy_host_id: input.bootstrap ? input.legacyHostId : null,
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw new ProfileStoreError("프로필 응답이 올바르지 않습니다.", "PROFILE_ROW_INVALID", 502);
    return mapProfileRow(rows[0]);
  }

  async readByHostId(hostId: string): Promise<ProfileRecord | null> {
    const rows = await this.rpc("read_profile_by_host_id_v1", { p_host_id: hostId });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const { created: _created, ...profile } = mapProfileRow({ ...(rows[0] as object), created: false });
    return profile;
  }

  async issueDesktopCode(input: { profileId: string; state: string; expiresAt: Date }): Promise<string> {
    if (!STATE_PATTERN.test(input.state)) throw new ProfileStoreError("로그인 상태 값이 올바르지 않습니다.", "DESKTOP_STATE_INVALID", 400);
    const code = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(Buffer.from(code, "hex")).digest("hex");
    const ok = await this.rpc("issue_desktop_login_code_v1", {
      p_code_hash: `\\x${hash}`, p_profile_id: input.profileId, p_state: input.state, p_expires_at: input.expiresAt.toISOString(),
    });
    if (ok !== true) throw new ProfileStoreError("데스크톱 로그인 코드를 만들지 못했습니다.", "DESKTOP_CODE_ISSUE_FAILED", 503);
    return code;
  }

  async consumeDesktopCode(input: { code: string; state: string }): Promise<{ profileId: string; hostId: string; status: ProfileStatus } | null> {
    if (!CODE_PATTERN.test(input.code) || !STATE_PATTERN.test(input.state)) throw new ProfileStoreError("데스크톱 로그인 코드가 올바르지 않습니다.", "DESKTOP_CODE_INVALID", 401);
    const hash = createHash("sha256").update(Buffer.from(input.code, "hex")).digest("hex");
    const rows = await this.rpc("consume_desktop_login_code_v1", { p_code_hash: `\\x${hash}`, p_state: input.state });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!isRecord(row) || typeof row.profile_id !== "string" || typeof row.host_id !== "string" || !STATUSES.has(row.status as ProfileStatus)) {
      throw new ProfileStoreError("프로필 응답이 올바르지 않습니다.", "PROFILE_ROW_INVALID", 502);
    }
    return { profileId: row.profile_id, hostId: row.host_id, status: row.status as ProfileStatus };
  }
}
```

PostgREST accepts `bytea` arguments as `\x<hex>` strings; the test pins that encoding.

- [ ] **Step 5: Run tests + typecheck**

Run: the Step 2 command. Expected: all PASS.
Run: `npm --prefix /Users/kyeongmankim/Realtime/autopreso/webapp run typecheck`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add webapp/lib/auth/profile-store.ts webapp/lib/auth/profile-store.test.ts webapp/lib/auth/bootstrap-admins.ts webapp/lib/auth/bootstrap-admins.test.ts webapp/package.json
git commit -m "feat(auth): Supabase profile store with server-side token verification and bootstrap admin config"
```

---

### Task 3: Exchange orchestration + `/api/auth/exchange` + `/api/auth/desktop-exchange`

**Files:**
- Create: `webapp/lib/auth/exchange.ts`, `webapp/lib/auth/exchange.test.ts`, `webapp/app/api/auth/exchange/route.ts`, `webapp/app/api/auth/desktop-exchange/route.ts`, `webapp/lib/auth/auth-routes.test.ts`
- Modify: `webapp/lib/security/csrf.ts` (public paths), `webapp/package.json` (`test:live`)

**Interfaces (produced):**

```ts
// exchange.ts
export type ExchangeOutcome =
  | { kind: "approved"; profile: ProfileRecord; next: string; desktopCode?: string }
  | { kind: "pending"; email: string; next: "/pending" }
  | { kind: "forbidden"; code: "PROFILE_REJECTED" | "PROFILE_DISABLED" | "EMAIL_UNCONFIRMED"; email: string };
export interface ExchangeInput { accessToken: string; client: "web" | "desktop"; state?: string; now?: () => number }
export async function exchangeSupabaseLogin(input: ExchangeInput, deps: { store: Pick<SupabaseProfileStore, "verifyAccessToken" | "upsertOnLogin" | "issueDesktopCode">; bootstrap: BootstrapAdminConfig }): Promise<ExchangeOutcome>;
export const DESKTOP_CODE_TTL_MS = 60_000;
export const DESKTOP_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export function buildDesktopCallbackUrl(code: string, state: string): string; // "nova://auth/callback?code=<code>&state=<state>"
```

Route contracts (consumed by Tasks 5, 6, 7):
- `POST /api/auth/exchange` body `{ accessToken, client?: "web"|"desktop", state? }` → `200 { ok: true, data: { status: "approved", next: "/admin" } }` (+ `rnw_session` cookie) for web; `200 { ok: true, data: { status: "approved", next: "nova://auth/callback?code=…&state=…" } }` with **no cookie** for desktop; `200 { ok: true, data: { status: "pending", next: "/pending" } }`; `403 { ok: false, code: "PROFILE_REJECTED" | "PROFILE_DISABLED" | "EMAIL_UNCONFIRMED" }`; `401 AUTH_TOKEN_INVALID`; `429 LOGIN_RATE_LIMITED`; `503 LOGIN_SECURITY_UNAVAILABLE`.
- `POST /api/auth/desktop-exchange` body `{ code, state }` → `200 { ok: true, data: { userId } }` + cookie; `401 DESKTOP_CODE_INVALID`; `403 PROFILE_NOT_APPROVED`.

- [ ] **Step 1: Write failing tests**

```ts
// webapp/lib/auth/exchange.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopCallbackUrl, exchangeSupabaseLogin } from "./exchange";
import type { ProfileRecord, VerifiedAuthUser } from "./profile-store";

const user: VerifiedAuthUser = { id: "00000000-0000-4000-8000-000000000011", email: "noel@example.com", emailConfirmed: true, displayName: "Noel" };
const profile = (over: Partial<ProfileRecord>): ProfileRecord & { created: boolean } => ({ id: user.id, email: user.email, displayName: "Noel", status: "approved", role: "admin", hostId: "noel", created: false, ...over });
const bootstrap = { emails: new Set(["noel@example.com"]), legacyHostId: "noel" };
const state = "A".repeat(43);

function deps(status: ProfileRecord["status"], record: { upsert?: unknown; issued?: unknown } = {}) {
  return {
    bootstrap,
    store: {
      verifyAccessToken: async () => user,
      upsertOnLogin: async (input: unknown) => { record.upsert = input; return profile({ status }); },
      issueDesktopCode: async (input: unknown) => { record.issued = input; return "c".repeat(64); },
    },
  };
}

test("approved web login yields /admin and passes bootstrap flags derived from the email", async () => {
  const record: { upsert?: unknown } = {};
  const outcome = await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("approved", record));
  assert.equal(outcome.kind, "approved"); if (outcome.kind !== "approved") return;
  assert.equal(outcome.next, "/admin"); assert.equal(outcome.desktopCode, undefined);
  assert.deepEqual(record.upsert, { user, bootstrap: true, legacyHostId: "noel" });
});

test("non-bootstrap emails are never bootstrapped", async () => {
  const record: { upsert?: unknown } = {};
  await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, { ...deps("pending", record), store: { ...deps("pending", record).store, verifyAccessToken: async () => ({ ...user, email: "guest@example.com" }) } });
  assert.deepEqual(record.upsert, { user: { ...user, email: "guest@example.com" }, bootstrap: false, legacyHostId: "noel" });
});

test("pending → /pending, rejected/disabled → forbidden, unconfirmed email → forbidden before any upsert", async () => {
  assert.deepEqual(await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("pending")), { kind: "pending", email: user.email, next: "/pending" });
  assert.deepEqual(await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("rejected")), { kind: "forbidden", code: "PROFILE_REJECTED", email: user.email });
  assert.deepEqual(await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, deps("disabled")), { kind: "forbidden", code: "PROFILE_DISABLED", email: user.email });
  const record: { upsert?: unknown } = {};
  const d = deps("approved", record);
  const outcome = await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "web" }, { ...d, store: { ...d.store, verifyAccessToken: async () => ({ ...user, emailConfirmed: false }) } });
  assert.equal(outcome.kind, "forbidden"); assert.equal(record.upsert, undefined);
});

test("desktop login issues a 60 s one-shot code and returns the nova:// callback without a cookie decision", async () => {
  const record: { issued?: { profileId: string; state: string; expiresAt: Date } } = {};
  const now = Date.parse("2026-09-02T00:00:00Z");
  const outcome = await exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "desktop", state, now: () => now }, deps("approved", record));
  assert.equal(outcome.kind, "approved"); if (outcome.kind !== "approved") return;
  assert.equal(outcome.desktopCode, "c".repeat(64));
  assert.equal(outcome.next, `nova://auth/callback?code=${"c".repeat(64)}&state=${state}`);
  assert.deepEqual(record.issued, { profileId: user.id, state, expiresAt: new Date(now + 60_000) });
});

test("desktop login without a valid state is rejected before verification", async () => {
  let verified = false;
  const d = deps("approved"); d.store.verifyAccessToken = async () => { verified = true; return user; };
  await assert.rejects(exchangeSupabaseLogin({ accessToken: "fixture-access-token", client: "desktop", state: "short" }, d), /DESKTOP_STATE_INVALID/u);
  assert.equal(verified, false);
  assert.equal(buildDesktopCallbackUrl("ab", state), `nova://auth/callback?code=ab&state=${state}`);
});
```

```ts
// webapp/lib/auth/auth-routes.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isPublicUnauthenticatedPath } from "../security/csrf";

const exchange = readFileSync(resolve(process.cwd(), "app/api/auth/exchange/route.ts"), "utf8");
const desktop = readFileSync(resolve(process.cwd(), "app/api/auth/desktop-exchange/route.ts"), "utf8");

test("auth pages and exchange routes are reachable before login; console stays protected", () => {
  for (const p of ["/auth/callback", "/pending", "/api/auth/exchange", "/api/auth/desktop-exchange"]) assert.equal(isPublicUnauthenticatedPath(p), true, p);
  for (const p of ["/console", "/console/users", "/admin"]) assert.equal(isPublicUnauthenticatedPath(p), false, p);
});

test("exchange route shares the login rate limiter and origin check, sets the cookie only for approved web logins, and never echoes tokens", () => {
  assert.match(exchange, /assertStrictOrigin\(request\)/u);
  assert.match(exchange, /loginRateLimiter\.check\(request\.headers\)/u);
  assert.match(exchange, /enforceHostLoginRateLimit\(request, admissionStore\)/u);
  assert.match(exchange, /readBoundedJsonBody\(request\)/u);
  assert.match(exchange, /outcome\.kind === "approved" && parsed\.data\.client !== "desktop"/u);
  assert.match(exchange, /response\.cookies\.set\(SESSION_COOKIE/u);
  assert.match(exchange, /httpOnly: true/u);
  assert.doesNotMatch(exchange, /accessToken\s*[,}]\s*\)/u, "route must not place the access token in responses or logs");
  assert.doesNotMatch(exchange, /console\.(log|info|warn|error)\(/u);
});

test("desktop exchange consumes the code once, requires approved status, and issues the same cookie shape", () => {
  assert.match(desktop, /assertStrictOrigin\(request\)/u);
  assert.match(desktop, /consumeDesktopCode\(\{ code: parsed\.data\.code, state: parsed\.data\.state \}\)/u);
  assert.match(desktop, /"DESKTOP_CODE_INVALID", 401/u);
  assert.match(desktop, /"PROFILE_NOT_APPROVED", 403/u);
  assert.match(desktop, /createSessionToken\(consumed\.hostId\)/u);
  assert.match(desktop, /maxAge: SESSION_TTL_SECONDS/u);
  assert.doesNotMatch(desktop, /console\.(log|info|warn|error)\(/u);
});
```

- [ ] **Step 2: Register and run to verify failure**

Append ` lib/auth/exchange.test.ts lib/auth/auth-routes.test.ts` to `test:live`. Run both files with the loader command. Expected: FAIL (missing modules / files).

- [ ] **Step 3: Implement `exchange.ts`**

```ts
import type { BootstrapAdminConfig } from "./bootstrap-admins";
import { isBootstrapAdminEmail } from "./bootstrap-admins";
import type { ProfileRecord, SupabaseProfileStore } from "./profile-store";

export const DESKTOP_CODE_TTL_MS = 60_000;
export const DESKTOP_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type ExchangeOutcome =
  | { kind: "approved"; profile: ProfileRecord; next: string; desktopCode?: string }
  | { kind: "pending"; email: string; next: "/pending" }
  | { kind: "forbidden"; code: "PROFILE_REJECTED" | "PROFILE_DISABLED" | "EMAIL_UNCONFIRMED"; email: string };

export interface ExchangeInput { accessToken: string; client: "web" | "desktop"; state?: string; now?: () => number }

export function buildDesktopCallbackUrl(code: string, state: string): string {
  return `nova://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

export async function exchangeSupabaseLogin(
  input: ExchangeInput,
  deps: { store: Pick<SupabaseProfileStore, "verifyAccessToken" | "upsertOnLogin" | "issueDesktopCode">; bootstrap: BootstrapAdminConfig },
): Promise<ExchangeOutcome> {
  if (input.client === "desktop" && !DESKTOP_STATE_PATTERN.test(input.state ?? "")) throw new Error("DESKTOP_STATE_INVALID");
  const user = await deps.store.verifyAccessToken(input.accessToken);
  if (!user.emailConfirmed) return { kind: "forbidden", code: "EMAIL_UNCONFIRMED", email: user.email };
  const profile = await deps.store.upsertOnLogin({
    user, bootstrap: isBootstrapAdminEmail(user.email, deps.bootstrap), legacyHostId: deps.bootstrap.legacyHostId,
  });
  if (profile.status === "pending") return { kind: "pending", email: profile.email, next: "/pending" };
  if (profile.status === "rejected") return { kind: "forbidden", code: "PROFILE_REJECTED", email: profile.email };
  if (profile.status === "disabled") return { kind: "forbidden", code: "PROFILE_DISABLED", email: profile.email };
  if (input.client === "desktop") {
    const now = input.now?.() ?? Date.now();
    const desktopCode = await deps.store.issueDesktopCode({ profileId: profile.id, state: input.state as string, expiresAt: new Date(now + DESKTOP_CODE_TTL_MS) });
    return { kind: "approved", profile, next: buildDesktopCallbackUrl(desktopCode, input.state as string), desktopCode };
  }
  return { kind: "approved", profile, next: "/admin" };
}
```

- [ ] **Step 4: Implement the two routes**

`webapp/app/api/auth/exchange/route.ts`:

```ts
import { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from "@/lib/session";
import { readBootstrapAdminConfig } from "@/lib/auth/bootstrap-admins";
import { DESKTOP_STATE_PATTERN, exchangeSupabaseLogin } from "@/lib/auth/exchange";
import { ProfileStoreError, SupabaseProfileStore } from "@/lib/auth/profile-store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { LiveAdmissionError, SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { HostLoginRateLimitError, enforceHostLoginRateLimit } from "@/lib/security/live-rate-limit";
import { loginRateLimiter } from "@/lib/security/login-rate-limit";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store" };
const bodySchema = z.object({
  accessToken: z.string().min(20).max(4096),
  client: z.enum(["web", "desktop"]).optional(),
  state: z.string().regex(DESKTOP_STATE_PATTERN).optional(),
}).strict();

export async function POST(request: NextRequest) {
  try { assertStrictOrigin(request); }
  catch { return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, NO_STORE); }
  const currentLimit = loginRateLimiter.check(request.headers);
  if (!currentLimit.isAllowed) return apiError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", "LOGIN_RATE_LIMITED", 429, { ...NO_STORE, "retry-after": String(currentLimit.retryAfterSeconds) });
  if (process.env.NODE_ENV === "production") {
    try { const admissionStore = new SupabaseLiveAdmissionStore(); await enforceHostLoginRateLimit(request, admissionStore); }
    catch (error: unknown) {
      if (error instanceof LiveAdmissionError && error.code === "LOGIN_RATE_LIMITED") return apiError(error.message, error.code, error.status, { ...NO_STORE, "retry-after": String(error instanceof HostLoginRateLimitError ? error.retryAfterSeconds : 900) });
      return apiError("로그인 보안 서비스를 사용할 수 없습니다.", "LOGIN_SECURITY_UNAVAILABLE", 503, NO_STORE);
    }
  }
  let body: unknown;
  try { body = await readBoundedJsonBody(request); }
  catch (error: unknown) { return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", error instanceof BoundedJsonBodyError ? error.status : 400, NO_STORE); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || (parsed.data.client === "desktop" && !parsed.data.state)) return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400, NO_STORE);
  let bootstrap;
  try { bootstrap = readBootstrapAdminConfig(); }
  catch { return apiError("관리자 초기 설정이 올바르지 않습니다.", "BOOTSTRAP_CONFIG_INVALID", 503, NO_STORE); }

  let outcome;
  try {
    outcome = await exchangeSupabaseLogin({ accessToken: parsed.data.accessToken, client: parsed.data.client ?? "web", state: parsed.data.state }, { store: new SupabaseProfileStore(), bootstrap });
  } catch (error: unknown) {
    if (error instanceof ProfileStoreError) {
      if (error.code === "AUTH_TOKEN_INVALID") loginRateLimiter.recordFailure(request.headers);
      return apiError(error.message, error.code, error.status, NO_STORE);
    }
    return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", 400, NO_STORE);
  }
  if (outcome.kind === "forbidden") return apiError("이 계정은 현재 로그인할 수 없습니다.", outcome.code, 403, NO_STORE);
  loginRateLimiter.clear(request.headers);
  if (outcome.kind === "pending") return apiSuccess({ status: "pending", next: outcome.next }, { headers: NO_STORE });
  const response = apiSuccess({ status: "approved", next: outcome.next }, { headers: NO_STORE });
  if (outcome.kind === "approved" && parsed.data.client !== "desktop") {
    const token = await createSessionToken(outcome.profile.hostId);
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
    response.cookies.set("rnw_name", outcome.profile.displayName ?? outcome.profile.email, { sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
  }
  return response;
}
```

`webapp/app/api/auth/desktop-exchange/route.ts`:

```ts
import { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from "@/lib/session";
import { DESKTOP_STATE_PATTERN } from "@/lib/auth/exchange";
import { ProfileStoreError, SupabaseProfileStore } from "@/lib/auth/profile-store";
import { apiError, apiSuccess } from "@/lib/security/api-response";
import { BoundedJsonBodyError, readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import { assertStrictOrigin } from "@/lib/security/csrf";
import { loginRateLimiter } from "@/lib/security/login-rate-limit";

export const dynamic = "force-dynamic";
const NO_STORE = { "cache-control": "private, no-store" };
const bodySchema = z.object({ code: z.string().regex(/^[0-9a-f]{64}$/u), state: z.string().regex(DESKTOP_STATE_PATTERN) }).strict();

export async function POST(request: NextRequest) {
  try { assertStrictOrigin(request); }
  catch { return apiError("허용되지 않은 요청 출처입니다.", "CSRF_REJECTED", 403, NO_STORE); }
  const limit = loginRateLimiter.check(request.headers);
  if (!limit.isAllowed) return apiError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", "LOGIN_RATE_LIMITED", 429, { ...NO_STORE, "retry-after": String(limit.retryAfterSeconds) });
  let body: unknown;
  try { body = await readBoundedJsonBody(request); }
  catch (error: unknown) { return apiError("로그인 정보가 올바르지 않습니다.", "INVALID_LOGIN_REQUEST", error instanceof BoundedJsonBodyError ? error.status : 400, NO_STORE); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) { loginRateLimiter.recordFailure(request.headers); return apiError("데스크톱 로그인 코드가 올바르지 않습니다.", "DESKTOP_CODE_INVALID", 401, NO_STORE); }
  let consumed;
  try { consumed = await new SupabaseProfileStore().consumeDesktopCode({ code: parsed.data.code, state: parsed.data.state }); }
  catch (error: unknown) {
    if (error instanceof ProfileStoreError) return apiError(error.message, error.code, error.status, NO_STORE);
    return apiError("프로필 저장소를 사용할 수 없습니다.", "PROFILE_STORE_UNAVAILABLE", 503, NO_STORE);
  }
  if (!consumed) { loginRateLimiter.recordFailure(request.headers); return apiError("데스크톱 로그인 코드가 올바르지 않습니다.", "DESKTOP_CODE_INVALID", 401, NO_STORE); }
  if (consumed.status !== "approved") return apiError("승인되지 않은 계정입니다.", "PROFILE_NOT_APPROVED", 403, NO_STORE);
  loginRateLimiter.clear(request.headers);
  const token = await createSessionToken(consumed.hostId);
  const response = apiSuccess({ userId: consumed.hostId }, { headers: NO_STORE });
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_SECONDS });
  return response;
}
```

Add to `PUBLIC_UNAUTHENTICATED_PATHS` in `webapp/lib/security/csrf.ts`:

```ts
  // 2026-09-02 auth: Supabase login finishes on these pages/routes before any app cookie exists.
  "/auth/callback",
  "/pending",
  "/api/auth/exchange",
  "/api/auth/desktop-exchange",
```

- [ ] **Step 5: Run tests + typecheck**

Run the two test files; expected PASS. Run `npm --prefix /Users/kyeongmankim/Realtime/autopreso/webapp run typecheck`; expected clean. Also run `components/live/admin-login-route.test.ts` and `lib/security/host-session.test.ts` (they pin public paths) — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add webapp/lib/auth/exchange.ts webapp/lib/auth/exchange.test.ts webapp/lib/auth/auth-routes.test.ts webapp/app/api/auth/exchange/route.ts webapp/app/api/auth/desktop-exchange/route.ts webapp/lib/security/csrf.ts webapp/package.json
git commit -m "feat(auth): Supabase token exchange routes issue the host cookie only for approved profiles"
```

---

### Task 4: Approval gate in `requireHost` and role in `/api/auth/session`

**Files:**
- Create: `webapp/lib/auth/profile-status-cache.ts`, `webapp/lib/auth/profile-status-cache.test.ts`
- Modify: `webapp/lib/auth/live-auth.ts:282-295`, `webapp/app/api/auth/session/route.ts`, `webapp/lib/security/host-session.test.ts` (add cases), `webapp/package.json`

**Interfaces (produced):**

```ts
// profile-status-cache.ts
export interface CachedProfileStatus { status: ProfileStatus; role: ProfileRole; hostId: string } | null  // null = no profile row (legacy password user)
export function createProfileStatusCache(opts: { read: (hostId: string) => Promise<ProfileRecord | null>; ttlMs?: number; now?: () => number }): { get(hostId: string): Promise<{ status: ProfileStatus; role: ProfileRole } | null>; invalidate(hostId?: string): void };
export const profileStatusCache: ReturnType<typeof createProfileStatusCache>;   // module singleton over SupabaseProfileStore
export async function assertHostApproved(hostId: string, cache = profileStatusCache): Promise<{ role: ProfileRole | "legacy" }>; // throws AuthenticationError when status !== "approved"
```

`requireHost(request)` keeps its signature `Promise<{ hostId: string }>` (34 call sites untouched) and now awaits `assertHostApproved(hostId)`. `/api/auth/session` returns `{ userId, expiresAt, role: "admin" | "host" | "legacy" }`.

- [ ] **Step 1: Write failing tests**

```ts
// webapp/lib/auth/profile-status-cache.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertHostApproved, createProfileStatusCache } from "./profile-status-cache";
import { AuthenticationError } from "./live-auth";
import type { ProfileRecord } from "./profile-store";

const row = (status: ProfileRecord["status"]): ProfileRecord => ({ id: "00000000-0000-4000-8000-000000000011", email: "a@b.io", displayName: null, status, role: "host", hostId: "h1" });

test("status is cached for 60 s per host id and refetched afterwards", async () => {
  let now = 0; let reads = 0;
  const cache = createProfileStatusCache({ read: async () => { reads++; return row("approved"); }, now: () => now });
  await cache.get("h1"); await cache.get("h1");
  assert.equal(reads, 1);
  now = 60_001; await cache.get("h1");
  assert.equal(reads, 2);
  cache.invalidate("h1"); await cache.get("h1");
  assert.equal(reads, 3);
});

test("a missing profile row is cached as null (legacy password host) and store failures fall open only for legacy rows", async () => {
  const cache = createProfileStatusCache({ read: async () => null });
  assert.equal(await cache.get("noel"), null);
  assert.deepEqual(await assertHostApproved("noel", cache), { role: "legacy" });
});

test("assertHostApproved rejects pending, rejected, and disabled profiles with AuthenticationError", async () => {
  for (const status of ["pending", "rejected", "disabled"] as const) {
    const cache = createProfileStatusCache({ read: async () => row(status) });
    await assert.rejects(assertHostApproved("h1", cache), AuthenticationError);
  }
  const ok = createProfileStatusCache({ read: async () => ({ ...row("approved"), role: "admin" }) });
  assert.deepEqual(await assertHostApproved("h1", ok), { role: "admin" });
});

test("a store outage does not lock out a host whose last known status was approved", async () => {
  let fail = false; let now = 0;
  const cache = createProfileStatusCache({ read: async () => { if (fail) throw new Error("down"); return row("approved"); }, now: () => now });
  await cache.get("h1"); fail = true; now = 120_000;
  assert.deepEqual(await assertHostApproved("h1", cache), { role: "host" });
});
```

Add to `webapp/lib/security/host-session.test.ts` (inside the file, new test using the existing `withSessionEnvironment` + `sign` helpers; read the file's existing session route test first and mirror how it builds a `NextRequest`):

```ts
test("session route reports role and accepts a profile-backed host that is not in ADMIN_USER_IDS", async () => {
  await withSessionEnvironment(async () => {
    const { GET } = await import("../../app/api/auth/session/route");
    const statusCache = await import("../auth/profile-status-cache");
    statusCache.__setProfileReaderForTests(async (hostId: string) => hostId === "00000000-0000-4000-8000-000000000011"
      ? { id: hostId, email: "a@b.io", displayName: null, status: "approved", role: "admin", hostId } : null);
    const token = await sessions.createSessionToken("00000000-0000-4000-8000-000000000011");
    const response = await GET(new NextRequest("https://nova.test/api/auth/session", { headers: { cookie: `${sessions.SESSION_COOKIE}=${token}` } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.role, "admin");
    const legacy = await GET(new NextRequest("https://nova.test/api/auth/session", { headers: { cookie: `${sessions.SESSION_COOKIE}=${await sessions.createSessionToken("operator")}` } }));
    assert.equal((await legacy.json()).data.role, "legacy");
    statusCache.__setProfileReaderForTests(null);
  });
});
```

(`NextRequest` import: `import { NextRequest } from "next/server";` — check the file already imports it; add if not.)

- [ ] **Step 2: Register and run to verify failure**

Append ` lib/auth/profile-status-cache.test.ts` to `test:live`. Run it and `lib/security/host-session.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `profile-status-cache.ts`**

```ts
import { AuthenticationError } from "./live-auth";
import { SupabaseProfileStore, type ProfileRecord, type ProfileRole, type ProfileStatus } from "./profile-store";

const DEFAULT_TTL_MS = 60_000;
type Reader = (hostId: string) => Promise<ProfileRecord | null>;
type Entry = { value: { status: ProfileStatus; role: ProfileRole } | null; expiresAt: number };

export function createProfileStatusCache(opts: { read: Reader; ttlMs?: number; now?: () => number }) {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  return {
    async get(hostId: string): Promise<{ status: ProfileStatus; role: ProfileRole } | null> {
      const hit = entries.get(hostId);
      if (hit && hit.expiresAt > now()) return hit.value;
      try {
        const row = await opts.read(hostId);
        const value = row ? { status: row.status, role: row.role } : null;
        entries.set(hostId, { value, expiresAt: now() + ttl });
        if (entries.size > 5_000) entries.delete(entries.keys().next().value as string);
        return value;
      } catch {
        // Store outage: keep serving the last known answer instead of locking every host out.
        if (hit) return hit.value;
        throw new AuthenticationError("호스트 상태를 확인할 수 없습니다.");
      }
    },
    invalidate(hostId?: string) { if (hostId) entries.delete(hostId); else entries.clear(); },
  };
}

let reader: Reader | null = null;
function defaultReader(hostId: string): Promise<ProfileRecord | null> {
  return (reader ?? ((id: string) => new SupabaseProfileStore().readByHostId(id)))(hostId);
}
export const profileStatusCache = createProfileStatusCache({ read: defaultReader });
/** Test seam: swap the reader without touching the singleton cache. */
export function __setProfileReaderForTests(next: Reader | null): void { reader = next; profileStatusCache.invalidate(); }

export async function assertHostApproved(hostId: string, cache = profileStatusCache): Promise<{ role: ProfileRole | "legacy" }> {
  const profile = await cache.get(hostId);
  if (profile === null) return { role: "legacy" };
  if (profile.status !== "approved") throw new AuthenticationError("호스트 계정이 승인되지 않았거나 비활성화되었습니다.");
  return { role: profile.role };
}
```

Circular import note: `live-auth.ts` will import `assertHostApproved` from this file, and this file imports `AuthenticationError` from `live-auth.ts`. Both are used only inside functions (not at module top level), so ESM live bindings resolve fine. If the loader complains, move `AuthenticationError`/`AuthorizationError` into a new `webapp/lib/auth/errors.ts` and re-export them from `live-auth.ts`.

- [ ] **Step 4: Gate `requireHost`**

In `webapp/lib/auth/live-auth.ts`, add `import { assertHostApproved } from "./profile-status-cache";` and change the tail of `requireHost`:

```ts
    const [hostId] = payload.split("|");
    if (!hostId) throw new Error("missing host id");
    await assertHostApproved(hostId);
    return { hostId };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("호스트 인증 정보가 올바르지 않습니다.");
  }
```

- [ ] **Step 5: Role in `/api/auth/session`**

In `webapp/app/api/auth/session/route.ts`, replace the `config.userIds.has(session.userId)` acceptance with:

```ts
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token);
  if (!session || !config.isEnabled) return apiError("호스트 로그인이 필요합니다.", "AUTH_REQUIRED", 401, NO_STORE);
  let role: "admin" | "host" | "legacy";
  try {
    const approved = await assertHostApproved(session.userId);
    role = approved.role;
    if (role === "legacy" && !config.userIds.has(session.userId)) return apiError("호스트 로그인이 필요합니다.", "AUTH_REQUIRED", 401, NO_STORE);
  } catch { return apiError("호스트 로그인이 필요합니다.", "AUTH_REQUIRED", 401, NO_STORE); }
```

and include `role` in the success payload: `apiSuccess({ userId: current.userId, expiresAt: ..., role }, ...)`. Import `assertHostApproved` from `@/lib/auth/profile-status-cache`.

- [ ] **Step 6: Run the webapp suites**

Run: `npm --prefix /Users/kyeongmankim/Realtime/autopreso/webapp test` and `npm --prefix /Users/kyeongmankim/Realtime/autopreso/webapp run typecheck`. Expected: PASS / clean. Any route test that builds a `requireHost` cookie for a fixture host id and does not set the reader will hit the real store constructor — those tests must call `__setProfileReaderForTests(async () => null)` in setup (legacy path) or the reader must fall back to null when `getSupabaseServerAccess()` throws `LiveSecurityConfigurationError`. Implement the latter in `defaultReader`: wrap the store call and return `null` when the thrown error is a `LiveSecurityConfigurationError` (env not configured = development/test without Supabase), so unconfigured environments behave exactly as before this task.

- [ ] **Step 7: Commit**

```bash
git add webapp/lib/auth/profile-status-cache.ts webapp/lib/auth/profile-status-cache.test.ts webapp/lib/auth/live-auth.ts webapp/app/api/auth/session/route.ts webapp/lib/security/host-session.test.ts webapp/package.json
git commit -m "feat(auth): requireHost enforces approved profile status; session route reports role"
```

---

### Task 5: Login card (Google + email/password + signup), callback page, pending page

**Files:**
- Create: `webapp/lib/auth/supabase-browser.ts`, `webapp/lib/system-language/login-messages.ts`, `webapp/components/auth/GoogleIcon.tsx`, `webapp/components/auth/login-card-model.ts`, `webapp/components/auth/login-card-model.test.ts`, `webapp/components/auth/login-card-layout.test.ts`, `webapp/components/auth/LoginCard.tsx`, `webapp/app/auth/callback/page.tsx`, `webapp/app/pending/page.tsx`
- Modify: `webapp/app/(login)/login/page.tsx` (render `LoginCard`, keep the legacy-pairing-param cleanup effect), `webapp/app/globals.css`, `webapp/components/live/admin-login-route.test.ts` (update the two assertions that pin old copy), `webapp/package.json`

**Interfaces (produced, `login-card-model.ts`):**

```ts
export type LoginMode = "signin" | "signup";
export type IdentifierKind = "email" | "legacy-id" | "invalid";
export function classifyIdentifier(value: string): IdentifierKind;          // "@" → email (validated), non-empty HOST_ID → legacy-id
export function validateSignup(input: { name: string; email: string; password: string }): { name?: string; email?: string; password?: string }; // message keys
export function readDesktopLoginParams(search: string): { client: "desktop"; state: string } | null; // requires state /^[A-Za-z0-9_-]{43}$/
export function buildDesktopGoogleStartUrl(origin: string, state: string): string; // `${origin}/login?client=desktop&state=${state}&auto=google`
export function buildCallbackRedirect(origin: string, desktop: { state: string } | null): string; // `${origin}/auth/callback` or `${origin}/auth/callback?client=desktop&state=…`
export function readCallbackParams(search: string): { client: "desktop"; state: string } | { client: "web" };
export function safeSupabaseErrorMessage(search: string): string | null; // error_description ≤ 200 chars, control chars stripped, else null
```

Behaviour contract:
- One card, top to bottom: **"Google로 계속"** (full-width, only `live-primary-action`), divider "또는", identifier field (label "이메일 또는 아이디"), password field with show/hide toggle button (`aria-pressed`), submit "로그인", footer links "회원가입" (switches mode in place) and "비밀번호 재설정" (`supabase.auth.resetPasswordForEmail`, shown as a text button that needs the email filled).
- Sign-in submit: `classifyIdentifier` → `email` ⇒ `supabase.auth.signInWithPassword({ email, password })` then `POST /api/auth/exchange { accessToken: session.access_token, client, state }` → `window.location.assign(data.next)` (or for desktop: show "앱으로 돌아가기" link when `next` starts with `nova://`, and also `window.location.assign(next)`); `legacy-id` ⇒ existing `POST /api/login { id, password }` flow, unchanged, including the 429 retry timer already in the page.
- Signup mode: name, email, password (≥ 8) → `supabase.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: buildCallbackRedirect(origin, null) } })` → success state "이메일을 확인해 주세요" with the email shown.
- Google: `supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: buildCallbackRedirect(origin, desktop) } })`. When `readDesktopLoginParams` says desktop **and** `window.novaDesktopLogin` exists (inside the Electron window), the button instead calls `window.novaDesktopLogin.openExternal(buildDesktopGoogleStartUrl(origin, state))` and shows "시스템 브라우저에서 Google 로그인을 계속하세요." When `?auto=google` is present (we are in the system browser), start `signInWithOAuth` automatically on mount.
- Inline validation on blur; errors below the field (`FormError`); `aria-busy` on the form while submitting; all buttons `min-height: 44px`.

- [ ] **Step 1: Write failing tests**

```ts
// webapp/components/auth/login-card-model.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildCallbackRedirect, buildDesktopGoogleStartUrl, classifyIdentifier, readCallbackParams, readDesktopLoginParams, safeSupabaseErrorMessage, validateSignup } from "./login-card-model";

const state = "s".repeat(43);

test("identifier routing: emails go to Supabase, host ids to the legacy route, junk is invalid", () => {
  assert.equal(classifyIdentifier(" Noel@Example.com "), "email");
  assert.equal(classifyIdentifier("noel"), "legacy-id");
  assert.equal(classifyIdentifier("noel kim"), "invalid");
  assert.equal(classifyIdentifier("@nope"), "invalid");
  assert.equal(classifyIdentifier(""), "invalid");
});

test("signup validation returns message keys per field", () => {
  assert.deepEqual(validateSignup({ name: "", email: "bad", password: "short" }), { name: "nameRequired", email: "emailInvalid", password: "passwordTooShort" });
  assert.deepEqual(validateSignup({ name: "Noel", email: "n@x.io", password: "12345678" }), {});
});

test("desktop params require a 43-char state and build the system-browser start URL", () => {
  assert.deepEqual(readDesktopLoginParams(`?client=desktop&state=${state}`), { client: "desktop", state });
  assert.equal(readDesktopLoginParams("?client=desktop&state=short"), null);
  assert.equal(readDesktopLoginParams("?client=web"), null);
  assert.equal(buildDesktopGoogleStartUrl("https://nova.test", state), `https://nova.test/login?client=desktop&state=${state}&auto=google`);
  assert.equal(buildCallbackRedirect("https://nova.test", { state }), `https://nova.test/auth/callback?client=desktop&state=${state}`);
  assert.equal(buildCallbackRedirect("https://nova.test", null), "https://nova.test/auth/callback");
  assert.deepEqual(readCallbackParams(`?client=desktop&state=${state}`), { client: "desktop", state });
  assert.deepEqual(readCallbackParams("?client=desktop&state=x"), { client: "web" });
});

test("supabase error descriptions are bounded and sanitized", () => {
  assert.equal(safeSupabaseErrorMessage("?error=access_denied&error_description=User+cancelled"), "User cancelled");
  assert.equal(safeSupabaseErrorMessage(`?error_description=${"a".repeat(300)}`)?.length, 200);
  assert.equal(safeSupabaseErrorMessage("?error_description=%0Aline%07bell"), "linebell");
  assert.equal(safeSupabaseErrorMessage("?ok=1"), null);
});
```

```ts
// webapp/components/auth/login-card-layout.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const card = readFileSync(resolve(process.cwd(), "components/auth/LoginCard.tsx"), "utf8");
const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const callback = readFileSync(resolve(process.cwd(), "app/auth/callback/page.tsx"), "utf8");
const pending = readFileSync(resolve(process.cwd(), "app/pending/page.tsx"), "utf8");
const messages = readFileSync(resolve(process.cwd(), "lib/system-language/login-messages.ts"), "utf8");

test("the card has exactly one primary action (Google), then a divider, then the credential form, then quiet links", () => {
  const googleIndex = card.indexOf('data-auth-action="google"');
  const dividerIndex = card.indexOf('className="auth-divider"');
  const formIndex = card.indexOf('data-auth-action="submit"');
  const linksIndex = card.indexOf('className="auth-links"');
  assert.ok(googleIndex > -1 && googleIndex < dividerIndex && dividerIndex < formIndex && formIndex < linksIndex);
  assert.equal((card.match(/live-primary-action/gu) ?? []).length, 1, "only the Google button is primary");
  assert.match(card, /<GoogleIcon/u);
  assert.doesNotMatch(card, /[\u{1F300}-\u{1FAFF}]/u, "no emoji icons");
});

test("password visibility toggle, blur validation, busy state, and signup mode exist", () => {
  assert.match(card, /aria-pressed=\{showPassword\}/u);
  assert.match(card, /onBlur=\{/u);
  assert.match(card, /aria-busy=\{submitting\}/u);
  assert.match(card, /mode === "signup"/u);
  assert.match(card, /signUp\(\{/u);
  assert.match(card, /signInWithPassword\(\{/u);
  assert.match(card, /signInWithOAuth\(\{ provider: "google"/u);
  assert.match(card, /fetch\("\/api\/auth\/exchange"/u);
  assert.match(card, /fetch\("\/api\/login"/u, "legacy id login remains");
  assert.match(card, /window\.novaDesktopLogin\?\.openExternal\(/u);
});

test("styles: 375px single column, 44px targets, focus ring kept", () => {
  assert.match(css, /\.auth-card \{[^}]*max-width:\s*(?:26rem|28rem|420px|440px)/u);
  assert.match(css, /\.auth-card (?:button|\.auth-button)[^{]*\{[^}]*min-height:\s*44px/u);
  assert.match(css, /\.auth-divider/u);
  assert.match(css, /\.auth-links a,\s*\.auth-links button[^{]*\{[^}]*min-height:\s*44px/u);
  assert.doesNotMatch(css, /\.auth-card [^{]*\{[^}]*outline:\s*none/u);
});

test("callback and pending pages: exchange, safe error text, desktop return button, logout", () => {
  assert.match(callback, /getSession\(\)/u);
  assert.match(callback, /fetch\("\/api\/auth\/exchange"/u);
  assert.match(callback, /safeSupabaseErrorMessage\(/u);
  assert.match(callback, /startsWith\("nova:\/\/"\)/u);
  assert.match(pending, /signOut\(\)/u);
  assert.match(pending, /fetch\("\/api\/logout"/u);
  for (const key of ["googleContinue", "or", "identifier", "password", "signIn", "signUp", "resetPassword", "checkEmail", "pendingTitle", "returnToApp"]) {
    assert.match(messages, new RegExp(`\\b${key}:`, "u"), key);
  }
});
```

Update `webapp/components/live/admin-login-route.test.ts`: the test "admin sign-in page names the admin role and routes back to participant join" reads `app/(login)/login/page.tsx`; change it to read `components/auth/LoginCard.tsx` for the `참가자로 입장` / `href="/watch"` assertions and replace `/관리자\(호스트\) 로그인/u` with `/aria-label=\{t\("signInFormLabel"\)\}/u`. Keep `window.location.assign("/admin")` — the legacy-id branch still does exactly that; if it moves into `LoginCard.tsx`, point that assertion at the card source.

- [ ] **Step 2: Register and run to verify failure**

Append ` components/auth/login-card-model.test.ts components/auth/login-card-layout.test.ts` to `test:live`. Run them. Expected: FAIL.

- [ ] **Step 3: Implement the model, browser client, messages, icon**

`webapp/components/auth/login-card-model.ts`:

```ts
import { HOST_ID_PATTERN } from "@/lib/security/host-session-policy";

export type LoginMode = "signin" | "signup";
export type IdentifierKind = "email" | "legacy-id" | "invalid";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/u;
const STATE = /^[A-Za-z0-9_-]{43}$/u;

export function classifyIdentifier(value: string): IdentifierKind {
  const v = value.trim();
  if (!v) return "invalid";
  if (v.includes("@")) return EMAIL.test(v) ? "email" : "invalid";
  return HOST_ID_PATTERN.test(v) ? "legacy-id" : "invalid";
}

export function validateSignup(input: { name: string; email: string; password: string }) {
  const errors: { name?: string; email?: string; password?: string } = {};
  if (!input.name.trim()) errors.name = "nameRequired";
  if (!EMAIL.test(input.email.trim())) errors.email = "emailInvalid";
  if (input.password.length < 8) errors.password = "passwordTooShort";
  return errors;
}

export function readDesktopLoginParams(search: string): { client: "desktop"; state: string } | null {
  const params = new URLSearchParams(search);
  const state = params.get("state") ?? "";
  return params.get("client") === "desktop" && STATE.test(state) ? { client: "desktop", state } : null;
}
export const readCallbackParams = (search: string): { client: "desktop"; state: string } | { client: "web" } => readDesktopLoginParams(search) ?? { client: "web" };
export const buildDesktopGoogleStartUrl = (origin: string, state: string) => `${origin}/login?client=desktop&state=${state}&auto=google`;
export const buildCallbackRedirect = (origin: string, desktop: { state: string } | null) => desktop ? `${origin}/auth/callback?client=desktop&state=${desktop.state}` : `${origin}/auth/callback`;

export function safeSupabaseErrorMessage(search: string): string | null {
  const raw = new URLSearchParams(search).get("error_description");
  if (!raw) return null;
  const cleaned = raw.replace(/[ -]/gu, "").trim().slice(0, 200);
  return cleaned || null;
}
```

`webapp/lib/auth/supabase-browser.ts`:

```ts
"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
export function getBrowserSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) throw new Error("SUPABASE_PUBLIC_CONFIG_MISSING");
  client = createClient(url, key, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: false } });
  return client;
}
```

`webapp/components/auth/GoogleIcon.tsx` — the official four-colour "G" as inline SVG, `aria-hidden="true"`, 18×18, `focusable="false"` (paths: blue `#4285F4`, green `#34A853`, yellow `#FBBC05`, red `#EA4335`; use Google's published brand path data).

`webapp/lib/system-language/login-messages.ts` — `SystemMessages` with ko/en/ja for keys: `title` ("로그인"), `lede`, `googleContinue` ("Google로 계속"), `or` ("또는"), `identifier` ("이메일 또는 아이디"), `password` ("비밀번호"), `showPassword`, `hidePassword`, `signIn` ("로그인"), `signingIn`, `signUp` ("회원가입"), `signUpSubmit` ("가입 신청"), `backToSignIn`, `name` ("이름"), `email` ("이메일"), `resetPassword` ("비밀번호 재설정"), `resetSent`, `checkEmail` ("이메일을 확인해 주세요"), `checkEmailBody`, `nameRequired`, `emailInvalid`, `passwordTooShort`, `identifierInvalid`, `invalidCredentials`, `rateLimited`, `network`, `desktopGoogleHint` ("시스템 브라우저에서 Google 로그인을 계속하세요."), `returnToApp` ("앱으로 돌아가기"), `completing` ("로그인을 완료하는 중…"), `pendingTitle` ("승인 대기 중"), `pendingBody` ("관리자가 가입을 승인하면 로그인할 수 있습니다."), `signedInAs`, `logout` ("로그아웃"), `forbiddenRejected`, `forbiddenDisabled`, `emailUnconfirmed`, `participantEntry` ("참가자로 입장"), `participantQuestion` ("참가자이신가요?"), `signInFormLabel` ("로그인 정보 입력"). Every key in all three languages.

- [ ] **Step 4: Implement `LoginCard.tsx`, pages, CSS**

`LoginCard.tsx` (client component) — structure the JSX exactly in this order so the layout test passes:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { FormButton, FormError, FormField } from "@/components/ui/FormControls";
import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { loginMessages } from "@/lib/system-language/login-messages";
import { getBrowserSupabase } from "@/lib/auth/supabase-browser";
import { getLoginRetryDeadline, getLoginRetrySeconds } from "@/app/(login)/login/login-retry";
import { GoogleIcon } from "./GoogleIcon";
import { buildCallbackRedirect, buildDesktopGoogleStartUrl, classifyIdentifier, readDesktopLoginParams, validateSignup, type LoginMode } from "./login-card-model";

declare global { interface Window { novaDesktopLogin?: { openExternal(url: string): Promise<boolean> } } }

export function LoginCard() {
  const t = useSystemText(loginMessages);
  const [mode, setMode] = useState<LoginMode>("signin");
  const [identifier, setIdentifier] = useState(""); const [password, setPassword] = useState(""); const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string; identifier?: string }>({});
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [desktopNext, setDesktopNext] = useState("");
  const [retryUntil, setRetryUntil] = useState(0); const [clock, setClock] = useState(Date.now);
  const desktop = typeof window === "undefined" ? null : readDesktopLoginParams(window.location.search);
  const submissionRef = useRef<AbortController | null>(null);
  const retrySeconds = getLoginRetrySeconds(retryUntil, clock);
  // …retry interval effect identical to the old page…

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("auto") === "google") void startGoogle();
  }, []);

  async function exchange(accessToken: string) {
    const response = await fetch("/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, client: desktop ? "desktop" : "web", state: desktop?.state }) });
    const body = await response.json().catch(() => null);
    if (response.status === 429) { /* same retry handling as legacy */ setError(t("rateLimited")); return; }
    if (response.status === 403) { setError(t(body?.code === "PROFILE_DISABLED" ? "forbiddenDisabled" : body?.code === "EMAIL_UNCONFIRMED" ? "emailUnconfirmed" : "forbiddenRejected")); return; }
    if (!response.ok || typeof body?.data?.next !== "string") { setError(t("invalidCredentials")); return; }
    if (body.data.next.startsWith("nova://")) { setDesktopNext(body.data.next); window.location.assign(body.data.next); return; }
    window.location.assign(body.data.next);
  }

  async function startGoogle() {
    setError("");
    const origin = window.location.origin;
    if (desktop && window.novaDesktopLogin) { await window.novaDesktopLogin?.openExternal(buildDesktopGoogleStartUrl(origin, desktop.state)); setNotice(t("desktopGoogleHint")); return; }
    const { error: oauthError } = await getBrowserSupabase().auth.signInWithOAuth({ provider: "google", options: { redirectTo: buildCallbackRedirect(origin, desktop) } });
    if (oauthError) setError(t("network"));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || retrySeconds > 0) return;
    setError(""); setSubmitting(true);
    try {
      if (mode === "signup") {
        const errors = validateSignup({ name, email: identifier, password }); setFieldErrors(errors);
        if (Object.keys(errors).length) return;
        const { error: signUpError } = await getBrowserSupabase().auth.signUp({ email: identifier.trim(), password, options: { data: { full_name: name.trim() }, emailRedirectTo: buildCallbackRedirect(window.location.origin, null) } });
        if (signUpError) { setError(t("network")); return; }
        setNotice(t("checkEmail")); setPassword(""); return;
      }
      const kind = classifyIdentifier(identifier);
      if (kind === "invalid") { setFieldErrors({ identifier: "identifierInvalid" }); return; }
      if (kind === "legacy-id") { await legacyLogin(identifier.trim(), password); return; } // the old /api/login flow, verbatim, ending in window.location.assign("/admin")
      const { data, error: signInError } = await getBrowserSupabase().auth.signInWithPassword({ email: identifier.trim(), password });
      if (signInError || !data.session) { setError(t("invalidCredentials")); return; }
      await exchange(data.session.access_token);
    } catch { setError(t("network")); }
    finally { setSubmitting(false); }
  }
  // …legacyLogin(id, password) = the existing page's handleSubmit body (fetch("/api/login"), 429 → retry deadline, ok → window.location.assign("/admin"))…

  return (
    <main className="live-viewer-shell is-join live-login-shell">
      <div className="live-join-lobby">
        <section className="live-join-context" aria-labelledby="live-login-title">
          <header className="live-join-brand"><span className="live-join-wordmark">NOVA</span></header>
          <div className="live-join-context-body"><h1 id="live-login-title" className="live-join-heading">{t("title")}</h1><p className="live-join-lede">{t("lede")}</p></div>
          <p className="live-join-admin live-login-role-switch">{t("participantQuestion")} <a href="/watch">{t("participantEntry")}</a></p>
          <footer className="live-join-credit">Realtime by Noel</footer>
        </section>
        <section className="live-join-card live-login-card auth-card" aria-label={t("signInFormLabel")}>
          <button type="button" className="live-primary-action auth-button auth-google" data-auth-action="google" onClick={() => void startGoogle()} disabled={submitting}>
            <GoogleIcon /> <span>{t("googleContinue")}</span>
          </button>
          {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
          {desktopNext ? <a className="auth-button auth-secondary" href={desktopNext}>{t("returnToApp")}</a> : null}
          <div className="auth-divider" role="separator" aria-label={t("or")}><span>{t("or")}</span></div>
          <form onSubmit={handleSubmit} className="live-login-form auth-form" aria-busy={submitting} noValidate>
            {mode === "signup" ? <FormField id="signup-name" name="name" label={t("name")} type="text" autoComplete="name" className="live-name-input" value={name}
              onChange={(e) => setName(e.target.value)} onBlur={() => setFieldErrors((f) => ({ ...f, name: name.trim() ? undefined : "nameRequired" }))} disabled={submitting} required /> : null}
            {fieldErrors.name ? <FormError>{t(fieldErrors.name)}</FormError> : null}
            <FormField id="login-identifier" name="identifier" label={t(mode === "signup" ? "email" : "identifier")} type={mode === "signup" ? "email" : "text"}
              autoComplete={mode === "signup" ? "email" : "username"} className="live-name-input" autoCapitalize="none" spellCheck={false} value={identifier}
              onChange={(e) => { setIdentifier(e.target.value); setError(""); }} onBlur={() => { /* set identifier/email field error via classifyIdentifier or validateSignup */ }} disabled={submitting} required />
            {fieldErrors.identifier || fieldErrors.email ? <FormError>{t(fieldErrors.identifier ?? fieldErrors.email ?? "")}</FormError> : null}
            <div className="auth-password">
              <FormField id="login-password" name="password" label={t("password")} type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"}
                className="live-name-input" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} onBlur={() => { if (mode === "signup") setFieldErrors((f) => ({ ...f, password: password.length < 8 ? "passwordTooShort" : undefined })); }} disabled={submitting} required />
              <button type="button" className="auth-password-toggle" aria-pressed={showPassword} aria-label={t(showPassword ? "hidePassword" : "showPassword")} onClick={() => setShowPassword((v) => !v)}>{/* eye SVG */}</button>
            </div>
            {fieldErrors.password ? <FormError>{t(fieldErrors.password)}</FormError> : null}
            {error ? <FormError>{error}</FormError> : null}
            {retrySeconds > 0 ? <p id="login-retry-status" role="timer">{t("retryIn", { seconds: retrySeconds })}</p> : null}
            <FormButton type="submit" className="auth-button auth-submit" data-auth-action="submit" disabled={submitting || retrySeconds > 0}>
              {t(mode === "signup" ? "signUpSubmit" : submitting ? "signingIn" : "signIn")}
            </FormButton>
          </form>
          <div className="auth-links">
            <button type="button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setFieldErrors({}); setError(""); setNotice(""); }}>{t(mode === "signup" ? "backToSignIn" : "signUp")}</button>
            {mode === "signin" ? <button type="button" onClick={() => void resetPassword()}>{t("resetPassword")}</button> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
```

Fill every `/* … */` with real code before finishing: the retry-interval effect and `legacyLogin` are copied from the current `page.tsx`; `resetPassword()` calls `getBrowserSupabase().auth.resetPasswordForEmail(identifier.trim(), { redirectTo: buildCallbackRedirect(window.location.origin, null) })` when `classifyIdentifier(identifier) === "email"`, else sets `fieldErrors.identifier = "emailInvalid"`, and on success sets `notice = t("resetSent")`. Add `retryIn` to the messages ("{seconds}초 후 다시 시도할 수 있습니다.").

`webapp/app/(login)/login/page.tsx` becomes: the legacy `pair/sig/exp` cleanup `useEffect` + `return <LoginCard />;`.

`webapp/app/auth/callback/page.tsx` (client): on mount read `readCallbackParams(location.search)` and `safeSupabaseErrorMessage(location.search)`; if error → show it in a card with a "로그인으로" link. Else `const { data } = await getBrowserSupabase().auth.getSession()`; if no session → wait for `onAuthStateChange` once (PKCE code exchange completes asynchronously) with a 10 s timeout → error state. With a session → `POST /api/auth/exchange` (same body/handling as the card) → `window.location.assign(next)`; if `next.startsWith("nova://")` also render `<a href={next}>{t("returnToApp")}</a>`. Show `t("completing")` with `role="status"` while working. Wrap the component in `<Suspense>` is unnecessary since we read `window.location`, not `useSearchParams`.

`webapp/app/pending/page.tsx` (client): card with `t("pendingTitle")`, `t("pendingBody")`, the signed-in email from `getBrowserSupabase().auth.getUser()` (if available), and a `logout` button that runs `await getBrowserSupabase().auth.signOut(); await fetch("/api/logout", { method: "POST" }); window.location.assign("/login");`.

CSS (`globals.css`, append):

```css
.auth-card { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 26rem; }
.auth-card .auth-button { min-height: 44px; width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 10px; border-radius: 12px; font-weight: 600; }
.auth-google svg { width: 18px; height: 18px; flex: none; }
.auth-divider { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 0.875rem; }
.auth-divider::before, .auth-divider::after { content: ""; flex: 1; height: 1px; background: currentColor; opacity: 0.35; }
.auth-form { display: flex; flex-direction: column; gap: 12px; }
.auth-password { position: relative; }
.auth-password .auth-password-toggle { position: absolute; right: 6px; bottom: 4px; min-width: 44px; min-height: 44px; background: transparent; border: 0; color: var(--muted); cursor: pointer; }
.auth-notice { margin: 0; font-size: 0.9375rem; line-height: 1.5; }
.auth-links { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
.auth-links a, .auth-links button { min-height: 44px; display: inline-flex; align-items: center; padding: 0 8px; background: transparent; border: 0; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
@media (max-width: 767px) { .auth-card { max-width: none; } }
```

Do not add `outline: none` anywhere under `.auth-card`.

- [ ] **Step 5: Run tests, typecheck, and a visual check**

Run: `npm --prefix /Users/kyeongmankim/Realtime/autopreso/webapp test` and `npm --prefix /Users/kyeongmankim/Realtime/autopreso/webapp run typecheck`. Expected PASS/clean.
Visual: `npm --prefix webapp run dev` (or the existing `.claude/launch.json` entry if present) and open `/login` at 375×812 and 1280×800; confirm the order Google → divider → fields → links, 44px targets, and that the legacy id `noel` + password still lands on `/admin` in development (`ADMIN_USER_IDS`/`ADMIN_PASSWORD` from `.env.local`). Without Supabase public env the Google button must show `t("network")` rather than throwing (wrap `getBrowserSupabase()` in try/catch inside `startGoogle`, `handleSubmit`, `resetPassword`).

- [ ] **Step 6: Commit**

```bash
git add webapp/components/auth/LoginCard.tsx webapp/components/auth/GoogleIcon.tsx webapp/components/auth/login-card-model.ts webapp/components/auth/login-card-model.test.ts webapp/components/auth/login-card-layout.test.ts webapp/lib/auth/supabase-browser.ts webapp/lib/system-language/login-messages.ts "webapp/app/(login)/login/page.tsx" webapp/app/auth/callback/page.tsx webapp/app/pending/page.tsx webapp/app/globals.css webapp/components/live/admin-login-route.test.ts webapp/package.json
git commit -m "feat(auth): login card with Google, email/password, signup, callback and pending pages"
```

---

### Task 6: Desktop deep-link login (`nova://`), preload bridge, login window

**Files:**
- Create: `electron/desktop-auth-deep-link.js`, `electron/desktop-login-preload.js`, `test/desktop-auth-deep-link.test.js`
- Modify: `electron/desktop-host-login-window.js`, `electron/main.js`, `package.json` (root, `build.protocols`), `test/desktop-host-login-window.test.js`, `test/desktop-host-auth-boundaries.test.js`

**Interfaces (produced, `electron/desktop-auth-deep-link.js`):**

```js
export const DESKTOP_AUTH_SCHEME = "nova";
export function createDesktopLoginState(randomBytesFn = crypto.randomBytes) → string  // 43-char base64url
export function parseDesktopAuthDeepLink(value) → { code: string, state: string } | null   // nova://auth/callback?code=<64 hex>&state=<43 base64url>
export function findDesktopAuthDeepLink(argv) → string | null   // Windows/Linux second-instance argv
export function buildDesktopLoginUrl(baseUrl, state) → string  // `${origin}/login?client=desktop&state=${state}`
export function isAllowedDesktopExternalLogin(value, baseUrl) → boolean // same origin, path "/login", client=desktop, valid state, auto=google, no other params
```

`openDesktopHostLogin` gains two options: `state` (string) and `onControls({ verifyExternal })`; it loads `buildDesktopLoginUrl(baseUrl, state)` and sets `webPreferences.preload` to `desktop-login-preload.js`. `verifyExternal()` runs the same `hostSession.ensureSession({ force: true })` verification as an authenticated navigation.

- [ ] **Step 1: Write failing tests**

```js
// test/desktop-auth-deep-link.test.js
import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopLoginUrl, createDesktopLoginState, findDesktopAuthDeepLink, isAllowedDesktopExternalLogin, parseDesktopAuthDeepLink } from "../electron/desktop-auth-deep-link.js";

const state = "A".repeat(43);
const code = "b".repeat(64);
const base = "https://workspace.example.test";

test("state is 32 random bytes as base64url", () => {
  const value = createDesktopLoginState(() => Buffer.alloc(32, 1));
  assert.match(value, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(value, Buffer.alloc(32, 1).toString("base64url"));
});

test("deep link parsing accepts only nova://auth/callback with a 64-hex code and 43-char state", () => {
  assert.deepEqual(parseDesktopAuthDeepLink(`nova://auth/callback?code=${code}&state=${state}`), { code, state });
  for (const bad of [`nova://auth/other?code=${code}&state=${state}`, `nova://auth/callback?code=xyz&state=${state}`, `nova://auth/callback?code=${code}&state=short`,
    `https://auth/callback?code=${code}&state=${state}`, `nova://auth/callback?code=${code}&state=${state}&extra=1`, "", null, 42]) {
    assert.equal(parseDesktopAuthDeepLink(bad), null, String(bad));
  }
});

test("argv scanning finds the deep link and ignores everything else", () => {
  assert.equal(findDesktopAuthDeepLink(["NOVA.exe", "--flag", `nova://auth/callback?code=${code}&state=${state}`]), `nova://auth/callback?code=${code}&state=${state}`);
  assert.equal(findDesktopAuthDeepLink(["NOVA.exe", "https://example.com"]), null);
});

test("login URL and external-login allowlist are bound to the workspace origin", () => {
  assert.equal(buildDesktopLoginUrl(`${base}/`, state), `${base}/login?client=desktop&state=${state}`);
  assert.equal(isAllowedDesktopExternalLogin(`${base}/login?client=desktop&state=${state}&auto=google`, base), true);
  assert.equal(isAllowedDesktopExternalLogin(`https://evil.example/login?client=desktop&state=${state}&auto=google`, base), false);
  assert.equal(isAllowedDesktopExternalLogin(`${base}/admin?client=desktop&state=${state}&auto=google`, base), false);
  assert.equal(isAllowedDesktopExternalLogin(`${base}/login?client=desktop&state=${state}`, base), false, "auto=google required");
  assert.equal(isAllowedDesktopExternalLogin(`${base}/login?client=desktop&state=${state}&auto=google&x=1`, base), false, "no extra params");
});
```

Add to `test/desktop-host-login-window.test.js` (using its existing `harness`, extend the harness to accept `state` and capture `controls` via `onControls`):

```js
test("login window loads the desktop login URL with state, attaches the login preload, and verifies external deep-link logins", async () => {
  const state = "A".repeat(43);
  let controls;
  const { windows, result } = harness({ state, onControls: (c) => { controls = c; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(windows[0].loadedUrl, `https://workspace.example.test/login?client=desktop&state=${state}`);
  assert.match(windows[0].options.webPreferences.preload, /desktop-login-preload\.js$/u);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  await controls.verifyExternal();
  assert.deepEqual(await result, success);
  assert.equal(windows[0].destroyed, true);
});
```

Add to `test/desktop-host-auth-boundaries.test.js` (source-regex style like the rest of that file; read it first to reuse its `read`/`main` variables):

```js
test("main registers the nova scheme, parses deep links on macOS and Windows, checks state, and exchanges the code over the default session", () => {
  assert.match(main, /app\.setAsDefaultProtocolClient\("nova"\)/u);
  assert.match(main, /app\.on\("open-url", \(event, url\) => \{\s*event\.preventDefault\(\);\s*void handleDesktopAuthDeepLink\(url\);/u);
  assert.match(main, /findDesktopAuthDeepLink\(argv\)/u);
  assert.match(main, /if \(!parsed \|\| !pendingDesktopLoginState \|\| parsed\.state !== pendingDesktopLoginState\)/u);
  assert.match(main, /"\/api\/auth\/desktop-exchange"/u);
  assert.match(main, /ipcMain\.handle\("desktop-login:open-external"/u);
  assert.match(main, /isAllowedDesktopExternalLogin\(/u);
  assert.doesNotMatch(main, /console\.[a-z]+\([^)]*(?:parsed\.code|deepLink|deep_link)/u, "codes and deep links are never logged");
});
```

Run all three files: expected FAIL.

- [ ] **Step 2: Implement `desktop-auth-deep-link.js`**

```js
import crypto from "node:crypto";

export const DESKTOP_AUTH_SCHEME = "nova";
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const CODE = /^[0-9a-f]{64}$/u;

export function createDesktopLoginState(randomBytesFn = crypto.randomBytes) {
  return Buffer.from(randomBytesFn(32)).toString("base64url");
}

export function parseDesktopAuthDeepLink(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${DESKTOP_AUTH_SCHEME}:` || url.host !== "auth" || url.pathname !== "/callback") return null;
  const keys = [...url.searchParams.keys()].sort();
  if (keys.join(",") !== "code,state") return null;
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  return CODE.test(code) && STATE.test(state) ? { code, state } : null;
}

export function findDesktopAuthDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((arg) => typeof arg === "string" && arg.startsWith(`${DESKTOP_AUTH_SCHEME}://`) && parseDesktopAuthDeepLink(arg)) ?? null;
}

export function buildDesktopLoginUrl(baseUrl, state) {
  const url = new URL("/login", baseUrl);
  url.search = new URLSearchParams({ client: "desktop", state }).toString();
  return url.href;
}

export function isAllowedDesktopExternalLogin(value, baseUrl) {
  if (typeof value !== "string" || /[\r\n]/u.test(value) || value.length > 512) return false;
  let target; let origin;
  try { target = new URL(value); origin = new URL(baseUrl).origin; } catch { return false; }
  if (target.origin !== origin || target.pathname !== "/login" || target.username || target.password || target.hash) return false;
  const keys = [...target.searchParams.keys()].sort().join(",");
  return keys === "auto,client,state" && target.searchParams.get("client") === "desktop"
    && target.searchParams.get("auto") === "google" && STATE.test(target.searchParams.get("state") ?? "");
}
```

- [ ] **Step 3: Preload and login window**

`electron/desktop-login-preload.js` (CommonJS like `electron/preload.js`):

```js
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("novaDesktopLogin", {
  openExternal: (url) => ipcRenderer.invoke("desktop-login:open-external", url),
});
```

`electron/desktop-host-login-window.js`: add `state` and `onControls` to the destructured options; set `preload: fileURLToPath(new URL("./desktop-login-preload.js", import.meta.url))` in `webPreferences` (import `fileURLToPath` from `node:url`); load `buildDesktopLoginUrl(baseUrl, state)` instead of `new URL("/login", baseUrl).href`; after `onWindow(window)` call `onControls?.({ verifyExternal: () => verifyNavigation(null, new URL("/admin", baseUrl).href) })`. `classifyDesktopLoginNavigation` already treats `/login` with any query as `login`, so the state query does not change the navigation guard.

- [ ] **Step 4: Main process**

In `electron/main.js`:

```js
import { createDesktopLoginState, findDesktopAuthDeepLink, isAllowedDesktopExternalLogin, parseDesktopAuthDeepLink } from "./desktop-auth-deep-link.js";

let pendingDesktopLoginState = "";
let desktopLoginControls = null;

// next to requestSingleInstanceLock():
app.setAsDefaultProtocolClient("nova");
app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleDesktopAuthDeepLink(url);
});
// inside the existing second-instance handler, before showDashboardWindow():
app.on("second-instance", (_event, argv) => {
  const deepLink = findDesktopAuthDeepLink(argv);
  if (deepLink) { void handleDesktopAuthDeepLink(deepLink); return; }
  showDashboardWindow();
  if (overlayEnabled) maintainOverlayWindow();
});

async function handleDesktopAuthDeepLink(url) {
  const parsed = parseDesktopAuthDeepLink(url);
  if (!parsed || !pendingDesktopLoginState || parsed.state !== pendingDesktopLoginState) {
    if (desktopLoginWindow && !desktopLoginWindow.isDestroyed()) void showDesktopLoginFailure({ ok: false, code: "DESKTOP_LOGIN_STATE_MISMATCH" });
    return;
  }
  pendingDesktopLoginState = "";
  const baseUrl = resolveLiveWorkspaceUrl();
  const origin = new URL(baseUrl).origin;
  let ok = false;
  try {
    const response = await session.defaultSession.fetch(new URL("/api/auth/desktop-exchange", origin).href, {
      method: "POST", credentials: "include", redirect: "error",
      headers: { origin, "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ code: parsed.code, state: parsed.state }),
      signal: AbortSignal.timeout(15_000),
    });
    ok = response.ok;
  } catch { ok = false; }
  if (!ok) { void showDesktopLoginFailure({ ok: false, code: "DESKTOP_LOGIN_EXCHANGE_FAILED" }); return; }
  desktopHostSession?.invalidate();
  await desktopLoginControls?.verifyExternal();
  if (desktopLoginWindow && !desktopLoginWindow.isDestroyed()) { desktopLoginWindow.show(); desktopLoginWindow.focus(); }
}
```

In `openHostLoginWindow()`: `pendingDesktopLoginState = createDesktopLoginState();` before calling `openDesktopHostLogin`, pass `state: pendingDesktopLoginState` and `onControls: (controls) => { desktopLoginControls = controls; }`, and in the `.finally` also reset `desktopLoginControls = null; pendingDesktopLoginState = "";`.

IPC (register next to `ipcMain.handle("host-session:logout", …)`):

```js
ipcMain.handle("desktop-login:open-external", (event, value) => {
  if (!desktopLoginWindow || event.sender !== desktopLoginWindow.webContents) return false;
  if (!isAllowedDesktopExternalLogin(value, resolveLiveWorkspaceUrl())) return false;
  if (!parseDesktopAuthDeepLink) return false;
  const state = new URL(value).searchParams.get("state");
  if (state !== pendingDesktopLoginState) return false;
  void shell.openExternal(value).catch(() => {});
  return true;
});
```

(Remove the meaningless `if (!parseDesktopAuthDeepLink)` line — it is shown only so you do not add a stray check; the three real gates are: sender is the login window, URL passes the allowlist, state matches.)

`showDesktopLoginFailure` message mapping: add `hostSession.deepLinkFailed` to the desktop i18n dictionary used by `translate(...)` (find the file that defines `hostSession.verifyFailed` with `grep -rn "verifyFailed" electron public/*.js`) in ko/en/ja: "시스템 브라우저 로그인을 확인하지 못했습니다. 다시 시도해 주세요." and use it when `result.code` starts with `DESKTOP_LOGIN_`.

Root `package.json` → `build`: add

```json
"protocols": [{ "name": "NOVA", "schemes": ["nova"] }],
```

- [ ] **Step 5: Run root tests + typecheck**

Run: `npm test` (root) and `npm run typecheck` from the repo root. Expected: all PASS (the desktop suites read `electron/main.js` as text). Then `npm run desktop` and confirm: the login window opens `/login?client=desktop&state=…`; clicking "Google로 계속" opens the system browser at the workspace `/login?...&auto=google` (in development the workspace URL is whatever `resolveLiveWorkspaceUrl()` returns — if it is production, stop after confirming the browser opened; do not sign in with real credentials during development testing).

- [ ] **Step 6: Commit**

```bash
git add electron/desktop-auth-deep-link.js electron/desktop-login-preload.js electron/desktop-host-login-window.js electron/main.js package.json test/desktop-auth-deep-link.test.js test/desktop-host-login-window.test.js test/desktop-host-auth-boundaries.test.js
git commit -m "feat(desktop): Google login via system browser and nova:// deep link exchanged for the host cookie"
```

Also add the i18n dictionary file you edited to that `git add` line.

---

### Task 7: Documentation, env example, and deploy checklist

**Files:**
- Modify: `webapp/.env.example` (add `ADMIN_BOOTSTRAP_EMAILS=` with a comment), `supabase/README.md` (migration `202609020002` + Auth dashboard steps), `AGENTS.md` (Live translation architecture → add a "Host identity" paragraph: Supabase Auth → exchange → `rnw_session`; profile `host_id` is the cookie subject; `requireHost` status gate), memory file `~/.claude/projects/-Users-kyeongmankim-Realtime-autopreso/memory/live-call-host-auth-contract.md` (append the new contract).

- [ ] **Step 1: Edit the docs**

`.env.example`:

```
# Supabase Auth bootstrap: these emails become approved admins on first login and
# inherit the first ADMIN_USER_IDS entry as their host_id so existing sessions stay owned.
ADMIN_BOOTSTRAP_EMAILS=
```

`supabase/README.md` — add the migration to the ordered list and a "Authentication 설정" subsection with the four user steps from spec §8 (Google OAuth client → Supabase Google provider → URL Configuration `https://realtime-noel-web.vercel.app/auth/callback` + email confirmation on → Vercel `ADMIN_BOOTSTRAP_EMAILS`). No secrets.

- [ ] **Step 2: Run the whole verification set**

```bash
npm test
npm run typecheck
npm --prefix webapp test
npm --prefix webapp run typecheck
```

Expected: all green on the working tree.

- [ ] **Step 3: Commit**

```bash
git add webapp/.env.example supabase/README.md AGENTS.md
git commit -m "docs(auth): Supabase Auth bootstrap env, migration order, and host identity contract"
```

---

## Self-review

- **Spec coverage:** §0 decisions → all tasks; §1 tables/RPCs (profiles, profile_events, desktop_login_codes, RLS, `upsert/read/issue/consume`) → Task 1; `engine_defaults`, `console_settings`, approve/reject/list/set RPCs → Plan B (explicitly deferred); `host_id` ownership → Global Constraints deviation + Task 1; seed via `ADMIN_BOOTSTRAP_EMAILS` → Tasks 2–3; §2 login card, callback, pending, exchange, logout, `requireHost` gate, middleware → Tasks 3–5 (the `/console` middleware rule is Plan B since `/console` does not exist yet); §3 desktop → Task 6; §7 security (server-side getUser, origin, rate limits, sha256 one-shot codes, no logging) → Tasks 2, 3, 6; §8 tests → each task; user checklist and deploy order → Task 7 + the hand-off below.
- **Placeholders:** the only elided blocks in Task 5 are marked to be copied from the existing page verbatim (retry timer, legacy login) and named precisely; the eye-icon SVG is any 24×24 Lucide `eye`/`eye-off` path.
- **Type consistency:** `ProfileRecord.hostId` ↔ `createSessionToken(hostId)`; `DESKTOP_STATE_PATTERN` 43 chars everywhere (SQL check, model, deep link); code is 64 hex everywhere; `assertHostApproved` returns `{ role }` used by both `requireHost` (ignored) and the session route.

## Hand-off notes

- **Do not deploy** from this plan. Production steps (apply migration, Vercel env `ADMIN_BOOTSTRAP_EMAILS`, Supabase Google provider, DMG with the `nova` scheme) require the user's go, in the order given in spec §8.
- The user must perform the Google Cloud + Supabase dashboard steps; the implementer never handles those secrets.
- Plan B (console) starts from this plan's `SupabaseProfileStore` and `assertHostApproved(...).role === "admin"`.
