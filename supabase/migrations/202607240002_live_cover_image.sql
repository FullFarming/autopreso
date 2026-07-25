-- Contract C10: session cover image for the stage countdown screen and the
-- viewer waiting room. Additive only.
--
-- 1) live_sessions.cover_image_path — storage object path, null until the
--    host uploads a cover. Reads map it to the boolean hasCoverImage.
alter table public.live_sessions
  add column if not exists cover_image_path text;

-- 2) Private storage bucket. Access is exclusively through the webapp cover
--    API route using the service credential — no anon/authenticated policies
--    on storage.objects are added on purpose (RLS stays fail-closed).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'live-covers',
  'live-covers',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;
