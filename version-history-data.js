/* Canonical project release history. Edit in the repository; see AGENTS.md. */
const ROBCO_VERSION_HISTORY = {
  releases: [
    { version: 'v1.2', changes: [
      'GAMES + PRIVATE TERMINAL: one combined release.',
      'Added Memory Banks, Circuit Grid and Reactor Timing; preserved Codebreaker and Signal Match with restart controls and game cleanup.',
      'Recovered and improved the approved-destination Private Terminal, with Home Screen access, connection/error states and Back, Forward and Reload for isolated source text previews.',
      'Added persistent Supabase Overseer enable/disable and approved-host controls, with database authorization and backend enforcement.',
      'Added short-lived user sessions, HTTPS destination checks, pinned public IPv4 connections, request limits and private-network protection.',
      'Separate backend hosting, Supabase migrations and backend URL configuration are required; the release does not include a deployed proxy service.'
    ] },
    { version: 'v1.1', changes: [
      'Improved the Radio/Music system.',
      'Added functionality for Overseers to add music.',
      'Added a shared Version History and upcoming roadmap for all terminals.'
    ] },
    { version: 'v1.0', changes: ['Added privacy proxy code.', 'Proxy is not working yet.'] },
    { version: 'v0.5', changes: ['Added Music / Radio.'] },
    { version: 'v0.4', changes: ['Added Mini-Games.', 'Currently includes two games.'] },
    { version: 'v0.3', changes: ['File / Document area became functional.'] },
    { version: 'v0.2', changes: ['Improved Employee access.'] },
    { version: 'v0.1', changes: [
      'Added User Dashboard.',
      'Started Holotape Reader.',
      'Added Employee section.',
      'Prepared Website Hub for initial release.',
      'Added safety functions.'
    ] }
  ],
  roadmap: []
};
