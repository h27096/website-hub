# v1.4 — RobCo Employee & Administration Overhaul

Source implementation is ready for deployment. Keep maintenance enabled until the backend and live acceptance checks succeed. A GitHub commit **does not deploy SQL or Edge Functions**.

This repository's migration history is the inspected schema baseline. This session did not have a privileged production database connection or Supabase deployment credentials, so the live schema, deployed functions, bucket and accounts must be verified by the operator. Do not reset production. Back up the existing project before applying the additive migration.

## A. GitHub / frontend deployment

Merge the v1.4 branch/PR and allow the existing GitHub Pages workflow to deploy. The frontend needs the updated `index.html`, `personnel.js`, `personnel.css`, and `version-history-data.js`; keep all existing modules and assets. Refresh the site without stale cached scripts. Maintenance mode is not switched off by this release. The canonical version is v1.4, with v1.5 Live Training / Multiplayer still planned.

## B. SQL migration — Supabase SQL Editor ONLY

Confirm the existing v0.2 request, v1.2 Employee Document, and v1.3 Training migrations were already applied. Do not rerun the non-idempotent v1.3 migration on an existing schema. Required existing objects include `overseers`, `employee_login`, `create_managed_website`, `website_requests`, `employee_documents`, `training_sets`, `training_questions`, `training_save_set`, and `training_rate_limit`.

Run the **entire contents of**:

`supabase/migrations/20261006_personnel.sql`

in the current project's Supabase SQL Editor, as the database owner. It is one transaction and is intended to run once. It creates only additive personnel objects, adds ownership/response fields to existing website requests, revokes legacy unowned request submissions, and configures the new private bucket. It does not drop or reset existing production tables. Legacy request ownership remains NULL / LEGACY UNASSIGNED rather than guessing who used the old shared password.

Do **not** paste `npx`, `git`, or `curl` commands into the SQL Editor. Those commands belong in your computer's terminal.

Read-only SQL verification:

```sql
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'personnel-paperwork';
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename like 'personnel%';
select policyname, permissive, roles, cmd from pg_policies
where schemaname = 'storage' and policyname like 'personnel_storage%';
select name, status, employee_id from public.website_requests
where employee_id is null;
```

Expected bucket: private (`public = false`), 20,000,000 bytes, PDF only. All personnel tables have RLS enabled. Browser roles have no direct table grants; narrow security-definer RPC projections authorize reads/writes. Storage has four restrictive guards rejecting browser access to this bucket even where older permissive policies exist. Do not disable RLS or make the bucket public to fix access errors.

## C. Supabase Edge Functions — computer terminal ONLY

New function: **`personnel-auth`**. Existing **`training-auth`** is unchanged and must remain deployed for v1.3 Training accounts.

From a checkout of this repository, run:

```sh
git checkout codex/v1.4-personnel
npx supabase login
npx supabase link --project-ref jkvjwrylzbhtrjesgrxi
npx supabase functions deploy personnel-auth --project-ref jkvjwrylzbhtrjesgrxi --no-verify-jwt
```

`supabase/config.toml` specifies `verify_jwt = false` because personal login and temporary-code redemption are public operations. The handler independently verifies real Auth JWTs for private operations and actual Overseer membership for administrative actions. A publishable key is not an Overseer credential.

If v1.3 was never deployed or needs its existing fix deployed, separately run:

```sh
npx supabase functions deploy training-auth --project-ref jkvjwrylzbhtrjesgrxi --no-verify-jwt
```

Frontend personnel endpoint:

`https://jkvjwrylzbhtrjesgrxi.supabase.co/functions/v1/personnel-auth`

Frontend personnel RPCs use this same project at `/rest/v1/rpc/personnel_action` and `/rest/v1/rpc/personnel_selection`.

Readiness verification (read-only, no secret or account required):

```sh
curl -i https://jkvjwrylzbhtrjesgrxi.supabase.co/functions/v1/personnel-auth
curl -i -X OPTIONS https://jkvjwrylzbhtrjesgrxi.supabase.co/functions/v1/personnel-auth -H 'Origin: https://h27096.github.io' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: apikey,content-type'
```

GET must return HTTP 200 with `ready: true`. OPTIONS must return 204 with allowed origin, POST method, and requested headers. A 404 means the function is not deployed; SQL alone cannot fix it. GET verifies handler configuration, not every database/Auth/Storage operation. Complete the UI acceptance checks below as well.

## D. Storage / buckets / policies

The migration creates/configures **`personnel-paperwork`** and four restrictive Storage policies. Do not create a public bucket or permanent public URLs. No additional manual bucket step is needed if the migration completed.

