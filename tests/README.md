# Combined release validation

Use Node.js 24, Playwright with an installed Chromium/Edge browser, PGlite
(`@electric-sql/pglite`), and FFmpeg on PATH for generated music test fixtures.
Dependencies can be supplied through NODE_PATH; do not commit node_modules.
On Windows, set `BROWSER_CHANNEL=msedge` to use installed Microsoft Edge.

```text
node tests/v12.cjs
node tests/version-history.cjs
node tests/employee-document-db.cjs
node tests/employee-document.cjs
node tests/music-policies.cjs
node tests/music.cjs
node tests/radio.cjs
node tests/hub-regression.cjs
node tests/training-engine.cjs
node tests/training-db.cjs
node tests/training-auth.cjs
node tests/training-browser.cjs
node tests/training-diagnostics.cjs
```

All service calls are fixtures or local PostgreSQL, with no writes to production.
Browser tests use real DOM, keyboard, touch and audio playback. Live hosting,
Supabase deployment and cross-device production checks remain a deployment step.

No independent Radio upload fix is part of this release. Existing music tests are
regressions only. The Employee Document suite now selects its own dialog because
the shared Version History also adds a dialog to the document.

Training's SQL and browser suites use isolated PGlite databases. Its Auth suite
executes the real Edge handler with a mocked Auth transport, not a live service.
For production setup and acceptance checks see `SUPABASE_TRAINING_SETUP.md`.
The version-history suite now expects v1.3 released and v1.4 planned.

The stabilization suite verifies missing-function HTTP 404 before any POST,
network/CORS diagnostics, sanitized secrets, partial account creation, profile
retry, sign-out/sign-in, refresh persistence and XP/rank rendering. Edge tests
exercise the real handler and migration with Auth transport fixtures, including
profile rollback failures and successful creation followed by an Auth outage.
