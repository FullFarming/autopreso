-- 2026-07-26 security: Converge every database on gateway-only Live delivery.
--
-- 202607190002 retired these temporary realtime.messages policies after media
-- delivery moved to the authenticated media gateway. An obsolete block in the
-- pause migration attempted to ALTER them again: fresh migration replay failed
-- because they no longer existed, while a database that skipped the retirement
-- could retain direct Broadcast access. The historical pause artifact now
-- leaves them absent; this convergence migration handles already-applied
-- databases without assuming whether a policy currently exists.

drop policy if exists live_broadcast_viewer_receive on realtime.messages;
drop policy if exists live_broadcast_host_receive on realtime.messages;
drop policy if exists live_broadcast_host_send on realtime.messages;

-- Development verification after applying to a linked development project:
-- select count(*) = 0 as gateway_is_only_live_transport
-- from pg_policies
-- where schemaname = 'realtime'
--   and tablename = 'messages'
--   and policyname in (
--     'live_broadcast_viewer_receive',
--     'live_broadcast_host_receive',
--     'live_broadcast_host_send'
--   );
