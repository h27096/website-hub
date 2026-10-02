# Combined release validation

Use Node.js 24, Playwright with an installed Chromium/Edge browser, PGlite
(`@electric-sql/pglite`), and FFmpeg on PATH for generated music test fixtures.
Dependencies can be supplied through NODE_PATH; do not commit node_modules.
On Windows, set `BROWSER_CHANNEL=msedge` to use installed Microsoft Edge.

```text
node --test tests/proxy.test.cjs
node tests/private-terminal-db.cjs
node tests/v12.cjs
node tests/version-history.cjs
node tests/employee-document-db.cjs
node tests/employee-document.cjs
node tests/music-policies.cjs
node tests/music.cjs
node tests/radio.cjs
node tests/hub-regression.cjs
```

All service calls are fixtures or local PostgreSQL, with no writes to production.
The proxy suite exercises real HTTP handling using mocked Supabase/DNS/HTTPS
transports; the database suite executes the actual SQL under anon/authenticated
roles. Browser tests use real DOM, keyboard, touch and audio playback. Live hosting,
Supabase deployment and cross-device production checks remain a deployment step.

No independent Radio upload fix is part of this release. Existing music tests are
regressions only. The Employee Document suite now selects its own dialog because
the shared Version History also adds a dialog to the document.
