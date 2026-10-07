# v1.3 — RobCo Training Center deployment

This is one v1.3 release. v1.4 remains **RobCo Live Training / Multiplayer**.
Deploy the backend before publishing the changed static files. No production
database operations are performed by the test suites.

## v1.3 stabilization: migration already applied

**The Edge Function is not deployed at the configured endpoint (verified again
October 5, 2026). You still need to deploy it.** The repo contains
`supabase/functions/training-auth/index.ts` (a Deno/Supabase Edge Function) and
`supabase/config.toml` with `verify_jwt = false`. The frontend derives the endpoint
from its existing `SUPABASE_URL`:

`https://jkvjwrylzbhtrjesgrxi.supabase.co/functions/v1/training-auth`

GET with no API key, GET with the frontend publishable key, OPTIONS (for GET and
POST), and POST all returned HTTP 404 / `NOT_FOUND: Requested function was not
found`. Auth settings and `training_catalog` were reachable. This is the existing
Website Hub project, not a new or mismatched project. Neither the SQL migration,
GitHub Pages deployment nor a GitHub commit deploys Edge Functions.

The previous readiness GET still sent `apikey`; that custom header caused a
browser preflight. The missing function's OPTIONS returned 404, hiding the useful
JSON behind `NETWORK_OR_CORS`. Readiness now uses a simple GET **without custom
headers, cookies or a body**, so that gateway 404 can be read directly.
**No corrective SQL is needed. Do not rerun the applied migration or reset data.**

### Exact manual steps (Windows, macOS or Linux)

1. Install Node.js 20 or newer if needed. Open a terminal in an updated checkout
   of this repository containing the fixed function and frontend. If using the
   review branch, fetch and switch to it before deploying. `supabase/config.toml`
   already exists; do not overwrite it with `supabase init`.
2. Run these commands from the repository root (`npx` obtains the Supabase CLI):

   ```sh
   npx supabase login
   npx supabase secrets set --project-ref jkvjwrylzbhtrjesgrxi TRAINING_CORS_MODE=public
   npx supabase functions deploy training-auth --project-ref jkvjwrylzbhtrjesgrxi --no-verify-jwt --use-api
   npx supabase functions list --project-ref jkvjwrylzbhtrjesgrxi
   ```

   Sign in to the Supabase account that can deploy to this project. `--use-api`
   bundles on Supabase, so this deployment does not need local Docker. `login`
   may request your personal Supabase access token; enter it only in the CLI,
   never the site or a commit. The explicit project ref avoids a separate link
   or database-password step. Do not run `db push` or `db reset` for this fix.
3. Supabase supplies `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
   `SUPABASE_ANON_KEY` to the hosted function. No browser/service-role secret
   copying is required. The only custom configuration needed for this public
   Hub is **`TRAINING_CORS_MODE=public`**. Any older
   `TRAINING_ALLOWED_ORIGINS` list is ignored in public mode; it need not be
   deleted. `--no-verify-jwt` permits public signup/login/readiness with the
   frontend's publishable key in `apikey` (not as a fake Bearer JWT).
   Privileged POST actions still verify the real Overseer bearer JWT and role.
4. Check deployment from the same directory:

   ```sh
   node tools/check-training-endpoint.cjs
   ```

   This script uses the current project URL from `index.html` and current origin
   from `CNAME`. To check another actual domain, use
   `node tools/check-training-endpoint.cjs --origin https://your-current-hub-domain`.
   It sends only GET and OPTIONS, never creates an account or consumes the
   function's attempt counters. Expected result: **READY**, GET 200 with
   `ready: true`, OPTIONS 204 with matching CORS headers. The gateway's old 404
   means the function is still missing at that URL; a CLI success message alone
   is not the acceptance check.
5. Publish the changed static files with the existing GitHub Pages workflow and
   refresh the Hub. Create a disposable Personnel File, confirm XP/rank fields,
   sign out/in, refresh, and verify wrong-password/duplicate/disabled behavior.
   Production create/sign-in acceptance is blocked until the function is
   deployed. Local tests do not imply a live deployment.

### CORS and changing Hub domains

