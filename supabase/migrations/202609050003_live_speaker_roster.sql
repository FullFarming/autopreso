-- 2026-09-05 feat: Preserve each speaker identity version independently of the current roster.
create table public.live_speaker_rosters (
 session_id uuid primary key references public.live_sessions(id) on delete cascade,
 revision integer not null default 0 check(revision >= 0),
 applied_revision integer not null default 0 check(applied_revision between 0 and revision),
 active_onsite_speaker_id uuid,
 speakers jsonb not null default '[]'::jsonb check(jsonb_typeof(speakers)='array' and jsonb_array_length(speakers)<=30)
);
create table public.live_speaker_photos (
 id uuid primary key,
 session_id uuid not null references public.live_sessions(id) on delete cascade,
 content_type text not null check(content_type in ('image/jpeg','image/png','image/webp')),
 image_base64 text not null,
 size_bytes integer not null check(size_bytes between 1 and 262144),
 check(octet_length(decode(image_base64,'base64'))=size_bytes)
);
create table public.live_speaker_profile_versions (
 session_id uuid not null references public.live_sessions(id) on delete cascade, speaker_id uuid not null,
 version integer not null check(version>0), profile jsonb not null,
 primary key(session_id,speaker_id,version)
);
alter table public.live_speaker_rosters enable row level security;
alter table public.live_speaker_photos enable row level security;
alter table public.live_speaker_profile_versions enable row level security;
revoke all on public.live_speaker_rosters, public.live_speaker_photos, public.live_speaker_profile_versions from public, anon, authenticated, service_role;

