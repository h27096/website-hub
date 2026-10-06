# v1.4 completion / deployment handoff

Implemented source: RobCo Employee & Administration Overhaul. Production deployment and live acceptance remain required; see `SUPABASE_PERSONNEL_SETUP.md`. v1.5 is not implemented.

## Major features

Personal Supabase Auth employee identities, isolated persistent employee sessions, dashboards, personnel records/directory, role/permission controls, disabled/inactive/archived statuses, password resets with JWT invalidation, personal notes, server-filtered Overseer notes, private PDF assignments/replacements/archival, authenticated website attribution and review responses/history, private Training drafts/manual questions/import/edit proposals and conflict-safe Overseer approval, limited five-minute one-use temporary snapshot codes, and nested Overseer administration preserving existing controls.

## Files

Added: `personnel.js`, `personnel.css`, `supabase/migrations/20261006_personnel.sql`, `supabase/functions/personnel-auth/index.ts`, this report, `SUPABASE_PERSONNEL_SETUP.md`, `tests/personnel-db.cjs`, `tests/personnel-auth.cjs`, `tests/personnel-browser.cjs`.

Changed: `index.html` (replace shared employee UI, attach personnel module, escape administrative website/announcement text), `supabase/config.toml`, `version-history-data.js`, `README.md`, `tests/README.md`, and existing UI regression fixtures for isolated sessions and category navigation. Existing Training engine/auth/function, Radio, Files, Holotapes and shared document implementations remain intact.

## Database / RPC / authorization inventory

New tables: `personnel`, `personnel_notes`, `personnel_admin_notes`, `personnel_events`, `personnel_documents`, `personnel_training_requests`, `personnel_temporary_access`. Each has RLS and no direct browser grants. Service role has necessary server table grants. Private browser projections use checked security-definer RPCs with empty search paths.

Added website-request columns: `employee_id` (non-cascading personnel FK), `employee_label` (historical callsign snapshot), `response`. Existing statuses are retained: `rejected` displays DENIED. Personnel/request/document ownership uses non-cascading FKs, and UI archives rather than deletes records. Training source/published FKs use SET NULL to preserve proposal history if a canonical set is deleted.

RPCs: `personnel_selection()` (anon/authenticated public selection), `personnel_action(text,jsonb)` (authenticated and action/owner/permission checks), helpers `personnel_rate_limit(text,integer)` (service only), `personnel_require(text)` and `personnel_validate_training(jsonb,jsonb)` (no public/browser execute); `personnel_issue_temporary(uuid,text)`, `personnel_claim_temporary(text)`, and `personnel_finish_document(uuid,uuid)` (service only). The unified action endpoint implements personal/admin profile, directory, role/status update, reset epoch lease/completion, admin notes, note CRUD, website submit/list/review, Training create/save/submit/list/review, document metadata/reservation/archive/authorized path, temporary-code status/revoke, and the existing shared document projection.

Existing canonical Training save and website approval RPCs are reused unchanged. The shared-password website submit RPC remains defined but execute is revoked from PUBLIC/anon/authenticated. Historical requests remain preserved and unassigned; no reliable individual identity exists in the old schema. No data reset or drop is performed.

Storage: new private `personnel-paperwork` PDF bucket, 20 MB limit. Four restrictive `personnel_storage_*_guard` policies prevent browser-role SELECT/INSERT/UPDATE/DELETE even with broad older permissive policies. Actual owner/Overseer authorization occurs before Edge signing. Upload tokens cannot upsert original paths. Actual object validation precedes publication. Signed downloads expire in 60 seconds. Existing Radio buckets/policies and shared document/revision tables are untouched.

Edge: new `personnel-auth` for login, Overseer creation/password reset, document upload/finish/view signing, temporary code creation/redemption; built-in service secrets stay server-only. `training-auth` is unchanged. Both functions deploy separately from SQL and frontend commits. Exact SQL, terminal deployment commands, endpoint verification and optional CORS configuration are in `SUPABASE_PERSONNEL_SETUP.md`.

## Verification

Local PostgreSQL/PGlite tests exercise real migrations under anon/authenticated/service roles, including 51 ownership, permissions, workflow, revision, archival, session and restrictive Storage assertions. Edge tests execute the actual TypeScript handler against the real local migration with isolated Auth and Storage transport fixtures. Browser tests use Chromium, real DOM and RPCs backed by the local database; external services are isolated fixtures. No test writes production data.

The existing regression suites and the new personnel suites are listed in `tests/README.md`. Final complete run: all 17 suites passed (14 existing regression suites plus 3 new personnel suites), including 51 explicit personnel database security/workflow assertions. Inline scripts and new JavaScript parse successfully; `git diff --check` passes. Desktop/mobile screenshots were inspected at 1280/390/320 px without horizontal overflow. Live Supabase deployments and production cross-device checks are not claimed as completed.

## Known limits / deployment status

- The inspected schema baseline is repository migration history, not a privileged production schema export; reconcile existing production objects before applying the additive migration.
- Production SQL/function/Storage configuration has not been applied in this session. Keep maintenance enabled until operator deployment and acceptance.
- Public selection intentionally reveals active callsigns/titles/record IDs; no private profile, notes, Auth identifier or hash is in that projection.
- Personnel PDF validation checks size/MIME/signature, not malware or signed-document integrity. Originals are preserved without editing. Authorized short-lived signed links are bearer access until expiry.
- Restoring/enabling a record requires a password reset; failed Auth updates invalidate prior sessions and require an Overseer retry after the five-minute reset lease.
- Temporary access yields a single read-only managed-directory/announcement snapshot; it has no continuing Auth session or live Training access. A redeemed snapshot remains visible until refresh/exit.
- Legacy shared-password requests cannot safely be assigned to specific people and remain unassigned. No employee source tables were dropped.
- Training proposal review shows full captured before/after data; a stale edit must be recreated from the current source. It cannot silently force an overwrite.

Final commit SHA and review link are supplied in the handoff message. The canonical history adds v1.4 and preserves all earlier releases; the sole next roadmap item is v1.5 Live Training / Multiplayer. Work stops at v1.4.
