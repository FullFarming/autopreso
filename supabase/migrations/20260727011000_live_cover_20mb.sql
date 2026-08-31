-- Raise only the existing private Live Call cover bucket limit. The image
-- allowlist and private access boundary remain explicit during migration.
update storage.buckets
set file_size_limit = 20971520,
    public = false,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'live-covers';