create function public.get_live_speaker_roster_gateway_v1(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.live_speaker_rosters%rowtype;
begin
 if not exists(select 1 from public.live_sessions where id=p_session_id) then raise exception 'SPEAKER_ROSTER_FORBIDDEN'; end if;
 select * into r from public.live_speaker_rosters where session_id=p_session_id;
 return jsonb_build_object('sessionId',p_session_id,'revision',coalesce(r.revision,0),'appliedRevision',coalesce(r.applied_revision,0),'activeOnsiteSpeakerId',r.active_onsite_speaker_id,'speakers',coalesce(r.speakers,'[]'::jsonb));
end $$;
create function public.get_live_speaker_roster_v1(p_session_id uuid,p_host_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.live_sessions where id=p_session_id and host_id=p_host_id) then raise exception 'SPEAKER_ROSTER_FORBIDDEN'; end if;
 return public.get_live_speaker_roster_gateway_v1(p_session_id);
end $$;

create function public.replace_live_speaker_roster_v1(p_session_id uuid,p_host_id text,p_expected_revision integer,p_speakers jsonb,p_active_onsite_speaker_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_status text; r public.live_speaker_rosters%rowtype; s jsonb; previous jsonb; normalized jsonb; result jsonb:='[]'; selected_speaker_id uuid; participant_id uuid; photo_id uuid; next_version integer;
begin
 select status::text into current_status from public.live_sessions where id=p_session_id and host_id=p_host_id for update;
 if not found then raise exception 'SPEAKER_ROSTER_FORBIDDEN'; end if;
 if current_status in ('stopped','failed') then raise exception 'SPEAKER_ROSTER_TERMINAL'; end if;
 if p_expected_revision is null or p_expected_revision<0 or p_speakers is null or jsonb_typeof(p_speakers)<>'array' then raise exception 'SPEAKER_ROSTER_INVALID'; end if;
 if jsonb_array_length(p_speakers)>30 then raise exception 'SPEAKER_ROSTER_INVALID'; end if;
 insert into public.live_speaker_rosters(session_id) values(p_session_id) on conflict do nothing;
 select * into r from public.live_speaker_rosters where session_id=p_session_id for update;
 if r.revision<>p_expected_revision then raise exception 'SPEAKER_ROSTER_CONFLICT' using errcode='40001'; end if;
 for s in select value from jsonb_array_elements(p_speakers) loop
  if jsonb_typeof(s)<>'object' or jsonb_typeof(s->'displayName') is distinct from 'string' or length(btrim(s->>'displayName')) not between 1 and 40
   or jsonb_typeof(s->'company') is distinct from 'string' or length(s->>'company')>80
   or jsonb_typeof(s->'department') is distinct from 'string' or length(s->>'department')>80
   or (s->>'displayName') ~ '[[:cntrl:]<>]' or (s->>'company') ~ '[[:cntrl:]<>]' or (s->>'department') ~ '[[:cntrl:]<>]' then raise exception 'SPEAKER_ROSTER_INVALID'; end if;
  begin selected_speaker_id:=(s->>'id')::uuid;participant_id:=(s->>'participantId')::uuid;photo_id:=(s->>'photoAssetId')::uuid;
  exception when invalid_text_representation then raise exception 'SPEAKER_ROSTER_INVALID'; end;
  if selected_speaker_id is null then raise exception 'SPEAKER_ROSTER_INVALID'; end if;
  if exists(select 1 from jsonb_array_elements(result) x where x->>'id'=selected_speaker_id::text or (participant_id is not null and x->>'participantId'=participant_id::text)) then raise exception 'SPEAKER_ROSTER_DUPLICATE'; end if;
  if participant_id is not null and not exists(select 1 from public.live_participants p where p.id=participant_id and p.session_id=p_session_id) then raise exception 'SPEAKER_ROSTER_PARTICIPANT'; end if;
  if photo_id is not null and not exists(select 1 from public.live_speaker_photos p where p.id=photo_id and p.session_id=p_session_id) then raise exception 'SPEAKER_ROSTER_PHOTO'; end if;
  normalized:=jsonb_build_object('id',selected_speaker_id,'displayName',btrim(s->>'displayName'),'company',s->>'company','department',s->>'department','photoAssetId',photo_id,'participantId',participant_id);
  select v.profile into previous from public.live_speaker_profile_versions v where v.session_id=p_session_id and v.speaker_id=selected_speaker_id order by v.version desc limit 1;
  if previous is null then next_version:=1;
  elsif (previous-'version')=normalized then next_version:=(previous->>'version')::integer;
  else next_version:=(previous->>'version')::integer+1; end if;
  normalized:=normalized||jsonb_build_object('version',next_version);
  insert into public.live_speaker_profile_versions(session_id,speaker_id,version,profile) values(p_session_id,selected_speaker_id,next_version,normalized) on conflict do nothing;
  result:=result||jsonb_build_array(normalized);
 end loop;
 if p_active_onsite_speaker_id is not null and not exists(select 1 from jsonb_array_elements(result) x where x->>'id'=p_active_onsite_speaker_id::text) then raise exception 'SPEAKER_ROSTER_ACTIVE'; end if;
 update public.live_speaker_rosters set revision=r.revision+1,applied_revision=case when current_status='preparing' then r.revision+1 else r.applied_revision end,speakers=result,active_onsite_speaker_id=p_active_onsite_speaker_id where session_id=p_session_id;
 return public.get_live_speaker_roster_gateway_v1(p_session_id);
end $$;

create function public.ack_live_speaker_roster_v1(p_session_id uuid,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.live_speaker_rosters%rowtype;
begin
 select * into r from public.live_speaker_rosters where session_id=p_session_id for update;
 if not found then
  if p_revision=0 then return public.get_live_speaker_roster_gateway_v1(p_session_id); end if;
  raise exception 'SPEAKER_ROSTER_REVISION';
 end if;
 if p_revision is null or p_revision<0 or p_revision>r.revision then raise exception 'SPEAKER_ROSTER_REVISION'; end if;
 update public.live_speaker_rosters set applied_revision=greatest(applied_revision,p_revision) where session_id=p_session_id;
 return public.get_live_speaker_roster_gateway_v1(p_session_id);
end $$;

create function public.create_live_speaker_photo_v1(p_session_id uuid,p_host_id text,p_photo_id uuid,p_content_type text,p_bytes_base64 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_status text; bytes bytea;
begin
 select status::text into current_status from public.live_sessions where id=p_session_id and host_id=p_host_id for update;
 if not found then raise exception 'SPEAKER_ROSTER_FORBIDDEN'; end if;
 if current_status in ('stopped','failed') then raise exception 'SPEAKER_ROSTER_TERMINAL'; end if;
 if p_photo_id is null or p_content_type is null or p_content_type not in ('image/jpeg','image/png','image/webp') or p_bytes_base64 is null or length(p_bytes_base64)>349528 then raise exception 'SPEAKER_ROSTER_PHOTO'; end if;
 begin bytes:=decode(p_bytes_base64,'base64');exception when others then raise exception 'SPEAKER_ROSTER_PHOTO';end;
 if octet_length(bytes) not between 1 and 262144 then raise exception 'SPEAKER_ROSTER_PHOTO'; end if;
 insert into public.live_speaker_photos(id,session_id,content_type,image_base64,size_bytes) values(p_photo_id,p_session_id,p_content_type,p_bytes_base64,octet_length(bytes));
 return jsonb_build_object('photoAssetId',p_photo_id);
end $$;
create function public.get_live_speaker_photo_v1(p_session_id uuid,p_photo_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('contentType',content_type,'bytesBase64',image_base64) from public.live_speaker_photos where session_id=p_session_id and id=p_photo_id;
$$;
revoke all on function public.get_live_speaker_roster_gateway_v1(uuid),public.get_live_speaker_roster_v1(uuid,text),public.replace_live_speaker_roster_v1(uuid,text,integer,jsonb,uuid),public.ack_live_speaker_roster_v1(uuid,integer),public.create_live_speaker_photo_v1(uuid,text,uuid,text,text),public.get_live_speaker_photo_v1(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_live_speaker_roster_gateway_v1(uuid),public.get_live_speaker_roster_v1(uuid,text),public.replace_live_speaker_roster_v1(uuid,text,integer,jsonb,uuid),public.ack_live_speaker_roster_v1(uuid,integer),public.create_live_speaker_photo_v1(uuid,text,uuid,text,text),public.get_live_speaker_photo_v1(uuid,uuid) to service_role;