The public static Hub can move to any domain. Public mode uses
`Access-Control-Allow-Origin: *` with methods `GET, POST, OPTIONS` and headers
`authorization, apikey, content-type, x-client-info`. All responses include CORS
headers; OPTIONS returns 204 before Auth/table/rate-limit work. Fetch explicitly
uses `credentials: omit`, and the server never enables
`Access-Control-Allow-Credentials`. Origin values are not blindly reflected.
Moving the Hub does not require code edits, function redeployment or an updated
origin secret in **public** mode. A new domain has independent browser session
storage; users sign in again using their existing Personnel File.

CORS is transport permission, not account authorization. Password checks and
rate limits remain server-side; admin actions use `Auth.getUser` and the existing
Overseer table; private Training RPCs enforce identity, account status and RLS.
A foreign site does not receive the Hub origin's locally stored bearer token,
and no cookie is automatically sent to authorize an action. Public signup/login
were already callable from non-browser clients; origin lists are not bot
protection. No service-role key, recovery secret or private account projection
is exposed by readiness or by public CORS.

For operators who deliberately need a fixed browser-origin policy, opt in:

```sh
npx supabase secrets set --project-ref jkvjwrylzbhtrjesgrxi TRAINING_CORS_MODE=restricted TRAINING_ALLOWED_ORIGINS=https://first.example,https://second.example
```

This is optional, not the recommended deployment model for the changing public
Hub. Restricted origins are normalized exact HTTP(S) origins, not wildcard
substrings. Paths, query strings, credentials, wildcard hosts and empty lists
are rejected. Changing domains in restricted mode requires updating this list.
Only the public readiness/configuration response remains readable from a denied
origin; denied POSTs are rejected before Auth or database work. Missing/invalid
restricted configuration fails closed with `BACKEND_CONFIGURATION`.

### Diagnostics and their limits

| Report | Evidence |
| --- | --- |
| FUNCTION NOT DEPLOYED | Readable 404 with gateway code `NOT_FOUND` |
| CORS PREFLIGHT FAILED | Standalone probe proves OPTIONS/header mismatch, or readiness reports a denied origin; UI labels unreadable POST with working GET as **suspected** preflight/POST-response CORS |
| FUNCTION UNREACHABLE | Both readable/opaque GET attempts fail; deployment status unconfirmed |
| AUTHORIZATION FAILED | Readable HTTP 401/403 or an explicit credentials/account access error |
| CORS RESPONSE BLOCKED | An opaque GET reaches an HTTP endpoint but the readable GET fails; HTTP status/function existence remain unconfirmed |

Browser fetch intentionally hides blocked HTTP responses. JavaScript cannot
always distinguish DNS/TLS/network policy from blocked CORS responses, or OPTIONS
failure from a missing POST response header. The UI does not invent an HTTP
status or claim an opaque response proves deployment. Use the read-only script
or DevTools Network OPTIONS/POST entries for definitive server-side evidence.
No credential-bearing POST is retried automatically after a transport error.
No request bodies, tokens, passwords or recovery codes are logged.

If creation succeeds but session/profile loading fails, sign in with the same
credentials or use RETRY PROFILE; do not register again. Failed profile inserts
attempt Auth rollback and explicitly report rollback failure requiring repair.
Direct Training table grants/RLS remain unchanged. v1.4 is not part of this fix.

## Initial deployment steps (new installations only)

1. Back up the existing Supabase database using your normal backup procedure.
   Use the existing project `jkvjwrylzbhtrjesgrxi`. Do not create or reset a project.
   The existing `public.overseers(user_id)` table must already be present.
2. In that project's **SQL Editor**, open a new query, paste the complete contents
   of `supabase/migrations/20261005_training_center.sql`, and run it **once**.
   It is a transaction and creates only Training objects. Do not rerun all old
   migrations or use `supabase db reset`. This migration intentionally fails if
   Training tables already exist; investigate a previous deployment rather than
   dropping tables. With an already linked and correctly baselined migration
   workflow, apply this same pending migration through that workflow instead.
