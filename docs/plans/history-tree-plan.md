# Plan: history as a tree of Steps, with a store

Status: approved by the owner on 2026-11-24 and recorded as [ADR-0066](../adr/0066-keep-history-as-a-tree-of-steps.md). Research: `docs/research/session-history-tree.md`.

## Decided (2026-11-24)

- **A node is one Step.** Each completed Step commits what is staged; one with nothing to commit leaves no Entry. A Turn that stops half-way keeps what its finished Steps committed. This reverses the one-commit-per-Turn boundary of ADR-0057 and ADR-0036.
- **The position is stored** and checked on every commit, so a restart continues where it was and two writers are caught.
- **The store is a service** that a Configuration's `provide` can supply.
- **MVP scope:** the kernel shape, one file adapter and `mitome --continue`. Durable execution (continuing a Turn after a crash, Tool replay rules), Compaction, Branch summaries and navigation in the terminal are later.
- **Commands were designed after this plan** ([ADR-0068](../adr/0068-let-an-extension-name-its-commands.md)); navigating the History tree from the terminal is still later.

## Words

- **Entry**: the Messages committed together, with an id and the id of its parent. Normally one Step: the Model's response and the results of the Tool calls it asked for, plus any Messages the program staged before it (such as the prompt).
- **Transcript**, **History tree**, **Branch**, **Execution position**: as in `CONTEXT.md`. The position is the Entry the next commit goes under.

## Kernel (`@mitome/core`, `session/`)

What changes in a Turn:

1. `turn.stage(...)` still collects Messages.
2. When a controlled Step completes, the kernel commits what is staged as one Entry under the position: store it (when there is a store), then publish it (history grows, the position moves).
3. When the program succeeds, Messages still staged commit as a last Entry.
4. When the program fails or is interrupted, Messages still staged are dropped. Entries already committed stay.

Unchanged: one Turn at a time, the Turn's Scope and fiber ordering, Steps, the gate, limits. A Step's commit happens while the Turn Scope is still open. Only the last commit, of what is still staged when the program succeeds, waits for the program's child fibers and the Turn Scope, as the single commit did; a Turn whose cleanup fails keeps its Steps' Entries and publishes nothing more. The fence now applies to each commit: a store that answers "not written" fails the Step and the Turn with nothing lost; an unknown outcome fences the Session.

A Turn's record says how it ended and how many Entries it committed, in place of today's `committed | failed | uncertain`.

Proposed surface (names to confirm):

```ts
interface Entry {
  readonly id: string;
  readonly parent: string | undefined;
  readonly messages: ReadonlyArray<Prompt.Message>;
}

/** One conversation's storage. An adapter implements this. */
interface Transcript {
  /** Names this conversation, so that a Host can show it and open it again. */
  readonly id: string;
  /** The stored position and the Entries from the root to it. */
  readonly open: Effect<
    { readonly position: string | undefined; readonly branch: ReadonlyArray<Entry> },
    TranscriptError
  >;
  /** Stores `entry` under `expected` and moves the position to it; refused when the stored position is not `expected`. */
  readonly append: (entry: Entry, expected: string | undefined) => Effect<void, SessionSaveError>;
  /** Moves the position to an existing Entry and returns its Branch. */
  readonly select: (
    position: string | undefined,
    expected: string | undefined,
  ) => Effect<ReadonlyArray<Entry>, SessionSaveError | TranscriptError>;
  /** Every Entry's id and parent, for a navigation view. */
  readonly tree: Effect<
    ReadonlyArray<{ readonly id: string; readonly parent: string | undefined }>,
    TranscriptError
  >;
}

Session.make({ transcript, limits }); // `transcript: "none"` keeps history in memory, still as a tree
session.history; // the Messages of the current Branch
session.position; // the current Entry id
session.moveTo(entryId); // only while no Turn runs; the next Turn branches from there
```

`SessionStore`, the `persistence` option and "save the whole list" go away.

## Agent and Configuration (`agent/`)

A service, absent by default, that hands out Transcripts:

```ts
/** Where conversations are kept. A Configuration provides it; without it nothing is saved. */
const Transcripts: Context.Reference<TranscriptsService | undefined>; // key "mitome/Transcripts"

interface TranscriptsService {
  readonly create: (scope: string) => Effect<Transcript, TranscriptError>;
  readonly latest: (scope: string) => Effect<Transcript | undefined, TranscriptError>;
  readonly open: (id: string) => Effect<Transcript | undefined, TranscriptError>;
}
```

`scope` is an opaque label the Host chooses; the CLI passes the working directory, so `--continue` means "the conversation most recently written here". A Transcript has an `id`, which a Session shows as `session.transcript`, so a Host can display it and a person can name that conversation later (`--continue=<id>`). A Host asks for a new conversation, the latest one under a label, or one by id when it starts a Session through the Configuration.

## File adapter (a new package)

- One JSONL file per Transcript under `<stateDirectory>/transcripts/`, append-only: a header line, then Entry lines and position lines. The last position wins.
- Messages are written with Effect's own `Prompt.Message` codec. A version is in the header; an unknown version fails to open.
- An append takes the file's lock, checks the stored position is the expected one, writes, and syncs before it answers. An incomplete last line from a crash is ignored on open, and the next write truncates it, under the lock, before it appends, so a new record never joins a partial one.
- It binds its own file system, as `@mitome/providers` does (ADR-0065).
- In a Configuration: `provide: jsonlTranscripts()`. Keeping history is opt-in: `mitome init` does not write that line, so a new Configuration keeps history in memory only (owner, 2026-11-24).

## CLI

- `mitome` and `mitome run` start a new conversation and save as they go, when the Configuration has a store.
- `mitome --continue` and `mitome run --continue` open the conversation most recently written under this directory, at its stored position; `--continue=<id>` opens one by id.
- With no store, `--continue` fails with a message that says the Configuration keeps no history.
- An interrupted Turn reports how many Entries it kept.

## Delivery

| Where          | What                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| #215 records   | An ADR for this decision (amending ADR-0036 and ADR-0057), the glossary's **Entry**, `mvp-plan.md`, the research note |
| #217 kernel    | Step commits, `Entry`, `Transcript`, the position, `moveTo`, the Turn record                                          |
| #218 agent     | The `Transcripts` service; a Session started from a Configuration uses it                                             |
| #221, #222 CLI | `--continue`; what the terminal says about kept Entries                                                               |
| New PR on top  | The file adapter package and docs for turning it on                                                                   |

## Confirmed (2026-11-24)

1. A Turn that fails before its first Step completes leaves nothing; the terminal can put the prompt back in the editor.
2. `--continue` is per working directory, and a person can also name a conversation by its id.
3. The file adapter is the package `@mitome/transcripts`, exporting `jsonlTranscripts()`.
4. The names `Entry`, `Transcript`, `Transcripts` and `moveTo`.
