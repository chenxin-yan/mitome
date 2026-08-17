# OpenTUI + Solid validation spike

Parent specification: [#64](https://github.com/chenxin-yan/mitome/issues/64). Validation ticket: [#69](https://github.com/chenxin-yan/mitome/issues/69).

## Decision

**NO-GO until manual validation is complete.** The automated evidence supports continuing with OpenTUI, but it cannot establish flicker-free rendering or terminal-specific focus/paste behavior. Do not start the production TUI shell in #73 until the manual-pending rows below pass. A failure returns the stack choice to #64 for reconsideration, as specified there.

## Pinned versions

The private spike workspace pins the coupled renderer pair exactly:

- `@opentui/core`: `0.5.3`
- `@opentui/solid`: `0.5.3`
- `solid-js`: `1.9.12` (the reconciler's exact peer version)

The Solid preload is required. The spike resolves `@opentui/solid/preload` beside its Definition fixture and passes that path to the same inherited-stdio Bun spawn primitive used by the CLI Child Host.

## Results

| Requirement                              | Status                                         | Evidence                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render through CLI child-host spawn path | VERIFIED                                       | `MITOME_OPENTUI_SPIKE_AUTOMATED=1 bun run --cwd spikes/opentui-solid smoke` under `script(1)` exited 0 and emitted a completed-stream result after loading the native renderer.                                                      |
| Accept input and exit cleanly            | PARTIAL / MANUAL-PENDING                       | `test/interaction.test.tsx` verifies bracketed multiline paste and renderer-driven exit; the PTY spawn verifies terminal setup/restoration and clean process exit. Integrated input through a real terminal emulator remains manual. |
| Multiline paste                          | VERIFIED HEADLESS / MANUAL-PENDING IN TERMINAL | The OpenTUI test renderer preserves `line one\nline two`; real emulator paste remains manual.                                                                                                                                        |
| Scrollable output                        | VERIFIED HEADLESS / MANUAL-PENDING IN TERMINAL | The test mounts overflowing history in `scrollbox`, focuses it, sends a down key, and records a scroll movement. Mouse/keyboard feel in a real emulator remains manual.                                                              |
| Focus movement                           | VERIFIED HEADLESS / MANUAL-PENDING IN TERMINAL | The test moves focus from `textarea` to `scrollbox` with Tab and asserts the focused renderable.                                                                                                                                     |
| Stream at model-output speed             | VERIFIED FUNCTIONALLY                          | Five chunks at 30 ms intervals compose into the expected rendered text and complete through the PTY child path.                                                                                                                      |
| No visible flicker                       | MANUAL-PENDING                                 | A headless run cannot assess visible flicker.                                                                                                                                                                                        |
| Supported terminal/OS matrix             | MANUAL-PENDING                                 | The repository does not yet define a supported terminal matrix. The automated environment below is the only tested row; real Linux and macOS terminal rows must be agreed and run. Windows remains out of scope per #64.             |

## Tested environment

| OS / terminal                                           | Architecture | Bun     | TERM           | Result                                                                                                           |
| ------------------------------------------------------- | ------------ | ------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| NixOS Linux 6.18.36 / util-linux `script(1)` 2.42.2 PTY | x86_64       | 1.3.14  | xterm-256color | Automated render, streaming, native load, terminal restoration, and exit passed; visual/input feel not assessed. |
| Real Linux terminal emulator(s)                         | pending      | pending | pending        | MANUAL-PENDING                                                                                                   |
| Real macOS terminal emulator(s)                         | pending      | pending | pending        | MANUAL-PENDING                                                                                                   |
| Compiled Bun executable Child Host                      | pending      | pending | pending        | MANUAL-PENDING — the smoke currently re-executes development Bun, not the compiled `mitome` executable.          |

## Commands and observed evidence

```sh
bun run --cwd spikes/opentui-solid test
# 2 pass, 0 fail; 9 expect() calls

MITOME_OPENTUI_SPIKE_AUTOMATED=1 bun run --cwd spikes/opentui-solid smoke
# Run under: script -qefc '<command>' <transcript>
# Exit 0
# MITOME_OPENTUI_SPIKE_RESULT {"input":"","focusMoves":0,"streamCompleted":true,"scrollMoves":0}
```

The PTY automation deliberately auto-exits after the stream completes; interactive behavior is covered separately by OpenTUI's headless renderer because `script(1)` supplies a PTY but not a terminal emulator capable of answering terminal capability probes.

## Manual smoke checklist

For every agreed supported terminal/OS row:

1. Run `bun run --cwd spikes/opentui-solid smoke` from an interactive terminal.
2. Confirm the output region renders with a scrollbar and streamed text appends without visible flicker.
3. Paste at least two lines into the input and confirm the newline is retained.
4. Press Tab and confirm focus moves to output; use Down to scroll.
5. Press `q` while output is focused and confirm the alternate screen is restored with exit code 0.
6. Record OS, architecture, terminal name/version, `TERM`, Bun version, result, and any artifact or visual defect in this report.
7. Before advancing the gate, repeat the Child Host smoke from the compiled `mitome` executable and record native preload loading after its `BUN_BE_BUN` re-exec.