3. Install/use the Supabase CLI on your development machine and authenticate with
   `supabase login`. From this repository directory, run:

   ```sh
   npx supabase secrets set --project-ref jkvjwrylzbhtrjesgrxi TRAINING_CORS_MODE=public
   npx supabase functions deploy training-auth --project-ref jkvjwrylzbhtrjesgrxi --no-verify-jwt --use-api
   ```

   Public CORS mode supports changing hosting origins with cookie-free requests.
   See the configuration and security explanation above. No hard-coded hosting
   domain needs to be maintained in function code.

   Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the hosted
   Edge Function. **Never copy the service-role key into the website or GitHub.**
   `--no-verify-jwt` is necessary for logged-out signup/login/recovery. The handler
   explicitly checks user tokens and `public.overseers` for admin operations.
4. Publish the static files using the Hub's existing hosting workflow. New files
   are `training.js`, `training-engine.js`, and `training.css`; `index.html` loads
   them. Publish the updated `version-history-data.js` at the same time.
   Do not change existing authentication, Auth email-confirmation settings,
   Employee credentials, Radio storage, or Hub tables.
5. Perform the production acceptance checks below using disposable callsigns and
   a small study set. Local tests cover PostgreSQL and browser behavior with
   isolated Auth/service fixtures; they do not prove your deployed Auth, CORS or
   hosting configuration is correct.

## Authentication and recovery

The Training Center entry is in the User Dashboard after normal Hub access-code
login; it is not shown on the login screen. Existing Overseer management remains
available in Overseer Mode. This follows the Hub's navigation gate; the study
catalog API remains public, while private profile and management APIs retain
their server-side authorization. A saved Training session does not bypass the
normal Hub login screen after refresh.

Training uses Supabase Auth. Registration creates an Auth user with a random
internal address ending in `@training.invalid`, confirms that internal address
server-side, and inserts a unique, case-insensitive callsign mapped to the Auth
UUID. No real name or email is collected. Passwords are handled only by Auth,
never stored in Training tables or returned to an Overseer. A failed profile
creation attempts to clean up the newly created Auth identity.

The Edge Function resolves a callsign for login and exchanges its password with
Supabase Auth. The browser stores the Auth session through a separate Supabase
client (`robco-training-auth` storage key). This does not replace the existing
Overseer session or Employee access flow. Local storage holds the session, not
the source of truth for progress. Profiles, scores and progress live in Supabase.
On a different device or domain, sign in again with the same callsign/password.

An authenticated Overseer searches **TRAINING PERSONNEL** and chooses **ISSUE
PASSWORD RESET**. The Edge Function generates 32 random bytes with Web Crypto,
returns the 64-character code once, and stores only its SHA-256 digest. A code
expires after 45 minutes; issuing another revokes the previous waiting code.
The user selects **FORGOT PASSWORD / RECOVER PERSONNEL FILE** and supplies the
callsign, code and new password. A service-only SQL function locks the profile
and atomically claims the code, so it cannot be replayed. The Edge Function then
uses `auth.admin.updateUserById` to change the password. XP, progress and scores
remain attached to the same Auth UUID.

States include PASSWORD RESET ISSUED, WAITING FOR USER, PASSWORD RESET COMPLETED,
RESET EXPIRED, RESET REVOKED, PROCESSING and RESET FAILED. If Auth is unavailable
after a claim, the code fails closed; the Overseer must issue a fresh code.
An in-flight reset blocks a second issuance for five minutes; a crashed worker
can then be recovered by issuing a new code. Code values are not redisplayed.

Reset and disabling invalidate earlier Training sessions through `valid_after`.
All private Training RPCs enforce that timestamp and the disabled flag. Auth
JWTs have second precision: if an immediate post-reset login is rejected, wait
one second and sign in again. Re-enabling requires a fresh login. Public study
material remains public. Password reset does not change any other Hub role.

Passwords must be 12–128 characters. Public Edge requests have database-backed
15-attempt/15-minute budgets for both a hashed address key and a hashed callsign
or target key. Rate-limit keys expire; no raw IP is stored. These controls do not
replace infrastructure-level bot protection. Recovery is an Overseer-mediated
workflow; users should agree on how the Overseer verifies their identity.

