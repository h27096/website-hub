-- Run after 20260923_radio_music.sql, including on already configured projects.
-- Also set the project's global Storage upload limit to at least 500 MB.
-- Supabase Free projects cap individual uploads at 50 MB; 500 MB requires Pro+.
begin;
alter table public.radio_tracks
  drop constraint if exists radio_tracks_file_size_check;
alter table public.radio_tracks
  add constraint radio_tracks_file_size_check
  check (file_size between 1 and 500000000);
update storage.buckets set file_size_limit = 500000000
  where id = 'robco-radio';
commit;
