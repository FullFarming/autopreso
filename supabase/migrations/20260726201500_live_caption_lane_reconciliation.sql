-- 2026-07-26 fix: Reconcile an ambiguous final-caption timeout against the
-- serialized durable lane before the gateway decides which sequence is next.
--
-- The atomic writer and this reader both lock the same live_sessions row. A
-- reconciliation that starts after a timed-out request therefore observes
-- either its committed utterance or its completed rollback, never an
-- in-flight guess. The RPC is additive and service-role-only; it does not
-- modify snapshots, utterances, or session state.

create or replace function public.reconcile_live_caption_lane(
  p_session_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_status text;
  session_languages text[];
  last_utterance_seq bigint;
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
  then
    return null;
  end if;

  select coalesce(max(utterance_row.seq), 0)
  into last_utterance_seq
  from public.live_utterances utterance_row
  where utterance_row.session_id = p_session_id
    and utterance_row.language = p_language;

  return jsonb_build_object(
    'max_seq', last_utterance_seq
  );
end;
$$;

revoke all on function public.reconcile_live_caption_lane(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_live_caption_lane(uuid, text)
  to service_role;

-- Rollback is application-first: older gateway binaries ignore this additive
-- RPC. Keep the function in place so a rolling rollback remains compatible.
