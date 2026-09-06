-- 2026-07-27 feat: Keep participant name required while making department and
-- job title optional. Empty optional values are stored canonically as NULL;
-- existing v3 redemption signatures and service-role boundaries stay intact.

alter table public.live_participants
  alter column department drop not null,
  alter column job_title drop not null;

alter table public.live_participants
  drop constraint if exists live_participants_identity_check;

alter table public.live_participants
  add constraint live_participants_identity_check check (
    char_length(display_name) between 1 and 40
    and display_name = normalize(btrim(display_name), NFC)
    and display_name !~ '[[:cntrl:]]'
    and display_name !~ '[<>]'
    and (
      department is null or (
        char_length(department) between 1 and 80
        and department = normalize(btrim(department), NFC)
        and department !~ '[[:cntrl:]]'
        and department !~ '[<>]'
      )
    )
    and (
      job_title is null or (
        char_length(job_title) between 1 and 100
        and job_title = normalize(btrim(job_title), NFC)
        and job_title !~ '[[:cntrl:]]'
        and job_title !~ '[<>]'
      )
    )
  );

comment on column public.live_participants.department is
  'Optional NFC-normalized department; omitted or blank input is stored as NULL.';
comment on column public.live_participants.job_title is
  'Optional NFC-normalized job title; omitted or blank input is stored as NULL.';

create or replace function public.apply_live_viewer_grant(
  p_session_id uuid,
  p_user_id text,
  p_device_hash text,
  p_grant_expires_at timestamptz,
  p_display_name text,
  p_department text,
  p_job_title text
)
returns table (
  grant_id uuid,
  grant_user_id text,
  grant_expires_at timestamptz,
  resolved_viewer_count integer,
  resolved_display_name text,
  resolved_department text,
  resolved_job_title text,
  participant_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  grant_result record;
  normalized_department text;
  normalized_job_title text;
begin
  normalized_department := nullif(normalize(btrim(coalesce(p_department, '')), NFC), '');
  normalized_job_title := nullif(normalize(btrim(coalesce(p_job_title, '')), NFC), '');
  if (
      normalized_department is not null
      and (
        char_length(normalized_department) not between 1 and 80
        or normalized_department ~ '[[:cntrl:]]'
        or normalized_department ~ '[<>]'
      )
    ) or (
      normalized_job_title is not null
      and (
        char_length(normalized_job_title) not between 1 and 100
        or normalized_job_title ~ '[[:cntrl:]]'
        or normalized_job_title ~ '[<>]'
      )
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_IDENTITY';
  end if;

  select * into grant_result
  from public.apply_live_viewer_grant(
    p_session_id, p_user_id, p_device_hash, p_grant_expires_at, p_display_name
  );

  update public.viewer_grants
  set department = normalized_department,
      job_title = normalized_job_title
  where id = grant_result.grant_id;

  insert into public.live_participants as participant_row (
    id, grant_id, session_id, user_id, display_name, department, job_title,
    joined_at, last_seen_at, left_at, retention_expires_at
  ) values (
    grant_result.grant_id, grant_result.grant_id, p_session_id, p_user_id,
    grant_result.resolved_display_name, normalized_department,
    normalized_job_title, statement_timestamp(), statement_timestamp(), null, null
  )
  on conflict (session_id, user_id) do update
    set grant_id = excluded.grant_id,
        display_name = excluded.display_name,
        department = excluded.department,
        job_title = excluded.job_title,
        last_seen_at = statement_timestamp(),
        left_at = null,
        retention_expires_at = null
  returning participant_row.id into participant_id;

  insert into public.live_participant_events (
    participant_id, session_id, event_type, occurred_at
  ) values (
    participant_id, p_session_id, 'joined', statement_timestamp()
  );

  grant_id := grant_result.grant_id;
  grant_user_id := grant_result.grant_user_id;
  grant_expires_at := grant_result.grant_expires_at;
  resolved_viewer_count := grant_result.resolved_viewer_count;
  resolved_display_name := grant_result.resolved_display_name;
  resolved_department := normalized_department;
  resolved_job_title := normalized_job_title;
  return next;
end;
$$;

revoke all on function public.apply_live_viewer_grant(
  uuid, text, text, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_live_viewer_grant(
  uuid, text, text, timestamptz, text, text, text
) to service_role;