## Database inventory and authorization

Seven new tables:

| Table | Purpose |
| --- | --- |
| `training_profiles` | Auth UUID, unique callsign, joined date, disabled state, XP, session cutoff |
| `training_sets` | Subject, unit, topic, title, description, optional source URL, archive/feature state, revision |
| `training_questions` | One reusable term/MC/TF/typed question bank, ordered active/disabled items |
| `training_runs` | Server-issued runs, immutable question snapshots, mode, timestamps, computed results, moderation state |
| `training_progress` | Per-player/set best performance XP and known/practice flashcards |
| `training_resets` | Hashed recovery challenges, issuer, expiration and state |
| `training_limits` | Hashed temporary attempt budgets |

All seven tables have **RLS enabled and no permissive browser policies**. Direct
table grants are revoked from PUBLIC, anon and authenticated, including
Overseers. Service-role access is confined to the Edge Function. RPCs use an
empty search path, explicit schema names, restricted EXECUTE grants and backend
authorization. The migration does not change existing Hub policies or tables.

| RPC/helper | Access |
| --- | --- |
| `training_catalog`, `training_study` | Public active sets/questions; `p_admin=true` requires Overseer membership |
| `training_leaderboard` | Public callsign, score and cosmetic rank only |
| `training_profile`, `training_flash_progress`, `training_start`, `training_finish` | Enabled Training player; only own records |
| `training_personnel`, `training_personnel_runs`, `training_moderate`, `training_save_set`, `training_delete_set` | Authenticated Overseer only |
| `training_issue_reset`, `training_claim_reset`, `training_rate_limit` | Service-role only |
| `training_require_player`, `training_require_overseer`, `training_rank`, `training_statistics` | Internal helpers; no browser EXECUTE grant |

The `training-auth` Edge Function supports `signup`, `login`, `recover`,
`issue-reset`, and `delete`. Permanent deletion requires the exact phrase
`DELETE <callsign>`, a second browser confirmation, and verified Overseer access.
It refuses to delete an Overseer identity or an identity not created as a
Training account. UI moderation can disable/re-enable, rename callsigns, revoke
resets and invalidate scores; invalidation recomputes progression XP.

## Learning, scores and games

Every mode consumes the same active question bank. Source URLs are links only;
no Quizlet or other scraping is implemented. Bulk import accepts exactly two
fields per row: term/prompt and definition/answer. CSV quoting, escaped quotes,
multiline quoted fields and TSV are supported. Optional headers are recognized.
Malformed rows block import and show errors; valid items must be previewed and
added to the editor before saving. Rich MC/TF/typed questions use the manual
editor. Maximum 500 questions/set and 1 MB/import. Typed answers compare a single
canonical answer ignoring case and surrounding whitespace.

Flashcards support flip, previous/next, shuffle, reversed term cards, known/needs
practice and restart. Buttons support keyboard and touch; arrow keys navigate.
Signed-in flashcard assessments persist without awarding grindable XP.

Ranked runs select up to 20 active questions on the server. Finish submits only
answers and allowed actions, never a score or XP. PostgreSQL replays the exact
snapshot and independently calculates correctness, streaks, utility budgets,
energy expenditure, damage, scores and completion. It rejects wrong ownership,
unknown fields, impossible actions, premature completion, excessive answers,
expired sessions and duplicate submissions. Runs expire after four hours and
starts are limited to 60 per player/hour. Mid-run edits cannot change a snapshot.

| Mode | Rules |
| --- | --- |
| Quiz | 100 points per correct answer; feedback after each answer |
| Reactor Rush | Correct answers produce 100 + up to 50 streak points and restore 5 stability; mistakes cost 25 stability |
| Terminal Hack | 120 points per correct answer; every 3-answer streak earns a limited utility to skip or remove a wrong choice; mistakes cost 20 integrity |
| Vault Defense | Correct answers give 100 points and 2 energy; spend 3 on repair, shield or defense; increasingly strong waves every 3 questions; surviving waves gives 50 points |
| Caps Run | Checkpoint travel with keyboard/touch lane selection; correct answers give 50 × capped streak multiplier, plus 20 in the bonus lane; mistakes break the multiplier and cost 20 fuel |

