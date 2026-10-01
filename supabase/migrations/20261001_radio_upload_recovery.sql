-- Additive production-safe recovery support. Run AFTER the existing Radio setup.
-- Does not change bucket limits, formats, policies, existing rows or other modules.
begin;
create or replace function public.radio_storage_object_exists(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare track public.radio_tracks;
begin
  if not public.radio_is_overseer() then
    raise exception 'Overseer access denied' using errcode = '42501';
  end if;
  select * into track from public.radio_tracks where id = p_id;
  if not found then raise exception 'Song unavailable'; end if;
  return exists (select 1 from storage.objects o
    where o.bucket_id = 'robco-radio' and o.name = track.storage_path);
end;
$$;
revoke all on function public.radio_storage_object_exists(uuid) from public, anon, authenticated;
grant execute on function public.radio_storage_object_exists(uuid) to authenticated;
commit;
