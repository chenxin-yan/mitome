# @mitome/tui

## Tests

The `test` script enumerates test files explicitly: `.tsx` shell tests need the
`@opentui/solid/preload` flag, while `host.test.ts` must run _without_ it (it
asserts opentui never loads in non-TTY contexts). New test files must be added
to the `test` script in `package.json` or they will not run in CI.

## Manual smoke checklist

Run an Agent in a real interactive terminal with `mitome --use <definition>` (or `mitome` for the default definition) and verify:

- Enter inserts a newline, bracketed paste preserves multiline text, and Alt-Enter sends it.
- Model text appears before the Turn finishes, and tool start/completion activity is visible.
- A second prompt continues the same Session after the first response.
- Esc during streaming returns to the prompt with “Turn interrupted”; sending another prompt then succeeds without the interrupted prompt appearing in model history.
- Ctrl-O opens the Transcript picker with time and preview rows.
- With more Transcripts than fit on screen, moving the selection keeps the selected row visible.
- Enter resumes the selected Transcript into a new Session that sees its prior context.
- Ctrl-N starts a fresh Session while the previous Transcript remains listed.
- Ctrl-C exits cleanly and restores the terminal.
