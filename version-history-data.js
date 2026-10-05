/* Canonical project release history. Edit in the repository; see AGENTS.md. */
const ROBCO_VERSION_HISTORY = {
  releases: [
    { version: 'v1.3', changes: [
      'Fixed Training readiness preflight diagnostics and added domain-independent, cookie-free CORS plus a read-only deployment checker; separate Edge Function deployment is still required.',
      'Stabilized Personnel File diagnostics: detect missing training-auth deployment, report sanitized Auth/RPC/profile failures, and preserve successful account creation when later steps fail.',
      'Moved Training Center access into the signed-in User Dashboard after normal Hub authentication.',
      'Added RobCo Training Center with cloud Personnel Files, secure one-time password recovery, and Overseer personnel management.',
      'Added subject/unit study sets, Featured Training, a shared question bank, manual editing, and previewed bulk/CSV/TSV import.',
      'Added Flashcards, Quiz, Reactor Rush, Terminal Hack, Vault Defense, and Caps Run with keyboard and touch controls.',
      'Added persistent Training XP, cosmetic ranks, study progress, and study-set/game leaderboards with server-calculated scores.',
      'Requires the additive Training Center migration and training-auth Edge Function deployment; multiplayer remains planned.'
    ] },
    { version: 'v1.2', changes: [
      'Added three new Mini-Games: Memory Banks, Circuit Grid and Reactor Timing.',
      'Canceled and removed the unreleased Private Terminal feature and abandoned the experimental proxy code.'
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
  roadmap: [
    { version: 'v1.4', title: 'RobCo Live Training / Multiplayer — shared rooms, hosts, players, and synchronized training sessions.' }
  ]
};
