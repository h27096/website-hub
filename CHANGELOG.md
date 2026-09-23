# Release history

## v1.1 — Better Music on Radio

### Persistent Overseer music management

- Added an Overseer-only music manager with validated uploads, progress, metadata
  editing, song listing, and recoverable deletion of both file and record.
- Added the `robco-radio` private Storage bucket and `radio_tracks` database
  migration, with authorized management RPCs, table RLS, and guarded Storage
  policies. **Manual setup is required:** see [Supabase setup](SUPABASE_RADIO_SETUP.md).
- Radio now retrieves uploaded songs, groups them into station playlists, and
  plays stored audio with artist/title, timing, seeking, pause, volume, and mute.
  Original synthesized broadcasts remain available, including during outages.
- No audio files or privileged keys are committed. Browser integration tests and
  local PostgreSQL authorization tests cover persistence, upload validation,
  interrupted operations, listener access, and denied unauthorized mutations.

### Original local broadcasts

- Expanded the existing Web Audio radio with four original synthesized instrumentals: Lunch Break at Relay Nine, After Hours Assembly, Atrium Lights, and The Sleeping Reactor.
- Retained all three station names, frequencies, and original four-note signals as selectable programs.
- Added station playlists, automatic advance/repeat, track selection, previous/next, play/pause, stop, elapsed/total time, seeking, volume, and mute.
- Added a responsive green CRT receiver panel, labeled keyboard controls, selected-program indicators, and recoverable audio status messages.
- Playback still stops on navigation, logout, and return to Overseer. Pending audio startup cannot restart playback after leaving Radio.
- Local compositions are generated from note data in `radio.js`; they do not reproduce Fallout soundtrack recordings. Uploaded songs additionally use the existing Supabase project.
- Existing authentication, Supabase integration, dashboard, employee/Overseer logic, holotapes, files, and games are unchanged. No v1.2/v1.3 work is included.

### Validation

Run `node tests/radio.cjs` with Playwright available (`npm install --no-save playwright`, then `npx playwright install chromium`). Alternatively set `BROWSER_CHANNEL=msedge` to use installed Microsoft Edge.

The suite exercises real Web Audio playback and offline rendering; pause/resume, seeking, queue advance, previous/next, station changes, volume/mute, unsupported audio, startup failure, interrupted audio, pending-start cancellation, navigation cleanup, desktop/mobile layout, and existing guest, archive, game, employee and Overseer UI flows. Supabase and its CDN library are mocked: tests never write to live data and do not validate live credentials, database permissions, or backend availability.

## v1.0

Baseline before the Radio update. The existing repository content outside the Radio changes is preserved.
