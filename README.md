# RobCo Website Hub

The current version and upcoming roadmap are defined in `version-history-data.js`.
The static Hub runs on GitHub Pages with its existing Supabase integration.

Games: Codebreaker, Signal Match, Memory Banks, Circuit Grid and Reactor Timing.
All offer restart/reset and work with keyboard, mouse or touch.

See [release history](version-history-data.js), [development instructions](AGENTS.md)
and [tests](tests/README.md). Employee Document and Radio setup instructions
remain available in their existing files. v1.3 — RobCo Training Center is
implemented; see deployment and stabilization instructions below. v1.4 remains planned.

For installations that applied the abandoned experimental browsing migrations,
`supabase/migrations/20261004_remove_canceled_proxy.sql` removes only their dedicated
objects. It is optional for removing the visible feature, uses no CASCADE, and
must be applied separately by the database owner. No live database changes are
performed by this repository cleanup.
# RobCo Training Center deployment

For the v1.3 additive migration, Edge Function deployment, authentication,
recovery, score validation and acceptance checks, see
[SUPABASE_TRAINING_SETUP.md](SUPABASE_TRAINING_SETUP.md).
