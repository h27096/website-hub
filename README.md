# RobCo Website Hub

The current version is defined in `version-history-data.js`. This release combines
expanded games, Private Terminal and persistent Overseer proxy controls.

The static Hub remains on GitHub Pages. Private Terminal extends the original
approved-destination source-text preview backend; it requires separate HTTPS
hosting and the included Supabase migrations. It is not deployed or configured by
default. See [Private Terminal setup](PRIVATE_TERMINAL_SETUP.md) for exact steps,
authorization, security boundaries and the production handoff checklist.

Games: Codebreaker, Signal Match, Memory Banks, Circuit Grid and Reactor Timing.
All offer restart/reset and work with keyboard, mouse or touch.

See [release history](version-history-data.js), [development instructions](AGENTS.md)
and [tests](tests/README.md). Earlier Employee Document and Radio setup instructions
remain available in their existing files. No separate next release is announced.
