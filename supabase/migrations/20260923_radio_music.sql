-- Run this entire migration once in the project's Supabase SQL Editor.
-- Existing public.overseers(user_id) membership remains the source of authority.
begin;

create or replace function public.radio_is_overseer()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.overseers where user_id = auth.uid()
  );
$$;
revoke all on function public.radio_is_overseer() from public;
grant execute on function public.radio_is_overseer() to anon, authenticated;

create table if not exists public.radio_tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 120),
  artist text not null check (char_length(trim(artist)) between 1 and 120),
  station text not null check (char_length(trim(station)) between 1 and 60),
  storage_path text not null unique,
  file_size bigint not null check (file_size between 1 and 26214400),
  mime_type text not null check (mime_type in ('audio/mpeg','audio/wav','audio/mp4','audio/aac','audio/ogg')),
  status text not null default 'pending' check (status in ('pending','ready','deleting')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (storage_path ~ ('^' || id::text || '\.(mp3|wav|m4a|aac|ogg)$'))
);
create index if not exists radio_tracks_playlist_idx on public.radio_tracks(status, station, created_at, id);
alter table public.radio_tracks enable row level security;
revoke all on public.radio_tracks from public, anon, authenticated;
grant select on public.radio_tracks to anon, authenticated;
drop policy if exists radio_tracks_read on public.radio_tracks;
create policy radio_tracks_read on public.radio_tracks for select to anon, authenticated
  using (status = 'ready' or public.radio_is_overseer());
-- Guard against any pre-existing permissive policies on this table.
drop policy if exists radio_tracks_read_guard on public.radio_tracks;
create policy radio_tracks_read_guard on public.radio_tracks as restrictive for select to anon, authenticated
  using (status = 'ready' or public.radio_is_overseer());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('robco-radio', 'robco-radio', false, 26214400,
  array['audio/mpeg','audio/wav','audio/mp4','audio/aac','audio/ogg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Private bucket: only published songs are readable by listeners. Existing guest
-- access codes are not Supabase Auth sessions, so listeners use the anon role.
drop policy if exists radio_object_read on storage.objects;
create policy radio_object_read on storage.objects for select to anon, authenticated using (
  bucket_id = 'robco-radio' and (public.radio_is_overseer() or exists (
    select 1 from public.radio_tracks t where t.storage_path = name and t.status = 'ready'
  ))
);
drop policy if exists radio_object_insert on storage.objects;
create policy radio_object_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'robco-radio' and public.radio_is_overseer() and exists (
    select 1 from public.radio_tracks t where t.storage_path = name and t.status = 'pending'
  )
);
drop policy if exists radio_object_delete on storage.objects;
create policy radio_object_delete on storage.objects for delete to authenticated using (
  bucket_id = 'robco-radio' and public.radio_is_overseer() and exists (
    select 1 from public.radio_tracks t where t.storage_path = name and t.status = 'deleting'
  )
);
-- Restrictive guards prevent unrelated broad Storage policies from granting
-- writes to this bucket. They do not alter access to other buckets.
drop policy if exists radio_storage_read_guard on storage.objects;
create policy radio_storage_read_guard on storage.objects as restrictive for select to anon, authenticated using (
  bucket_id <> 'robco-radio' or public.radio_is_overseer() or exists (
    select 1 from public.radio_tracks t where t.storage_path = name and t.status = 'ready'
  )
);
drop policy if exists radio_storage_insert_guard on storage.objects;
create policy radio_storage_insert_guard on storage.objects as restrictive for insert to anon, authenticated with check (
  bucket_id <> 'robco-radio' or (public.radio_is_overseer() and exists (
    select 1 from public.radio_tracks t where t.storage_path = name and t.status = 'pending'
  ))
);
drop policy if exists radio_storage_update_guard on storage.objects;
create policy radio_storage_update_guard on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'robco-radio') with check (bucket_id <> 'robco-radio');
drop policy if exists radio_storage_delete_guard on storage.objects;
create policy radio_storage_delete_guard on storage.objects as restrictive for delete to anon, authenticated using (
  bucket_id <> 'robco-radio' or (public.radio_is_overseer() and exists (
    select 1 from public.radio_tracks t where t.storage_path = name and t.status = 'deleting'
  ))
);

