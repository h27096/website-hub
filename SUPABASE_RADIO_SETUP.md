# Persistent Radio music — one-time setup

The frontend is ready, but the SQL migration must be applied to the existing
Supabase project before uploads work. No privileged database connection was
available during implementation, so the live database has **not** been changed.

## Apply the exact SQL

1. Open the existing Supabase project (`jkvjwrylzbhtrjesgrxi`).
2. Open **SQL Editor → New query**.
3. Copy the **entire contents** of
   [`supabase/migrations/20260923_radio_music.sql`](supabase/migrations/20260923_radio_music.sql)
   into the editor and click **Run**. Use the project's administrative SQL Editor,
   not a browser's JavaScript console. The script is transactional and rerunnable.
4. Run the entire [500 MB upgrade migration](supabase/migrations/20260924_radio_500mb.sql)
   next. If you already ran the original setup, only this upgrade is needed.
5. Under **Storage**, confirm a **private** bucket named `robco-radio` exists.
   It allows only `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/aac`, and `audio/ogg`,
   with a **500,000,000-byte (500 MB)** limit. Keep the bucket private.
6. In **Storage Settings**, set the project's **Global file size limit** to at
   least **500 MB**. Supabase Free projects cap this at 50 MB; uploads of 500 MB
   require Pro or above. The SQL cannot raise that plan/global restriction.
   See [Supabase file limits](https://supabase.com/docs/guides/storage/uploads/file-limits).

The script creates:

- `public.radio_tracks`: title, artist, station, generated Storage path, size,
  MIME type, creator, timestamps, and `pending` / `ready` / `deleting` state.
- `radio_is_overseer()`: checks the existing `public.overseers.user_id` membership
  against the authenticated user's `auth.uid()`.
- Five authorized management RPCs: `radio_reserve_track`, `radio_publish_track`,
  `radio_edit_track`, `radio_begin_delete`, and `radio_finish_delete`.
- Read RLS for published metadata; no direct client table writes. Every management
  RPC requires an authenticated Overseer, even when called outside the UI.
- Storage policies allowing published-song reads, Overseer uploads only to
  reserved paths, and Overseer deletion only after marking a song for removal.
  Object overwrites are disabled. Restrictive guards protect this bucket even
  if unrelated permissive Storage policies already exist.

It uses the existing Supabase URL, publishable key, and Overseer sign-in flow.
Do not add a service-role key, secret key, database password, or new account-wide
permissions. It does not change existing membership, other buckets, or existing
authentication, website, announcement, access-code, or maintenance functions.
The existing `overseers` membership table must remain protected against users
adding themselves; this migration does not grant any access to that table.

## Upload your first song

1. Once the GitHub Pages update is available, refresh the Hub.
2. Sign in through the existing **Overseer** login.
3. Select **MANAGE RADIO MUSIC**.
4. Choose an MP3, WAV, M4A, AAC, or OGG file, up to 500 MB (500,000,000 bytes).
5. Enter the song title, artist, and station/category. Use an existing station
   name or enter a new one. Station names are normalized to uppercase.
6. Confirm you have permission to share the audio, then select **UPLOAD SONG**.
7. Keep the tab open until **UPLOAD COMPLETE** appears. Open the user-side Radio
   and select the station. Songs are loaded whenever Radio opens; an already-open
   Radio can use **REFRESH MUSIC LIBRARY**.

The file lives in Supabase Storage and the metadata lives in PostgreSQL. Neither
depends on browser storage, the original file remaining on your computer, or a
GitHub Pages deployment. Refreshes, new browsers, computer restarts and future
frontend updates do not remove completed uploads. No automatic expiration or
cleanup job deletes stored songs.

## Edit, remove, and recover interrupted operations

- Edit a song's title, artist, or station in its card, then **SAVE METADATA**.
- **DELETE SONG** asks for confirmation, hides the entry from listeners, deletes
  the file through the Storage API, and finally removes the database row.
- A **PENDING** entry means completion was interrupted. Use **FINISH PENDING
  UPLOAD** if the file reached Storage. If it did not, remove the pending entry
  and upload again. Refresh the list before retrying an uncertain request.
- A **DELETING** entry offers **RETRY REMOVAL**. Retry is safe if the file was
  already removed but the database response was lost. The row is retained until
  Storage no longer reports the file, so cleanup remains discoverable after a
  browser restart. Do not manually delete rows from `storage.objects` in SQL;
  that does not remove the stored binary.
- If an Overseer session expires, sign in again. Completed songs and pending
  recovery records remain stored.

## Access and operational limits

- The existing guest access-code flow does not issue Supabase Auth JWTs. Therefore
  published music is readable by the `anon` role, as well as signed-in users.
  Only ready files can receive playback links. This is a listening library, not
  confidential storage or DRM: someone with the frontend's public key can also
  retrieve published tracks outside the UI. Pending/deleting rows and files are
  visible only to Overseers. No guest/employee can upload, edit, or delete.
- Playback uses one-hour signed URLs; expiry affects the link, **not** the stored
  file. Play/retry obtains a fresh link when necessary. Already issued links or
  buffered audio may briefly remain usable during deletion; file removal ends
  further access once caches expire.
- MP3 is broadly supported. Other codecs depend on the listener's browser.
  The upload form checks size, extension, file signature and browser-readable
  duration. Storage independently enforces size/MIME limits and authorization.
  This is not server-side transcoding or malware scanning; authorized uploaders
  remain responsible for their files. No commercial recordings are bundled.
- Uploads use the standard Storage API with progress and a one-hour timeout.
  They are not resumable byte transfers. On a slow connection, use a smaller file
  or retry through the pending-entry workflow. No duplicate overwrite occurs.
  Large transfers also depend on session validity and the Storage service's
  request limits. A full 500 MB network upload was not tested against live Storage.
- Supabase project availability, storage quota, bandwidth limits and account
  retention rules still apply. Keep your originals; provider-level deletion is
  outside the Hub's control.
- A blocked autoplay attempt offers **PLAY** to retry. Missing, corrupt, removed
  or unsupported files show an error; choose another track or refresh. The
  original synthesized stations remain available if Supabase is unreachable.

## Verification

Automated tests passed locally using real browser audio decoding, mocked HTTP
services, and a local PostgreSQL engine. They did **not** use live accounts or
validate the hosted Storage service. After applying SQL, upload one authorized
song, refresh/reopen the site, play it as a guest, edit its metadata as an
Overseer, and (if it is a disposable test song) delete it and verify both the
table row and Storage object disappear.

Developer tests:

```sh
npm install --no-save playwright @electric-sql/pglite
npx playwright install chromium
node tests/radio.cjs
node tests/music.cjs
node tests/music-policies.cjs
```

Set `BROWSER_CHANNEL=msedge` to test against installed Microsoft Edge instead.
Dependencies are test-only; the static site needs no build step or new runtime
package. Browser tests intercept Supabase requests and generate a tiny WAV in
memory, so they never upload recordings or alter live data. PostgreSQL tests use
minimal Auth/Storage fixtures; they verify grants/RLS/RPC behavior, not the
hosted Storage HTTP implementation.

References: [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control),
[private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[Storage metadata schema](https://supabase.com/docs/guides/storage/schema/design).
