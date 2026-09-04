---
status: amended by ADR-0047
---

# Compose Hosts explicitly in the composition root

The selected TypeScript module default-exports `defineMitome({ agent, hosts })`. `defineMitome` and the public SDK `Host` interface compose one host-agnostic Agent Definition with its consumers; a Host currently has the single mode `interactive`, receives the Agent and staged prompt, and at most one may be declared. `tui()` returns such a Host (an options parameter is future work). Installing `@mitome/tui` alone has no activation semantics.

This replaces ADR-0019's presence activation. Presence was implicit, could activate through a hoisted dependency, and left no typed configuration surface. Explicit Host values remain configuration rather than convention and give future gateway and service consumers the same composition root; service mode and its dispatch semantics are deliberately deferred until that work exists.

The one-shot Host remains the default when no interactive Host is declared. `-p`/`--print` and non-TTY stdout force one-shot behavior, while an unsupported terminal reports the fallback before running one-shot. The Agent Definition itself remains Host-agnostic: Hosts live beside it in the Mitome Definition rather than in `agent.extensions`.
