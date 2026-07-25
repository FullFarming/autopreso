-- 2026-07-23 feat: Enforce one canonical multilingual contract end to end.
-- Existing rows are validated in place. The migration intentionally aborts
-- instead of rewriting an unsupported language code or deleting live state.

create or replace function public.normalize_live_language(p_language text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_language
    when 'en' then 'en'
    when 'en-US' then 'en'
    when 'en-GB' then 'en'
    when 'en-AU' then 'en'
    when 'en-CA' then 'en'
    when 'ko' then 'ko'
    when 'ko-KR' then 'ko'
    when 'ja' then 'ja'
    when 'ja-JP' then 'ja'
    when 'zh-Hans' then 'zh-Hans'
    when 'zh' then 'zh-Hans'
    when 'zh-CN' then 'zh-Hans'
    when 'zh-SG' then 'zh-Hans'
    when 'cmn-Hans-CN' then 'zh-Hans'
    when 'zh-Hant' then 'zh-Hant'
    when 'zh-TW' then 'zh-Hant'
    when 'zh-HK' then 'zh-Hant'
    when 'zh-MO' then 'zh-Hant'
    when 'cmn-Hant-TW' then 'zh-Hant'
    when 'es' then 'es'
    when 'es-ES' then 'es'
    when 'es-MX' then 'es'
    when 'pt' then 'pt'
    when 'pt-BR' then 'pt'
    when 'pt-PT' then 'pt'
    when 'fr' then 'fr'
    when 'fr-FR' then 'fr'
    when 'fr-CA' then 'fr'
    when 'de' then 'de'
    when 'de-DE' then 'de'
    when 'ru' then 'ru'
    when 'ru-RU' then 'ru'
    when 'hi' then 'hi'
    when 'hi-IN' then 'hi'
    when 'id' then 'id'
    when 'id-ID' then 'id'
    when 'vi' then 'vi'
    when 'vi-VN' then 'vi'
    when 'it' then 'it'
    when 'it-IT' then 'it'
    else null
  end;
$$;

create or replace function public.normalize_live_languages(p_languages text[])
returns text[]
language sql
immutable
strict
set search_path = ''
as $$
  select array(
    select public.normalize_live_language(language_code)
    from unnest(p_languages) with ordinality as requested(language_code, position)
    order by position
  );
$$;

create or replace function public.live_language_valid(p_language text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(p_language = public.normalize_live_language(p_language), false);
$$;

create or replace function public.live_languages_valid(p_languages text[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    cardinality(p_languages) between 1 and 3
    and cardinality(p_languages) = (
      select count(distinct public.normalize_live_language(language_code))
      from unnest(p_languages) as requested(language_code)
    )
    and not exists (
      select 1
      from unnest(p_languages) as requested(language_code)
      where public.normalize_live_language(language_code) is null
    );
$$;

create or replace function public.live_languages_canonical(p_languages text[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    public.live_languages_valid(p_languages)
    and p_languages = public.normalize_live_languages(p_languages);
$$;

create or replace function public.normalize_live_session_languages()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.live_languages_valid(new.languages) then
    raise exception using errcode = '23514', message = 'INVALID_LIVE_LANGUAGES';
  end if;
  new.languages := public.normalize_live_languages(new.languages);
  return new;
end;
$$;

comment on function public.normalize_live_language(text) is
  'Maps supported locale aliases to one Realtime Noel storage code; null means unsupported.';
comment on function public.normalize_live_languages(text[]) is
  'Preserves requested order and cardinality while mapping every supported locale alias.';
comment on function public.live_language_valid(text) is
  'Exact Realtime Noel storage-code allowlist; aliases must be normalized before persistence.';
comment on function public.live_languages_valid(text[]) is
  'Shared 1..3 unique normalized-language input validator used by create_live_session and update_live_session.';
comment on function public.live_languages_canonical(text[]) is
  'Exact 1..3 unique-language storage invariant used by sessions, joins, snapshots, and viewer topics.';

create trigger live_sessions_normalize_languages_before_write
before insert or update of languages
on public.live_sessions
for each row execute function public.normalize_live_session_languages();

-- Preserve compatible clients and rows by canonicalizing known locale aliases.
-- Unknown codes and aliases that collapse into duplicates abort before any row
-- is changed, so the migration remains atomic and never guesses a data merge.
do $migration$
begin
  if exists (
    select 1
    from public.live_sessions session_row
    where not public.live_languages_valid(session_row.languages)
  ) then
    raise exception using errcode = '23514', message = 'UNSUPPORTED_EXISTING_LIVE_LANGUAGE';
  end if;

  if exists (
    select 1
    from public.live_snapshots snapshot_row
    where public.normalize_live_language(snapshot_row.language) is null
  ) then
    raise exception using errcode = '23514', message = 'UNSUPPORTED_EXISTING_SNAPSHOT_LANGUAGE';
  end if;

  if exists (
    select 1
    from public.live_snapshots snapshot_row
    group by snapshot_row.session_id,
      public.normalize_live_language(snapshot_row.language)
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'LIVE_LANGUAGE_ALIAS_COLLISION';
  end if;
end;
$migration$;

update public.live_sessions
set languages = public.normalize_live_languages(languages)
where languages is distinct from public.normalize_live_languages(languages);

update public.live_snapshots
set language = public.normalize_live_language(language)
where language is distinct from public.normalize_live_language(language);

-- A new NOT VALID constraint followed by VALIDATE rechecks existing rows under
-- the stricter function body. PostgreSQL does not automatically rescan an old
-- function-backed CHECK constraint after CREATE OR REPLACE FUNCTION.
alter table public.live_sessions
  add constraint live_sessions_canonical_languages_check
  check (public.live_languages_canonical(languages)) not valid;

alter table public.live_sessions
  validate constraint live_sessions_canonical_languages_check;

alter table public.live_snapshots
  add constraint live_snapshots_canonical_language_check
  check (public.live_language_valid(language)) not valid;

alter table public.live_snapshots
  validate constraint live_snapshots_canonical_language_check;

-- Both admission and invite redemption call these lock helpers before creating
-- a viewer grant. The shared language predicate therefore makes every join
-- overload fail closed if a future schema drift leaves a non-canonical session.
create or replace function public.lock_live_admission_session(
  p_code_hmac text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_session_id uuid;
begin
  if p_code_hmac is null or p_code_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;

  select session_row.id into resolved_session_id
  from public.live_sessions session_row
  where session_row.admission_code_hmac = p_code_hmac
    and session_row.admission_open_until > statement_timestamp()
    and session_row.status in ('preparing', 'live')
    and session_row.expires_at > statement_timestamp()
    and public.live_languages_canonical(session_row.languages)
  for update;

  if resolved_session_id is null then
    raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
  end if;
  return resolved_session_id;
end;
$$;

create or replace function public.lock_live_invite_session(
  p_token_hmac text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_session_id uuid;
  session_row public.live_sessions%rowtype;
  invite_row public.live_session_invites%rowtype;
begin
  if p_token_hmac is null or p_token_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  select invite_lookup.session_id into candidate_session_id
  from public.live_session_invites invite_lookup
  where invite_lookup.token_hmac = p_token_hmac;

  if candidate_session_id is null then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  select * into session_row
  from public.live_sessions
  where id = candidate_session_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  select * into invite_row
  from public.live_session_invites
  where live_session_invites.session_id = session_row.id
  for update;

  if not found
    or invite_row.token_hmac <> p_token_hmac
    or invite_row.revoked_at is not null
    or invite_row.expires_at <= statement_timestamp()
    or session_row.admission_open_until is null
    or session_row.admission_open_until <= statement_timestamp()
    or session_row.status not in ('preparing', 'live')
    or session_row.expires_at <= statement_timestamp()
    or not public.live_languages_canonical(session_row.languages)
  then
    raise exception using errcode = 'P0001', message = 'INVITE_CLOSED';
  end if;

  return session_row.id;
end;
$$;

-- The gateway previously authorized a topic with separate grant and session
-- reads. This single statement evaluates the grant, session, selected language,
-- and expiry against one PostgreSQL snapshot, preventing split-read decisions.
-- Viewer reconnects remain closed while a session is preparing; this preserves
-- the existing gateway contract and prevents pre-live caption disclosure.
create or replace function public.authorize_live_viewer_topic(
  p_session_id uuid,
  p_grant_id uuid,
  p_user_id text,
  p_language text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_session_id is not null
    and p_grant_id is not null
    and p_user_id is not null
    and length(p_user_id) between 1 and 256
    and p_language is not null
    and public.live_language_valid(p_language)
    and exists (
      select 1
      from public.live_sessions session_row
      join public.viewer_grants grant_row
        on grant_row.session_id = session_row.id
      where session_row.id = p_session_id
        and session_row.status = 'live'
        and session_row.expires_at > statement_timestamp()
        and public.live_languages_canonical(session_row.languages)
        and p_language = any(session_row.languages)
        and grant_row.id = p_grant_id
        and grant_row.user_id = p_user_id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );
$$;

revoke all on function public.normalize_live_language(text)
  from public, anon, authenticated;
revoke all on function public.normalize_live_languages(text[])
  from public, anon, authenticated;
revoke all on function public.live_language_valid(text)
  from public, anon, authenticated;
revoke all on function public.live_languages_valid(text[])
  from public, anon, authenticated;
revoke all on function public.live_languages_canonical(text[])
  from public, anon, authenticated;
revoke all on function public.normalize_live_session_languages()
  from public, anon, authenticated, service_role;
revoke all on function public.lock_live_admission_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.lock_live_invite_session(text)
  from public, anon, authenticated, service_role;
revoke all on function public.authorize_live_viewer_topic(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.normalize_live_language(text)
  to service_role;
grant execute on function public.normalize_live_languages(text[])
  to service_role;
grant execute on function public.live_language_valid(text)
  to service_role;
grant execute on function public.live_languages_valid(text[])
  to service_role;
grant execute on function public.live_languages_canonical(text[])
  to service_role;
grant execute on function public.authorize_live_viewer_topic(uuid, uuid, text, text)
  to service_role;

-- Verification (run after applying to a development project only):
-- select public.live_languages_valid(array['en', 'ja', 'zh-Hans']); -- true
-- select public.normalize_live_languages(array['en-US', 'ko-KR', 'zh-CN']);
-- Expected: {en,ko,zh-Hans}
-- select not public.live_languages_valid(array['en', 'en']);       -- true
-- select not public.live_languages_valid(array['EN']);             -- true
-- select not public.live_languages_canonical(array['zh']);         -- true
-- select not public.live_languages_valid(array[]::text[]);         -- true
-- select not public.live_languages_valid(array['en', 'ko', 'ja', 'fr']); -- true
-- select count(*) = 0 as existing_sessions_are_canonical
-- from public.live_sessions
-- where not public.live_languages_canonical(languages);
-- select count(*) = 0 as existing_snapshots_are_canonical
-- from public.live_snapshots
-- where not public.live_language_valid(language);
