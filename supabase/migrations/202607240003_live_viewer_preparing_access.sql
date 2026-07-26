-- Viewers admitted via QR/code must be able to hold their seat BEFORE the
-- host presses Go-Live. Excluding 'preparing' made every pre-live viewer
-- request fail authorization, which the app surfaced as "입장권이 만료되었거나
-- 폐기되었습니다" the moment a guest joined a not-yet-started session.
-- Access still ends when the host stops the session ('stopped'/'failed' stay
-- unauthorized) or when the grant is revoked.

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
        and session_row.status in ('preparing', 'live', 'paused')
        and session_row.expires_at > statement_timestamp()
        and public.live_languages_canonical(session_row.languages)
        and p_language = any(session_row.languages)
        and grant_row.id = p_grant_id
        and grant_row.user_id = p_user_id
        and grant_row.revoked_at is null
        and grant_row.expires_at > statement_timestamp()
    );
$$;

-- Direct realtime.messages policies stay retired by 202607190002. Preparing
-- access is authorized through this service-role RPC and delivered by the
-- media gateway; resurrecting the old policy would bypass that boundary.
