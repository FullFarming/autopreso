-- 2026-08-15 feat: Add attendee email admission without treating email as
-- identity proof. Existing v3 admission RPCs stay in place; the v1 attendee RPC
-- is the new atomic boundary for email/company/summary consent.

alter table public.live_participants
  add column if not exists email text,
  add column if not exists company text,
  add column if not exists summary_consent_at timestamptz;

create or replace function public.is_valid_live_attendee_email_atom(
  p_value text,
  p_allow_local_symbols boolean
)
returns boolean
language plpgsql
security definer
immutable
set search_path = ''
as $$
declare
  char_text text;
  codepoint integer;
begin
  if p_value is null or p_value = '' then
    return false;
  end if;

  foreach char_text in array regexp_split_to_array(p_value, '') loop
    codepoint := ascii(char_text);

    if codepoint between 48 and 57
      or codepoint between 65 and 90
      or codepoint between 97 and 122
      or codepoint between 192 and 687
      or codepoint between 768 and 879
      or codepoint between 4352 and 4607
      or codepoint between 12592 and 12687
      or codepoint between 44032 and 55203
    then
      continue;
    end if;

    if p_allow_local_symbols
      and position(char_text in '!#$%&''*+/=?^_`{|}~.-') > 0
    then
      continue;
    end if;

    if not p_allow_local_symbols and char_text = '-' then
      continue;
    end if;

    return false;
  end loop;

  return true;
end;
$$;

create or replace function public.is_valid_live_attendee_email(
  p_email text
)
returns boolean
language plpgsql
security definer
immutable
set search_path = ''
as $$
declare
  normalized_email text;
  local_part text;
  domain_part text;
  domain_labels text[];
  label_text text;
begin
  if p_email is null then
    return false;
  end if;

  normalized_email := lower(normalize(btrim(p_email), NFC));
  if p_email <> normalized_email
    or char_length(normalized_email) > 254
    or normalized_email ~ '[[:space:][:cntrl:]<>]'
    or length(normalized_email) - length(replace(normalized_email, '@', '')) <> 1
  then
    return false;
  end if;

  local_part := split_part(normalized_email, '@', 1);
  domain_part := split_part(normalized_email, '@', 2);
  if char_length(local_part) not between 1 and 64
    or char_length(domain_part) > 253
    or char_length(domain_part) < 3
    or local_part like '.%'
    or local_part like '%.'
    or local_part like '%..%'
    or not public.is_valid_live_attendee_email_atom(local_part, true)
  then
    return false;
  end if;

  domain_labels := string_to_array(domain_part, '.');
  if array_length(domain_labels, 1) < 2 then
    return false;
  end if;

  foreach label_text in array domain_labels loop
    if char_length(label_text) not between 1 and 63
      or label_text like '-%'
      or label_text like '%-'
      or not public.is_valid_live_attendee_email_atom(label_text, false)
    then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

alter table public.live_participants
  drop constraint if exists live_participants_attendee_profile_check;

alter table public.live_participants
  add constraint live_participants_attendee_profile_check check (
    (
      email is null or public.is_valid_live_attendee_email(email)
    )
    and (
      company is null or (
        char_length(company) between 1 and 100
        and company = normalize(btrim(company), NFC)
        and company !~ '[[:cntrl:]]'
        and company !~ '[<>]'
      )
    )
  );

comment on column public.live_participants.email is
  'Nullable for legacy rows; new attendee admission stores canonical lowercase delivery email only.';
comment on column public.live_participants.company is
  'Optional NFC-normalized company supplied at attendee admission.';
comment on column public.live_participants.summary_consent_at is
  'Monotonic opt-in timestamp for later summary delivery; false joins keep it null.';