Only the Edge service client can mint signed upload/view access after authorization. An Overseer reserves a unique path and uploads a PDF with a signed upload token (Storage's token lifetime is controlled by Supabase); upload is immutable/non-upsert. The Edge completion step downloads the stored object and validates actual size, MIME type and `%PDF-` signature before publishing the assignment. Maximum PDF size is 20 MB in both UI and bucket. View URLs expire after 60 seconds. They are bearer URLs: anyone given an unexpired authorized link could view that object until it expires. Archival/status changes prevent issuing fresh links; they cannot revoke a link already issued before its expiry.

A replacement creates a new object and archives the old assignment only after successful validation. Original bytes remain stored. A failed upload stays pending for Overseer finish/retry/archive; employees cannot see pending or archived assignments. No in-browser editing of paperwork is offered.

## E. Secrets / configuration

Supabase provides these server-only environment variables to deployed Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

No service-role key belongs in HTML, GitHub Pages, browser code, or a committed configuration file. The existing frontend publishable key remains unchanged. Do not override the platform's reserved `SUPABASE_*` secrets with frontend credentials.

Default cookie-free CORS mode is `public`: transport is allowed for any origin, while JWTs, passwords and RPC authorization protect private operations. It accommodates a Hub that changes domains. If exact origins are desired, use these **optional** secrets (replace the example list with every real hosting origin; no trailing paths):

```sh
npx supabase secrets set PERSONNEL_CORS_MODE=restricted PERSONNEL_ALLOWED_ORIGINS=https://h27096.github.io --project-ref jkvjwrylzbhtrjesgrxi
npx supabase functions deploy personnel-auth --project-ref jkvjwrylzbhtrjesgrxi --no-verify-jwt
```

To explicitly use the default:

```sh
npx supabase secrets set PERSONNEL_CORS_MODE=public --project-ref jkvjwrylzbhtrjesgrxi
npx supabase functions deploy personnel-auth --project-ref jkvjwrylzbhtrjesgrxi --no-verify-jwt
```

Auth identities use random internal `@personnel.invalid` addresses; employees supply no personal email/legal name. Passwords are hashed by Supabase Auth and are never stored in personnel tables. Supabase Auth must permit password sign-in for these confirmed, server-created identities. Self-signup does not create personnel records and cannot grant permissions.

## Authentication / permissions / data preservation

Employee selection exposes only active record ID, callsign, and title. The password exchange occurs in the Edge Function through Supabase Auth. A dedicated `robco-personnel-v14` browser session persists across refresh, separate from Training and Overseer sessions. Private RPCs require an active record and matching server-controlled Auth epoch. Password resets invalidate all earlier employee JWTs without erasing any owned data. Disabling/archiving immediately blocks private RPCs even when an Auth refresh token remains valid. Re-enable/restore an employee, then **reset the password** to synchronize the new epoch before they log in. A failed password reset stays closed; after a five-minute reset lease an Overseer can retry.

Permission IDs: `website.submit`, `training.submit`, `training.draft`, `training.edit`, `documents`, `notes`. Grants live in the personnel table and are checked server-side on each operation. Existing unknown permission IDs are retained when editing known ones, allowing future capabilities without a new Auth architecture. Employees cannot modify their own grants, status, credentials, or reviewers' decisions.

New website requests take ownership from the authenticated record, and snapshot the callsign for historical attribution. Review uses the existing publish function and records an optional response. Existing shared-password requests and existing shared document/revision history are preserved. The old shared handbook is still available via an authenticated personal projection, and its existing Overseer editor remains in PERSONNEL. Shared password request submission is revoked; the old functions/tables themselves are preserved. No historical identity is fabricated.

Training proposals are owned private drafts, then immutable pending requests. Review displays captured BEFORE data and AFTER questions/metadata. Approval calls the existing canonical v1.3 save function inside the same transaction as decision recording. Base revisions and row locks stop stale proposals from overwriting newer work. Denial does not touch canonical sets. Employees cannot propose `featured`/`archived` administration flags. If the source is deleted or changed, approval fails with CONFLICT; create a new draft from current content. Original question types and bulk/CSV/TSV parser are reused, including inactive questions in edit snapshots.

Temporary codes contain 256 random bits. Only SHA-256 hashes persist. The Edge Function displays a newly generated code once; the database atomically consumes it once within five minutes, or denies used/revoked/expired codes. Redemption returns only a **read-only snapshot of the enabled managed-site directory and visible announcements**. It returns no Auth session, employee identity, Training privilege, upload, change capability, or additional API token. The snapshot disappears on refresh; expiration is a redemption deadline, not deletion of a snapshot already displayed. Existing public directory visibility is unchanged. Only workflow events and requests are recorded; no browsing-history tracking is added.

## Production acceptance — keep maintenance enabled until complete

With two disposable personnel test records and an existing Overseer account, verify create/login/wrong password/refresh, separate notes, private versus visible admin notes, PDF upload/view/replacement/archive, employee A denied employee B's document, website attribution/review/response/history, new/edit Training drafts and approval/denial/conflict, revoked permission denial, password reset and stale-session rejection, disabled and archived login rejection, archived history, and temporary redemption/second use/expiry/revocation. Also verify existing Training sign-in/games, Radio playback/upload, announcements, website CRUD, access codes, maintenance, and Version History.

Run endpoint checks from the actual production origin (including custom domains if restricted CORS is selected). Sign out and sign in after resetting test employee passwords. Confirm no privileged key in downloaded frontend sources. Then use the existing Overseer control to disable maintenance when ready. This session has not performed live writes/deployment or these production acceptance checks.
