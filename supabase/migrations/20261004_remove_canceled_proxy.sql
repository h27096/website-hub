-- Optional cleanup for installations that applied the canceled browsing feature.
-- Only dedicated objects are removed. No CASCADE: unknown dependencies cause
-- the transaction to fail and roll back rather than remove shared infrastructure.
begin;
drop function if exists public.privacy_preview_logout(text);
drop function if exists public.privacy_preview_authorize(text);
drop function if exists public.privacy_preview_login(text);
drop function if exists public.privacy_preview_status();
drop function if exists public.privacy_preview_config();
drop function if exists public.privacy_preview_set_enabled(boolean);
drop function if exists public.privacy_preview_set_destination(text,boolean);
drop table if exists public.privacy_preview_sessions;
drop table if exists public.privacy_preview_destinations;
drop table if exists public.privacy_preview_settings;
commit;
