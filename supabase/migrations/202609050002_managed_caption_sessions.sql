-- 2026-09-05 feat: A signed caption ticket cannot revive a host-ended session.
-- Existing profiles/sessions are preserved; only new managed caption sessions create rows.
create table if not exists public.managed_caption_sessions (
  id uuid primary key,
  host_id text not null,
  engine jsonb not null check(jsonb_typeof(engine) = 'object' and octet_length(engine::text) <= 4096),
  assignment_revision text not null check(assignment_revision ~ '^[1-9][0-9]{0,18}$'),
  languages text[] not null check(cardinality(languages) between 1 and 3),
  status text not null default 'active' check(status in ('active','stopped')),
  created_at timestamptz not null default statement_timestamp(),
  access_renewed_at timestamptz not null default statement_timestamp(),
  access_expires_at timestamptz not null,
  stopped_at timestamptz,
  check((status = 'stopped') = (stopped_at is not null)),
  check(access_expires_at <= access_renewed_at + interval '6 hours')
);
create index if not exists managed_caption_sessions_host_idx on public.managed_caption_sessions(host_id, created_at desc);
alter table public.managed_caption_sessions enable row level security;
revoke all on table public.managed_caption_sessions from public, anon, authenticated, service_role;

create or replace function public.create_managed_caption_session_v1(
  p_session_id uuid, p_host_id text, p_engine jsonb, p_assignment_revision text, p_languages text[]
)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare provider text; revision bigint; deadline timestamptz := statement_timestamp() + interval '6 hours';
begin
  if p_session_id is null or p_host_id is null or char_length(p_host_id) not between 1 and 128
    or p_engine is null or jsonb_typeof(p_engine) <> 'object' or octet_length(p_engine::text) > 4096
    or p_assignment_revision is null or p_assignment_revision !~ '^[1-9][0-9]{0,18}$'
    or p_languages is null or cardinality(p_languages) not between 1 and 3
    or array_position(p_languages, null) is not null
    or cardinality(p_languages) <> (select count(distinct language) from unnest(p_languages) language)
    or exists(select 1 from unnest(p_languages) language where language <> all(array['en','ko','ja','zh-Hans','zh-Hant','es','pt','fr','de','ru','hi','id','vi','it'])) then
    raise exception 'CAPTION_SESSION_INPUT_INVALID' using errcode = '22023';
  end if;
  select p.voice_provider, p.voice_provider_revision into provider, revision from public.profiles p
    where p.host_id = p_host_id and p.status = 'approved' for update;
  if not found or revision::text <> p_assignment_revision
    or (p_engine -> 'stt' ->> 'provider') is distinct from provider
    or (p_engine -> 'translation' ->> 'provider') is distinct from provider then
    raise exception 'CAPTION_ASSIGNMENT_CONFLICT' using errcode = '42501';
  end if;
  insert into public.managed_caption_sessions(id,host_id,engine,assignment_revision,languages,access_expires_at)
    values(p_session_id,p_host_id,p_engine,p_assignment_revision,p_languages,deadline);
  return deadline;
end;
$$;
revoke all on function public.create_managed_caption_session_v1(uuid,text,jsonb,text,text[]) from public, anon, authenticated, service_role;
grant execute on function public.create_managed_caption_session_v1(uuid,text,jsonb,text,text[]) to service_role;

create or replace function public.read_managed_caption_session_v1(p_session_id uuid, p_host_id text)
returns table(engine jsonb, assignment_revision text, languages text[], expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.engine,s.assignment_revision,s.languages,s.access_expires_at from public.managed_caption_sessions s
  where s.id=p_session_id and s.host_id=p_host_id and s.status='active'
    and s.access_expires_at > statement_timestamp()
    and exists(select 1 from public.profiles p where p.host_id=s.host_id and p.status='approved');
$$;
revoke all on function public.read_managed_caption_session_v1(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.read_managed_caption_session_v1(uuid,text) to service_role;

create or replace function public.renew_managed_caption_session_v1(p_session_id uuid, p_host_id text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare deadline timestamptz;
begin
  -- Fresh host authentication can restore a finite access window after sleep.
  -- Expired provider credentials stay invalid; the durable active state is authoritative.
  -- Renewal has a 24 hour grace window past the last access deadline: a laptop
  -- that slept overnight resumes, but a session nobody ended cannot be revived
  -- months later with a stale pinned assignment revision.
  update public.managed_caption_sessions s
  set access_renewed_at=statement_timestamp(),access_expires_at=statement_timestamp()+interval '6 hours'
  where s.id=p_session_id and s.host_id=p_host_id and s.status='active'
    and statement_timestamp() <= s.access_expires_at + interval '24 hours'
    and exists(select 1 from public.profiles p where p.host_id=s.host_id and p.status='approved')
  returning s.access_expires_at into deadline;
  if deadline is null then
    if exists(select 1 from public.managed_caption_sessions s
      where s.id=p_session_id and s.host_id=p_host_id and s.status='active'
        and statement_timestamp() > s.access_expires_at + interval '24 hours'
        and exists(select 1 from public.profiles p where p.host_id=s.host_id and p.status='approved')) then
      raise exception 'CAPTION_SESSION_EXPIRED' using errcode = '42501';
    end if;
    raise exception 'CAPTION_SESSION_FORBIDDEN' using errcode = '42501';
  end if;
  return deadline;
end;
$$;
revoke all on function public.renew_managed_caption_session_v1(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.renew_managed_caption_session_v1(uuid,text) to service_role;

create or replace function public.stop_managed_caption_session_v1(p_session_id uuid, p_host_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  -- Repeated stop remains successful; even an expired session can still be ended by its owner.
  update public.managed_caption_sessions s
    set status='stopped',stopped_at=coalesce(s.stopped_at,statement_timestamp())
    where s.id=p_session_id and s.host_id=p_host_id;
  return found;
end;
$$;
revoke all on function public.stop_managed_caption_session_v1(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.stop_managed_caption_session_v1(uuid,text) to service_role;
