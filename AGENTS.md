# Website Hub development instructions

## Required version and update-log maintenance

Whenever work adds or removes a feature, significantly changes a feature,
completes a roadmap item, creates a release, or makes another user-visible change
worth documenting, you MUST review and update the version/update log as part of
the same change. This applies to Work sessions and all AI coding agents.

1. Inspect `version-history-data.js` before choosing a version. It is the single
   canonical source for released history and upcoming roadmap items. The current
   version is `releases[0].version`; every visible version is derived from it.
2. Decide whether the work belongs under the current release or warrants a new
   release. Meaningful feature releases advance one step: v0.9 -> v1.0,
   v1.1 -> v1.2, v1.9 -> v2.0, then v2.1. The minor digit is 0 through 9;
   never use v1.10 as the successor of v1.9.
3. For a genuinely major overhaul or milestone, advance to the next whole number
   (for example v2.4 -> v3.0). Do not fabricate skipped releases.
4. Small fixes, typos, CSS adjustments, and maintenance may be recorded under the
   current release when appropriate. If shipping a separate bug-fix release,
   advance one step (for example v2.3 -> v2.4) and describe it as "Bug fixes."
   Do not automatically bump for every tiny edit.
5. Add a concise, accurate description. Prepend new releases, so the displayed
   current version updates automatically. Never hard-code project version labels
   in HTML, role-specific panels, or other unrelated files.
6. Review the roadmap when planned work is completed, added, removed, or changed.
   Only move completed work into released history after it is actually implemented
   and verified. Never claim an upcoming feature is already complete.
7. Keep historical entries intact. Append to the current release when appropriate;
   never rewrite old history to make it look cleaner, renumber releases, invent
   dates, or erase historical limitations. Preserve the legacy development notes
   in `CHANGELOG.md`; they are not a second current-version source.
8. Include version/history/roadmap changes in the same commit as the implementation
   whenever practical. In the final report state the version decision and checks.

The initial history system intentionally stays on the owner's requested current
release, with future roadmap entries still pending. Future releases follow the
rules above; do not freeze the version permanently.

## Architecture and validation

Keep the existing Hub and its features intact. All roles must use the same
read-only Version History dialog, accessible without Supabase or an Overseer
session. Do not add browser-side release editing controls or store official
versions in local storage or the database.

Run `node tests/version-history.cjs` with Playwright available (optionally
`BROWSER_CHANNEL=msedge`), plus relevant existing regression suites. Check all
three roles, history/roadmap separation, keyboard close/focus restoration, public
access without backend requests, and desktop/mobile overflow. Tests must not
write to live Supabase data.
