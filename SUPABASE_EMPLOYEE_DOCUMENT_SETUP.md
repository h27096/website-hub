# Employee document setup

The Employee terminal retains its website-request form and adds **ROBCO EMPLOYEE DOCUMENT**. The Overseer terminal adds **MANAGE EMPLOYEE DOCUMENT**. Apply the database setup below before using those controls.

## Apply to the existing production database

1. Open the Supabase dashboard and select the existing Website Hub project (`jkvjwrylzbhtrjesgrxi`).
2. Open **SQL Editor → New query**.
3. Copy the entire contents of `supabase/migrations/20261002_employee_document.sql` into the query and click **Run** as the `postgres` database role. Wait for success.
4. Open a second new query. Paste the entire supplied **employee-document-seed.private.sql** file and click **Run** as `postgres`.
5. Refresh the Website Hub after its GitHub Pages deployment completes. Log in as an Employee and open **ROBCO EMPLOYEE DOCUMENT**.

The migration only creates this feature's tables/functions and grants. It does not reset or modify existing employees, Overseers, access codes, websites, requests, announcements, Radio or Storage. Both SQL files can be run again: the seed never overwrites an existing document or revisions.

The private seed is intentionally **not in this public repository** because the source DOCX includes employee/community access codes. Keep the supplied seed private; do not upload it to GitHub Pages, attach it to public issues, or commit it. The original DOCX is not published either. Only the source logo is a public static asset.

To regenerate the private seed from the original document, use Python 3.9+:

```sh
python tools/import-employee-docx.py "/private/robco industries (4).docx" "/private/employee-document-seed.private.sql"
```

The converter retains original wording, order, emphasis and HTTP/HTTPS hyperlinks, promotes the source's section labels to headings, and collapses the 234 adjacent identical update-log hyperlinks into one. The update log and password document remain links to the same destinations; those separate documents were not embedded or invented. Empty spacing paragraphs are omitted. The logo is extracted into `assets/robco-employee-logo.png`.

## Data and authorization

- `employee_documents`: current JSON document, revision number, timestamp and authenticated editor UUID.
- `employee_document_revisions`: every saved revision, timestamp, editor UUID, and optional restored-from revision.
- Both tables have RLS enabled, no direct `anon`/`authenticated` grants, and no permissive policies. Default-deny RLS and table privileges force access through the checked RPCs.
- `read_employee_document(employee_password)`: verifies the existing `employee_login` function for Employees or existing `overseers.user_id = auth.uid()` membership for Overseers. It does not return editor IDs to Employees.
- `save_employee_document(p_content, p_expected_revision)`: authenticated Overseers only; validates the JSON, locks the current row, rejects stale revisions, and records the new revision atomically.
- `list_employee_document_revisions(p_before)`: Overseer-only metadata, 50 revisions per page.
- `read_employee_document_revision(p_revision)`: Overseer-only historical content.
- `restore_employee_document_revision(p_revision, p_expected_revision)`: Overseer-only restore; creates a new revision and keeps history intact.
- Internal helpers `employee_document_valid_node` and `employee_document_require_overseer` are not executable by frontend roles.

Existing publishable-key and Overseer JWT authentication is reused. No service-role key is added. Employee passwords are sent only in HTTPS request bodies to the existing Supabase project, never placed in URLs or browser storage. The dialog fetches the latest version on open, explicit refresh, focus, and once a minute while visible and not editing. Edits stay in memory until saved; an expired login or failed request does not discard an open draft.

Content is a bounded JSON tree containing text, paragraphs, three heading levels, bold/italic/underline, lists, line breaks, HTTP/HTTPS links, and a fixed logo node. The server rejects other node types/attributes and limits size/depth. The browser uses `createElement`/text nodes, not stored HTML. Paste accepts plain text only; drop is blocked. Script-looking text remains inert text. Links use `noopener noreferrer` and no referrer. The formatting toolbar uses browser editing commands with native undo/redo; pasted rich formatting and arbitrary images are intentionally unsupported.

## Employee checks

1. Log in with the existing Employee password.
2. Fill a website request, open **ROBCO EMPLOYEE DOCUMENT**, then close it. Confirm the request fields remain filled.
3. Read the introduction, roster, instructions, security notices, update-log link, development notice and maintenance notice. Confirm there is no Edit/Save/History control.
4. Submit the website request and confirm it appears in the Overseer's existing review queue.
5. After an Overseer saves, reopen or select **REFRESH DOCUMENT**. Confirm the new text and revision appear. Repeat on another device.

## Overseer checks

1. Sign in through the existing Overseer email/password login and select **MANAGE EMPLOYEE DOCUMENT**.
2. Select **EDIT DOCUMENT**. Select text and use headings, bold, italic, underline, lists, or **Link**. Undo/redo are available.
3. Select **SAVE CHANGES**. Confirm the revision increases. Refresh the site, sign in again, and verify the saved text.
4. Edit again and choose **CANCEL**. Confirm the draft was not saved.
5. Select **VIEW REVISION HISTORY**. Preview an older revision, choose **RESTORE THIS REVISION**, and confirm. A new revision is created; prior versions remain.
6. Open two Overseer sessions and edit the same revision. Save one, then try saving the other. The stale save must fail and retain its draft for copying/merging.

## Validation and limits

Automated tests run the actual migration in PostgreSQL via PGlite. They cover Employee reads, unauthorized direct-table access and RPC writes, non-Overseer denial, unsafe node/attribute/protocol rejection, atomic revisions, rollback, stale saves, migration/seed reruns, and preservation of existing website requests. Browser integration exercises the real SQL functions through a local HTTP adapter; Supabase Auth and the existing employee-password check are fixtures. No production content is altered by tests.

With Node.js and the test dependencies available:

```sh
npm install --no-save playwright @electric-sql/pglite
npx playwright install chromium
node tests/employee-document-db.cjs
node tests/employee-document.cjs
node tests/radio.cjs
node tests/music-policies.cjs
node tests/music.cjs
```

`tests/music.cjs` also requires FFmpeg, as before. To validate a private seed locally, set `PRIVATE_DOC_SEED` to its absolute path before running the database test. `BROWSER_CHANNEL=msedge` can use installed Edge instead of downloaded Chromium.

Live production login, Supabase API persistence, and cross-device checks still require the two SQL files to be applied in the production project. Local test results do not claim those live checks have already occurred.
