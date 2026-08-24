# @mitome/tui

## Manual smoke checklist

Run an Agent in a real interactive terminal with `mitome run <definition>` and verify:

- Enter inserts a newline, bracketed paste preserves multiline text, and Alt-Enter sends it.
- Model text appears before the Turn finishes, and tool start/completion activity is visible.
- A second prompt continues the same conversation after the first response.
- Esc during streaming returns to the prompt with “Turn interrupted”; sending another prompt then succeeds without the interrupted prompt appearing in model history.
- Ctrl-C exits cleanly and restores the terminal.