The games use original text/CSS visuals, no Fallout artwork. The modes are
turn-based and lightweight; reaction speed does not decide learning XP.

Performance XP = floor(100 × correct / assigned questions) + 25 when all assigned
questions are answered. Total Training XP sums the **best performance per set
across all modes**, so replaying an identical result or changing games cannot
farm XP. The result screen labels performance XP separately from total XP.
Ranks: TRAINEE 0, JUNIOR TECHNICIAN 200, TECHNICIAN 750, SENIOR TECHNICIAN 2000,
ROBCO SPECIALIST 5000. These have no relationship to school grades.

Leaderboards group by study set + mode, keep each player's best non-invalidated
score, and display at most 50 entries. Overall XP has a separate public board.
Disabled profiles are hidden from boards. Personnel/profile statistics and high scores use all non-invalidated runs.
Personnel shows 100 recent runs initially, with a Load Older Runs control and
direct high-score moderation.

## Validation and production acceptance

Use Node 24, Playwright, PGlite and FFmpeg. See `tests/README.md`. New suites:

```sh
node tests/training-engine.cjs
node tests/training-db.cjs
node tests/training-auth.cjs
node tests/training-browser.cjs
```

The Auth suite executes the actual TypeScript handler with a local PostgreSQL
database and an isolated Auth transport fixture. Browser tests route requests to
that local database and mock the Supabase SDK/Auth transport. Tests cannot prove
live password hashing, actual token refresh, deployment, or cross-domain CORS.
Those are Supabase/platform acceptance checks:

1. Create a disposable Personnel File; sign out/in, refresh, and sign in from a
   second device or browser. Verify the same profile and progress appear.
2. As an Overseer create, edit, duplicate, archive and restore a study set; set it
   featured; import material with preview; disable and re-enable a question.
3. Complete Flashcards and each of Quiz/Reactor/Terminal/Vault/Caps; check touch
   controls, saved XP, rank and both kinds of leaderboard from the second device.
4. Issue a reset. Check no password is visible. Recover; verify the old password
   fails, the new one works, progress is intact and the code fails a second time.
   Repeat with revocation and expiration; inspect the displayed reset state.
5. Disable/re-enable, rename and moderate a score. Try management requests using
   a regular Training JWT; they must fail. Delete only the disposable account
   with exact confirmation. Confirm an impossible score cannot be submitted.
6. Smoke-test existing Employee and Overseer access, Radio/Music,
   announcements, access codes, websites, mini-games and Version
   History. Confirm the canceled proxy remains absent.

## Limits and v1.4 boundary

Study answers are deliberately available for learning. Server scoring prevents
arbitrary fabricated totals and replay, but does not prove a human learned the
answer or prevent bots consulting the public bank. This is not a proctored
assessment or competitive anti-cheat system.

Guest practice is not saved. Leaving a run abandons it; resuming unfinished runs
is not included. Auth failures after code consumption require a fresh code.
Public sets are not encrypted/private curriculum. Personnel results are paginated (100 runs/page; 50 callsign matches); narrow
search when needed. Import is two-column material, not arbitrary third-party export formats.

The pure `TrainingEngine` rules accept state, mode, question and action. The
controller supplies study set, question snapshot and player identity. These,
the stable Auth UUIDs, canonical questions, modes and run results can be reused
by a future authoritative room host. No rooms, multiplayer synchronization or
v1.4 implementation is present.

Auth API references: [server-side password update](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid),
[verified user lookup](https://supabase.com/docs/reference/javascript/auth-getuser).

## Reference documentation

- [Supabase CLI deployment flags](https://supabase.com/docs/reference/cli/supabase-functions-deploy)
- [CORS handling](https://supabase.com/docs/guides/functions/cors)
- [Publishable keys and Authorization headers](https://supabase.com/docs/guides/functions/auth-headers)
- [CLI and Node requirements](https://supabase.com/docs/guides/local-development/cli/getting-started)
