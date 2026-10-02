# Private Terminal setup for the combined v1.2 release

## Deployment status

The GitHub Pages frontend is ready to deploy. **No backend has been deployed by
this change, and no live Supabase migration has been applied.** `proxy-config.js`
deliberately contains an empty URL. The interface reports unavailable configuration
or a missing backend instead of pretending to connect. Enabling the database
switch alone does not deploy the service.

## Why the previous proxy did not appear

The original September 22 privacy-preview milestone existed in local commit
`facb7ef` in the earlier chat, but its push was rejected and its files never reached
`main`. Its source was recovered from that chat's recorded file-creation commands.
The original backend and `privacy_preview_*` settings/destination model are reused.
The earlier client was only reachable from the Overseer panel, accepted only an
Overseer JWT, had no Home Screen integration or navigation history, and left the
backend URL empty. Its SQL and HTTPS service still required separate deployment.

## 1. Apply the additive Supabase migrations

In the **existing** Supabase project, open SQL Editor as the database owner and
run the complete contents of these files in this order:

1. `supabase/migrations/20260922_privacy_preview.sql`
2. `supabase/migrations/20261003_private_terminal.sql`

Both are included in this release. The second is an upgrade, not a database reset.
Existing enabled state and approved hosts are retained; a new installation starts
disabled with no approved hosts. It requires the existing `public.overseers`,
`public.use_access_code(text)` and `public.get_maintenance_mode()` used by the Hub.
It does not replace those authentication or maintenance functions or touch existing
employee documents, music, codes, websites or announcements.

The first migration restores the original restricted settings/allowlist. The
second explicitly removes default PUBLIC/anon grants from administrative RPCs,
adds a public read-only availability RPC and limited user-session RPCs. Only a
verified Supabase JWT whose `auth.uid()` belongs to `public.overseers` can update
settings. Employees and access-code users receive no administrative grants.

The existing access-code validator is called exactly once during normal login.
Successful logins receive a random, one-hour, proxy-only capability, held in browser
memory. The database stores only its SHA-256 hash and expiry, not the access code,
pages or visited URLs. Logout revokes it when connected; refresh/re-login obtains
a new capability. Expired rows are removed at later successful logins. Normal Hub
login falls back to the legacy validator only if the new RPC is absent (HTTP 404).
It never falls back after an authentication rejection or ambiguous network failure.

## 2. Host the existing backend separately

GitHub Pages cannot run this Node server. Deploy the `proxy/` folder to an
approved server using Node.js 24 or a supported newer Node release. No npm runtime
dependencies are required. Set these server environment variables:

```text
SUPABASE_URL=https://YOUR_EXISTING_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_EXISTING_PUBLISHABLE_KEY
HUB_ORIGIN=https://YOUR_ACTUAL_HUB_HOST
PORT=8787
```

Use your real values; these examples are not a working service. `HUB_ORIGIN` is
the exact frontend origin (scheme and hostname, no path or trailing slash). The
current repository CNAME is `tempoary.robco.pizzamonster.org`; verify the origin
actually serving your site before configuring it. Only that one origin is allowed.

Run `npm start` inside `proxy/` (or `node server.cjs`). The server intentionally
listens on `127.0.0.1`. Put an HTTPS reverse proxy on the same host in front of it;
do not expose its unencrypted listener to the internet. Container platforms must
place the TLS reverse proxy in the same network namespace, or adapt the bind
configuration deliberately within a private network. No service-role key, JWT
signing secret or database password is required by this backend.

Configure the hosting/reverse-proxy layer to:

- Terminate HTTPS and forward `Origin`, `Authorization`, `Content-Type` and
  `X-RobCo-Session`. Preserve OPTIONS requests and backend CORS headers.
- Disable access/body/response logging, analytics and caching on these endpoints.
  Set a small request-body limit (4 KB), timeouts and suitable abuse/rate limits.
- Apply outbound firewall rules that block internal networks and enforce the
  organization's approved destinations and network policies. Use the normal OS
  resolver. Do not add alternate resolvers, tunnels or blocked-site fallbacks.
- Keep the backend and Node runtime patched. Review hosting-provider logging and
  retention separately; the application cannot control provider infrastructure.

