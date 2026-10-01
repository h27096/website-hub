-- Apply after the original Radio setup and any older size-limit migrations.
-- Set the project's global Storage upload limit to at least 100 MB separately.
-- This changes only the Radio size limits, preserving MIME types and policies.
begin;
alter table public.radio_tracks
  drop constraint if exists radio_tracks_file_size_check;
alter table public.radio_tracks
  add constraint radio_tracks_file_size_check
  check (file_size between 1 and 100000000) not valid;
-- NOT VALID preserves existing larger tracks while enforcing the limit on
-- all new/updated rows. Existing audio objects are not changed or deleted.
update storage.buckets set file_size_limit = 100000000
  where id = 'robco-radio';
commit;