create or replace function public.radio_reserve_track(
  p_title text, p_artist text, p_station text, p_extension text, p_size bigint, p_mime text
) returns public.radio_tracks language plpgsql security definer set search_path = '' as $$
declare track public.radio_tracks; new_id uuid := gen_random_uuid();
begin
  if not public.radio_is_overseer() then raise exception 'Overseer access denied' using errcode = '42501'; end if;
  if not coalesce((p_extension, p_mime) in (
    ('mp3','audio/mpeg'), ('wav','audio/wav'), ('m4a','audio/mp4'), ('aac','audio/aac'), ('ogg','audio/ogg')
  ), false) then raise exception 'Unsupported audio format'; end if;
  insert into public.radio_tracks(id,title,artist,station,storage_path,file_size,mime_type,created_by)
    values(new_id,trim(p_title),trim(p_artist),upper(trim(p_station)),new_id::text || '.' || p_extension,p_size,p_mime,auth.uid())
    returning * into track;
  return track;
end;
$$;

create or replace function public.radio_publish_track(p_id uuid)
returns public.radio_tracks language plpgsql security definer set search_path = '' as $$
declare track public.radio_tracks;
begin
  if not public.radio_is_overseer() then raise exception 'Overseer access denied' using errcode = '42501'; end if;
  select * into track from public.radio_tracks where id = p_id for update;
  if not found or track.status = 'deleting' then raise exception 'Song unavailable'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'robco-radio'
    and o.name = track.storage_path and (o.metadata->>'size')::bigint = track.file_size
    and o.metadata->>'mimetype' = track.mime_type) then
    raise exception 'Upload missing or incomplete. Remove this pending entry and upload again.';
  end if;
  update public.radio_tracks set status = 'ready', updated_at = now() where id = p_id returning * into track;
  return track;
end;
$$;

create or replace function public.radio_edit_track(p_id uuid, p_title text, p_artist text, p_station text)
returns public.radio_tracks language plpgsql security definer set search_path = '' as $$
declare track public.radio_tracks;
begin
  if not public.radio_is_overseer() then raise exception 'Overseer access denied' using errcode = '42501'; end if;
  update public.radio_tracks set title=trim(p_title), artist=trim(p_artist), station=upper(trim(p_station)), updated_at=now()
    where id=p_id and status <> 'deleting' returning * into track;
  if not found then raise exception 'Song unavailable'; end if;
  return track;
end;
$$;

create or replace function public.radio_begin_delete(p_id uuid)
returns public.radio_tracks language plpgsql security definer set search_path = '' as $$
declare track public.radio_tracks;
begin
  if not public.radio_is_overseer() then raise exception 'Overseer access denied' using errcode = '42501'; end if;
  update public.radio_tracks set status='deleting', updated_at=now() where id=p_id returning * into track;
  return track;
end;
$$;

create or replace function public.radio_finish_delete(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare track public.radio_tracks;
begin
  if not public.radio_is_overseer() then raise exception 'Overseer access denied' using errcode = '42501'; end if;
  select * into track from public.radio_tracks where id=p_id for update;
  if not found then return true; end if;
  if track.status <> 'deleting' then raise exception 'Begin removal first'; end if;
  -- Never DELETE from storage.objects in SQL: that would orphan the actual file.
  if exists(select 1 from storage.objects where bucket_id='robco-radio' and name=track.storage_path) then
    raise exception 'Audio file still exists. Retry removal.';
  end if;
  delete from public.radio_tracks where id=p_id;
  return true;
end;
$$;

revoke all on function public.radio_reserve_track(text,text,text,text,bigint,text) from public, anon, authenticated;
revoke all on function public.radio_publish_track(uuid) from public, anon, authenticated;
revoke all on function public.radio_edit_track(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.radio_begin_delete(uuid) from public, anon, authenticated;
revoke all on function public.radio_finish_delete(uuid) from public, anon, authenticated;
grant execute on function public.radio_reserve_track(text,text,text,text,bigint,text) to authenticated;
grant execute on function public.radio_publish_track(uuid) to authenticated;
grant execute on function public.radio_edit_track(uuid,text,text,text) to authenticated;
grant execute on function public.radio_begin_delete(uuid) to authenticated;
grant execute on function public.radio_finish_delete(uuid) to authenticated;
commit;