## 3. Configure GitHub Pages and enable access

Set `window.ROBCO_PROXY_URL` in `proxy-config.js` to the real HTTPS **origin** of
the deployed backend, with no path, credentials, query or fragment. Commit/deploy
that static configuration normally. Do not put server secrets in frontend files.

Sign in with an existing authenticated Overseer account. Open **PRIVATE TERMINAL
CONTROL**, verify the saved status, approve individual hostnames, then select
**ENABLE PRIVATE TERMINAL**. Disabling asks for confirmation. Success/error messages
report the database write, and reopening reads the saved state again. Deployment,
refresh and other devices all use the same Supabase record.

Users then sign in normally and open Private Terminal from Home. The screen shows
connection/loading/error states and the approved hosts. It offers URL entry,
Back, Forward, Reload and Return to Website Hub. Unconfigured/offline states are
explicit. A missing or failed configuration is treated as unavailable.

## Security and privacy boundaries

- Every browsing request needs either the existing Overseer JWT or an unexpired
  user capability validated by Supabase. Origin/CORS is an additional browser
  control, not authorization. Copying the backend URL does not grant access.
- The backend rereads enabled state and the exact approved-host list for each
  request, just before fetching, and again before returning content. No positive
  authorization or enable-state cache exists. Disabling or removing a host rejects
  subsequent requests and discards a response if the change is observed in flight.
  A request already sent upstream cannot be recalled. The open UI checks availability
  every ten seconds and clears content when it observes a disable or outage.
- User capabilities also respect the Hub maintenance flag. Overseer membership is
  checked on each request. Access-code expiry/usage is checked at login; subsequent
  code deletion does not revoke a previously issued capability before its one-hour
  expiry. The global switch can immediately prevent all proxy use.
- HTTPS only, standard port only, exact host approval (no wildcard/subdomain
  inheritance), no URL credentials, IP literals, fragments, redirects or CONNECT.
- Public IPv4 addresses only. All returned IPv4 answers are checked before one is
  pinned to the HTTPS connection with the original TLS hostname verification.
  Localhost, loopback, private, link-local, shared, multicast, documentation and
  reserved ranges are rejected. IPv6/transition/mapped addresses are unsupported;
  dual-stack hosts can use a validated IPv4 answer. DNS pinning prevents a second
  resolution from redirecting a fetch into an internal network.
- Only successful HTML/plain-text responses up to 256 KB are accepted. DNS,
  authentication and fetch deadlines, request-size and concurrency caps limit
  resource use. Redirects and compressed/binary interactive sites are not supported.
- No browser cookies, bearer tokens or credentials are forwarded to destinations.
  Content is escaped and shown as **inert source text** in a sandboxed iframe with
  `default-src 'none'`. Links, forms, scripts, images and trackers do not execute.
  This preserves the original safe preview model; it is not a full web browser.
- Up to 30 visited addresses exist only in memory for Back/Forward. Leaving the
  screen, backgrounding, logging out or reloading clears navigation/content.
  The app does not persist or log browsing history or page contents. Database
  configuration and hashed expiring capabilities are the only new stored data.

This reduces exposure to page scripts and third-party trackers. It does **not**
provide anonymity. The destination sees the backend's IP and requested path;
network operators, DNS resolvers, Supabase and hosting providers may see service
connections or retain infrastructure logs. Use only where network policy permits;
the feature must not be deployed to circumvent school/workplace/parental controls.

## Validation and production handoff

Local automated tests cover games/touch, proxy UI errors and navigation, mocked
backend requests, private-address protection, database grants, RLS and repeated
enable/disable. They do not prove a real hosting provider, live database or a
particular approved destination is configured correctly.

After deployment, verify with two independent Hub sessions: enable and open an
approved HTTPS page; disable from the Overseer panel; confirm both the direct API
and user screen reject requests; refresh/re-login and confirm disabled persists;
re-enable and confirm access returns. Verify that anonymous and non-Overseer
requests cannot call either settings mutation RPC. Test a disallowed hostname and
a hostname resolving to an internal address. Check logs contain no URLs/tokens or
page contents. Leave the switch disabled if any check fails.

For regression commands and their scope see `tests/README.md`.
