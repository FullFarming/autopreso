-- 2026-07-26 fix: Preserve the four bounded speaker-overlay fields emitted by
-- Live Call while keeping the established snapshot sanitizer fail-closed for
-- every unknown top-level key.
--
-- The production pipeline began attaching these fields to finalized captions,
-- but the exact allowlist correctly rejected them because the database contract
-- had not moved with the event contract. Since the atomic final RPC persists
-- the snapshot before the utterance, that rejection rolled back both records.

alter function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  rename to persist_live_snapshot_if_active_20260726061310;

revoke all on function public.persist_live_snapshot_if_active_20260726061310(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.persist_live_snapshot_if_active(
  p_session_id uuid,
  p_language text,
  p_event jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored boolean;
  event_seq bigint;
  metadata_present boolean;
  overlay_metadata jsonb;
  stored_event jsonb;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return false;
  end if;

  metadata_present := p_event ? 'speakerRole'
    or p_event ? 'speakerName'
    or p_event ? 'speakerDepartment'
    or p_event ? 'speakerJobTitle';

  -- Metadata is one coherent tuple. Partial tuples, nulls, markup, control
  -- characters, and values outside the UI identity bounds fail closed.
  if metadata_present and (
    not (p_event ?& array[
      'speakerRole', 'speakerName', 'speakerDepartment', 'speakerJobTitle'
    ])
    or jsonb_typeof(p_event -> 'speakerRole') <> 'string'
    or p_event ->> 'speakerRole' not in ('host', 'participant')
    or jsonb_typeof(p_event -> 'speakerName') <> 'string'
    or char_length(btrim(p_event ->> 'speakerName')) not between 1 and 40
    or octet_length(p_event ->> 'speakerName') > 120
    or (p_event ->> 'speakerName') ~ '[[:cntrl:]]'
    or (p_event ->> 'speakerName') ~ '[<>]'
    or jsonb_typeof(p_event -> 'speakerDepartment') <> 'string'
    or char_length(p_event ->> 'speakerDepartment') > 80
    or octet_length(p_event ->> 'speakerDepartment') > 240
    or (p_event ->> 'speakerDepartment') ~ '[[:cntrl:]]'
    or (p_event ->> 'speakerDepartment') ~ '[<>]'
    or jsonb_typeof(p_event -> 'speakerJobTitle') <> 'string'
    or char_length(p_event ->> 'speakerJobTitle') > 100
    or octet_length(p_event ->> 'speakerJobTitle') > 300
    or (p_event ->> 'speakerJobTitle') ~ '[[:cntrl:]]'
    or (p_event ->> 'speakerJobTitle') ~ '[<>]'
    or (
      p_event ->> 'speakerRole' = 'host'
      and (
        p_event ->> 'speakerName' <> 'Host'
        or p_event ->> 'speakerDepartment' <> ''
        or p_event ->> 'speakerJobTitle' <> ''
      )
    )
  ) then
    return false;
  end if;

  stored := public.persist_live_snapshot_if_active_20260726061310(
    p_session_id,
    p_language,
    p_event - array[
      'speakerRole', 'speakerName', 'speakerDepartment', 'speakerJobTitle'
    ]::text[]
  );
  if not stored or not metadata_present then
    return stored;
  end if;

  event_seq := (p_event ->> 'seq')::bigint;
  select snapshot_row.captions -> 0
  into stored_event
  from public.live_snapshots snapshot_row
  where snapshot_row.session_id = p_session_id
    and snapshot_row.language = p_language
    and snapshot_row.last_seq = event_seq;

  -- Same-seq and older retries keep first-write identity immutable. The prior
  -- sanitizer already decided whether this event was current enough to store.
  if stored_event is null
    or stored_event ? 'speakerRole'
    or stored_event ? 'speakerName'
    or stored_event ? 'speakerDepartment'
    or stored_event ? 'speakerJobTitle'
  then
    return true;
  end if;

  overlay_metadata := jsonb_build_object(
    'speakerRole', p_event ->> 'speakerRole',
    'speakerName', btrim(p_event ->> 'speakerName'),
    'speakerDepartment', btrim(p_event ->> 'speakerDepartment'),
    'speakerJobTitle', btrim(p_event ->> 'speakerJobTitle')
  );
  stored_event := stored_event || overlay_metadata;

  update public.live_snapshots
  set captions = jsonb_build_array(stored_event)
  where session_id = p_session_id
    and language = p_language
    and last_seq = event_seq;
  return true;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;

revoke all on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_live_snapshot_if_active(uuid, text, jsonb)
  to service_role;

-- Rollback is application-first. Older gateway binaries do not send these
-- optional fields, so keep this additive wrapper during a rolling rollback.
