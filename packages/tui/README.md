# @mitome/tui

## Manual smoke checklist

Run an Agent in a real interactive terminal with `mitome --use <definition>` (or `mitome` for the default definition) and verify:

- Enter inserts a newline, bracketed paste preserves multiline text, and Alt-Enter sends it.
- Model text appears before the Turn finishes, and tool start/completion activity is visible.
- A second prompt continues the same Session after the first response.
- Esc during streaming returns to the prompt with “Turn interrupted”; sending another prompt then succeeds without the interrupted prompt appearing in model history.
- Ctrl-O opens the Transcript picker with time and preview rows.
- Enter resumes the selected Transcript into a new Session that sees its prior context.
- Ctrl-N starts a fresh Session while the previous Transcript remains listed.
- Ctrl-C exits cleanly and restores the terminal.
