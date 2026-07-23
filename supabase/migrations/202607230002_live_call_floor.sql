-- 2026-07-23 feat: Live Call participant speaking-floor, utterance record,
-- and meeting summaries. Additive only — no existing column or overload is
-- removed. Floor state lives on live_sessions; the utterance record and
-- summaries are new service-role-only tables reached through guarded RPCs.

alter table public.live_sessions
  add column if not exists floor_grant_id uuid references public.viewer_grants(id) on delete set null,
  add column if not exists floor_display_name text
    check (floor_display_name is null or (
      char_length(floor_display_name) between 1 and 40
      and floor_display_name !~ '[[:cntrl:]]' and floor_display_name !~ '[<>]'
    )),
  add column if not exists floor_taken_at timestamptz;

create table if not exists public.live_utterances (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  seq bigint not null check (seq >= 1),
  language text not null check (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  speaker_label text check (speaker_label is null or char_length(speaker_label) between 1 and 80),
  speaker_name text check (speaker_name is null or (
    char_length(speaker_name) between 1 and 40
    and speaker_name !~ '[[:cntrl:]]' and speaker_name !~ '[<>]'
  )),
  text text not null check (char_length(btrim(text)) between 1 and 8000 and octet_length(text) <= 24000),
  source_ended_at timestamptz not null,
  emitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (session_id, language, seq)
);
create index if not exists live_utterances_session_language_seq_idx
  on public.live_utterances (session_id, language, seq);
alter table public.live_utterances enable row level security;

create table if not exists public.live_meeting_summaries (
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  language text not null check (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 65536),
  model text check (model is null or char_length(model) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, language)
);
alter table public.live_meeting_summaries enable row level security;

create or replace function public.take_live_floor(p_session_id uuid, p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_status text;
  previous_grant_id uuid;
  previous_display_name text;
  grant_display_name text;
begin
  select session_row.status, session_row.floor_grant_id, session_row.floor_display_name
  into session_status, previous_grant_id, previous_display_name
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found or session_status <> 'live' then
    return jsonb_build_object('ok', false, 'code', 'SESSION_NOT_LIVE');
  end if;

  select grant_row.display_name into grant_display_name
  from public.viewer_grants grant_row
  where grant_row.id = p_grant_id
    and grant_row.session_id = p_session_id
    and grant_row.revoked_at is null
    and grant_row.expires_at > statement_timestamp();

  if not found then
    return jsonb_build_object('ok', false, 'code', 'GRANT_INVALID');
  end if;

  update public.live_sessions
  set floor_grant_id = p_grant_id,
      floor_display_name = coalesce(grant_display_name, '참가자'),
      floor_taken_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'displayName', coalesce(grant_display_name, '참가자'),
    'previousGrantId', previous_grant_id,
    'previousDisplayName', previous_display_name
  );
end;
$$;

create or replace function public.release_live_floor(p_session_id uuid, p_grant_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_grant_id uuid;
begin
  select session_row.floor_grant_id into current_grant_id
  from public.live_sessions session_row
  where session_row.id = p_session_id
  for update;

  if not found or current_grant_id is null then
    return false;
  end if;
  -- p_grant_id null = gateway-forced release (disconnect, session stop).
  if p_grant_id is not null and current_grant_id <> p_grant_id then
    return false;
  end if;

  update public.live_sessions
  set floor_grant_id = null,
      floor_display_name = null,
      floor_taken_at = null,
      updated_at = statement_timestamp()
  where id = p_session_id;
  return true;
end;
$$;

create or replace function public.persist_live_utterance_if_active(
  p_session_id uuid,
  p_language text,
  p_seq bigint,
  p_text text,
  p_speaker_label text,
  p_speaker_name text,
  p_source_ended_at timestamptz,
  p_emitted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  session_status text;
  session_languages text[];
  existing_count bigint;
begin
  select session_row.status, session_row.languages
  into session_status, session_languages
  from public.live_sessions session_row
  where session_row.id = p_session_id
    and session_row.expires_at > statement_timestamp()
  for update;

  if not found
    or session_status <> 'live'
    or p_language is null
    or not (p_language = any(session_languages))
    or p_seq is null or p_seq < 1
    or p_text is null or char_length(btrim(p_text)) not between 1 and 8000
    or octet_length(p_text) > 24000
    or p_source_ended_at is null or p_emitted_at is null
  then
    return false;
  end if;

  select count(*) into existing_count
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language;
  if existing_count >= 5000 then
    return false;
  end if;

  insert into public.live_utterances (
    session_id, language, seq, speaker_label, speaker_name, text, source_ended_at, emitted_at
  ) values (
    p_session_id, p_language, p_seq,
    nullif(btrim(coalesce(p_speaker_label, '')), ''),
    nullif(btrim(coalesce(p_speaker_name, '')), ''),
    btrim(p_text), p_source_ended_at, p_emitted_at
  )
  on conflict (session_id, language, seq) do nothing;
  return true;
exception
  when check_violation or invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.take_live_floor(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_live_floor(uuid, uuid) from public, anon, authenticated;
revoke all on function public.persist_live_utterance_if_active(uuid, text, bigint, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.take_live_floor(uuid, uuid) to service_role;
grant execute on function public.release_live_floor(uuid, uuid) to service_role;
grant execute on function public.persist_live_utterance_if_active(uuid, text, bigint, text, text, text, timestamptz, timestamptz) to service_role;

-- Development verification (run manually after apply):
--   select public.take_live_floor(gen_random_uuid(), gen_random_uuid());
--     -> {"ok": false, "code": "SESSION_NOT_LIVE"}
--   select public.release_live_floor(gen_random_uuid(), null);  -> false
--   Both new tables exist with RLS enabled and no anon/authenticated grants.
