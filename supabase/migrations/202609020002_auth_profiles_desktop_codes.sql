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