create or replace function public.mask_live_attendee_email(
  p_email text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_part text;
  domain_part text;
  masked_email text;
begin
  if p_email is null or position('@' in p_email) <= 1 then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_EMAIL';
  end if;
  local_part := split_part(p_email, '@', 1);
  domain_part := split_part(p_email, '@', 2);
  if local_part = '' or domain_part = '' then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_EMAIL';
  end if;
  masked_email := left(local_part, 1) || '***@' || domain_part;
  if char_length(masked_email) <= 40 then
    return masked_email;
  end if;
  return left(local_part, 1) || '***@' || left(domain_part, 34) || '…';
end;
$$;

create or replace function public.apply_live_attendee_grant(
  p_session_id uuid,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_company text,
  p_department text,
  p_job_title text,
  p_summary_consent boolean
)
returns table (
  grant_id uuid,
  grant_user_id text,
  grant_expires_at timestamptz,
  resolved_viewer_count integer,
  resolved_display_name text,
  resolved_email text,
  resolved_company text,
  resolved_department text,
  resolved_job_title text,
  resolved_summary_consent_at timestamptz,
  participant_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  grant_result record;
  normalized_email text;
  normalized_company text;
  normalized_department text;
  normalized_job_title text;
begin
  normalized_email := lower(normalize(btrim(coalesce(p_email, '')), NFC));
  normalized_company := nullif(normalize(btrim(coalesce(p_company, '')), NFC), '');
  normalized_department := nullif(normalize(btrim(coalesce(p_department, '')), NFC), '');
  normalized_job_title := nullif(normalize(btrim(coalesce(p_job_title, '')), NFC), '');

  if p_summary_consent is null
    or not public.is_valid_live_attendee_email(normalized_email)
    or (
      normalized_company is not null
      and (
        char_length(normalized_company) not between 1 and 100
        or normalized_company ~ '[[:cntrl:]]'
        or normalized_company ~ '[<>]'
      )
    )
    or (
      normalized_department is not null
      and (
        char_length(normalized_department) not between 1 and 80
        or normalized_department ~ '[[:cntrl:]]'
        or normalized_department ~ '[<>]'
      )
    )
    or (
      normalized_job_title is not null
      and (
        char_length(normalized_job_title) not between 1 and 100
        or normalized_job_title ~ '[[:cntrl:]]'
        or normalized_job_title ~ '[<>]'
      )
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_PROFILE';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    p_session_id,
    p_user_id,
    p_device_hash,
    p_grant_expires_at,
    public.mask_live_attendee_email(normalized_email),
    normalized_department,
    normalized_job_title
  );

  update public.live_participants as participant_row
  set display_name = public.mask_live_attendee_email(normalized_email),
      email = normalized_email,
      company = normalized_company,
      department = normalized_department,
      job_title = normalized_job_title,
      summary_consent_at = case
        when participant_row.email is distinct from normalized_email
          and p_summary_consent is true
          then statement_timestamp()
        when participant_row.email is distinct from normalized_email
          then null
        when p_summary_consent is true
          then coalesce(participant_row.summary_consent_at, statement_timestamp())
        else participant_row.summary_consent_at
      end
  where participant_row.id = grant_result.participant_id
  returning participant_row.summary_consent_at into resolved_summary_consent_at;

  grant_id := grant_result.grant_id;
  grant_user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  resolved_viewer_count := grant_result.resolved_viewer_count;
  resolved_display_name := public.mask_live_attendee_email(normalized_email);
  resolved_email := normalized_email;
  resolved_company := normalized_company;
  resolved_department := normalized_department;
  resolved_job_title := normalized_job_title;
  participant_id := grant_result.participant_id;
  return next;
end;
$$;

create or replace function public.redeem_live_attendee_v1(
  p_invite_token_hmac text,
  p_code_hmac text,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_email text,
  p_company text,
  p_department text,
  p_job_title text,
  p_summary_consent boolean
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  resolved_session_id uuid;
  session_row public.live_sessions%rowtype;
  grant_result record;
begin
  if (p_invite_token_hmac is null) = (p_code_hmac is null)
    or (p_invite_token_hmac is not null and p_invite_token_hmac !~ '^[0-9a-f]{64}$')
    or (p_code_hmac is not null and p_code_hmac !~ '^[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_CREDENTIAL';
  end if;

  if p_invite_token_hmac is not null then
    resolved_session_id := public.lock_live_invite_session(p_invite_token_hmac);
    select * into session_row
    from public.live_sessions
    where id = resolved_session_id
    for update;
  else
    select * into session_row
    from public.live_sessions
    where admission_code_hmac = p_code_hmac
    for update;
    if not found
      or session_row.admission_state <> 'open'
      or session_row.admission_open_until <= statement_timestamp()
      or session_row.status not in ('preparing', 'live')
      or session_row.expires_at <= statement_timestamp()
    then
      raise exception using errcode = 'P0001', message = 'ADMISSION_CLOSED';
    end if;
  end if;

  select * into grant_result
  from public.apply_live_attendee_grant(
    session_row.id,
    p_user_id,
    p_device_hash,
    p_grant_expires_at,
    p_email,
    p_company,
    p_department,
    p_job_title,
    p_summary_consent
  );

  grant_id := grant_result.grant_id;
  session_id := session_row.id;
  user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  session_type := session_row.session_type;
  output_mode := session_row.output_mode;
  languages := session_row.languages;
  session_expires_at := session_row.expires_at;
  viewer_count := grant_result.resolved_viewer_count;
  max_viewers := session_row.max_viewers;
  glossary_pack := session_row.glossary_pack;
  display_name := grant_result.resolved_display_name;
  email := grant_result.resolved_email;
  company := grant_result.resolved_company;
  department := grant_result.resolved_department;
  job_title := grant_result.resolved_job_title;
  summary_consent_at := grant_result.resolved_summary_consent_at;
  participant_id := grant_result.participant_id;
  voice_provider := session_row.voice_provider;
  status := session_row.status;
  title := session_row.title;
  scheduled_at := session_row.scheduled_at;
  return next;
end;
$$;

create or replace function public.restore_live_attendee_v1(
  p_grant_id uuid,
  p_session_id uuid,
  p_user_id text
)
returns table (
  grant_id uuid,
  session_id uuid,
  user_id text,
  grant_expires_at timestamptz,
  session_type text,
  output_mode text,
  languages text[],
  session_expires_at timestamptz,
  viewer_count integer,
  max_viewers integer,
  glossary_pack text,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  participant_id uuid,
  voice_provider text,
  status text,
  title text,
  scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  restore_row record;
begin
  if p_grant_id is null
    or p_session_id is null
    or p_user_id is null
    or char_length(p_user_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_ATTENDEE_RESTORE';
  end if;

  select
    grant_row.id as grant_id,
    grant_row.user_id as grant_user_id,
    grant_row.expires_at as grant_expires_at,
    session_row.id as session_id,
    session_row.session_type,
    session_row.output_mode,
    session_row.languages,
    session_row.expires_at as session_expires_at,
    session_row.viewer_count,
    session_row.max_viewers,
    session_row.glossary_pack,
    session_row.voice_provider,
    session_row.status,
    session_row.title,
    session_row.scheduled_at,
    participant_row.id as participant_id,
    participant_row.email,
    participant_row.company,
    participant_row.department,
    participant_row.job_title,
    participant_row.summary_consent_at
  into restore_row
  from public.viewer_grants grant_row
  join public.live_sessions session_row
    on session_row.id = grant_row.session_id
  join public.live_participants participant_row
    on participant_row.grant_id = grant_row.id
   and participant_row.session_id = p_session_id
   and participant_row.user_id = p_user_id
   and participant_row.email is not null
   and (
     participant_row.retention_expires_at is null
     or participant_row.retention_expires_at > statement_timestamp()
   )
  where grant_row.id = p_grant_id
    and grant_row.session_id = p_session_id
    and grant_row.user_id = p_user_id
    and grant_row.revoked_at is null
    and grant_row.expires_at > statement_timestamp()
    and session_row.status in ('preparing', 'live', 'paused')
    and session_row.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = 'P0001', message = 'VIEWER_RESTORE_FORBIDDEN';
  end if;

  grant_id := restore_row.grant_id;
  session_id := restore_row.session_id;
  user_id := restore_row.grant_user_id;
  grant_expires_at := restore_row.grant_expires_at;
  session_type := restore_row.session_type;
  output_mode := restore_row.output_mode;
  languages := restore_row.languages;
  session_expires_at := restore_row.session_expires_at;
  viewer_count := restore_row.viewer_count;
  max_viewers := restore_row.max_viewers;
  glossary_pack := restore_row.glossary_pack;
  display_name := public.mask_live_attendee_email(restore_row.email);
  email := restore_row.email;
  company := restore_row.company;
  department := restore_row.department;
  job_title := restore_row.job_title;
  summary_consent_at := restore_row.summary_consent_at;
  participant_id := restore_row.participant_id;
  voice_provider := restore_row.voice_provider;
  status := restore_row.status;
  title := restore_row.title;
  scheduled_at := restore_row.scheduled_at;
  return next;
end;
$$;
drop function if exists public.read_live_participant_roster(uuid, text);

create or replace function public.read_live_participant_roster(
  p_session_id uuid,
  p_host_id text
)
returns table (
  participant_id uuid,
  grant_id uuid,
  user_id text,
  display_name text,
  email text,
  company text,
  department text,
  job_title text,
  summary_consent_at timestamptz,
  joined_at timestamptz,
  last_seen_at timestamptz,
  left_at timestamptz,
  last_spoke_at timestamptz,
  utterance_count integer,
  speaking_seconds numeric,
  retention_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_id is null
    or p_host_id is null
    or char_length(p_host_id) not between 1 and 256
  then
    raise exception using errcode = '22023', message = 'INVALID_ROSTER_INPUT';
  end if;
  if not exists (
    select 1
    from public.live_sessions session_row
    where session_row.id = p_session_id
      and session_row.host_id = p_host_id
  ) then
    raise exception using errcode = '42501', message = 'HOST_ACCESS_REQUIRED';
  end if;

  return query
  select participant_row.id,
    participant_row.grant_id,
    participant_row.user_id,
    participant_row.display_name,
    participant_row.email,
    participant_row.company,
    participant_row.department,
    participant_row.job_title,
    participant_row.summary_consent_at,
    participant_row.joined_at,
    participant_row.last_seen_at,
    participant_row.left_at,
    participant_row.last_spoke_at,
    participant_row.utterance_count,
    participant_row.speaking_seconds,
    participant_row.retention_expires_at
  from public.live_participants participant_row
  where participant_row.session_id = p_session_id
    and (
      participant_row.retention_expires_at is null
      or participant_row.retention_expires_at > statement_timestamp()
    )
  order by participant_row.joined_at, participant_row.id;
end;
$$;

revoke all on function public.is_valid_live_attendee_email_atom(text, boolean)
  from public, anon, authenticated;
revoke all on function public.is_valid_live_attendee_email(text)
  from public, anon, authenticated;
revoke all on function public.mask_live_attendee_email(text)
  from public, anon, authenticated;
revoke all on function public.apply_live_attendee_grant(
  uuid, text, text, timestamptz, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.redeem_live_attendee_v1(
  text, text, text, text, timestamptz, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.restore_live_attendee_v1(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.read_live_participant_roster(uuid, text)
  from public, anon, authenticated;

grant execute on function public.is_valid_live_attendee_email_atom(text, boolean)
  to service_role;
grant execute on function public.is_valid_live_attendee_email(text)
  to service_role;
grant execute on function public.mask_live_attendee_email(text)
  to service_role;
grant execute on function public.apply_live_attendee_grant(
  uuid, text, text, timestamptz, text, text, text, text, boolean
) to service_role;
grant execute on function public.redeem_live_attendee_v1(
  text, text, text, text, timestamptz, text, text, text, text, boolean
) to service_role;
grant execute on function public.restore_live_attendee_v1(uuid, uuid, text)
  to service_role;
grant execute on function public.read_live_participant_roster(uuid, text)
  to service_role;
