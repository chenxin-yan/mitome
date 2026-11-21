# Session history as a tree: where the kernel is, and what pi does

Research for the saved-history design (issue #170). It records what was measured on the stack at `feat/native-session` and what pi 1.6.0 does, as inputs to the decisions; it selects nothing.

## The kernel today (measured)

History is one in-memory list in `packages/mitome/src/session/session.ts` (`let history: ReadonlyArray<Prompt.Message> = []`). A Turn that succeeds appends its staged Messages. Nothing carries an identity or a parent.

`SessionStore` has one method, `save(history)`, which receives the whole list before each publication. There is no way to read it back: `Session.make` always starts empty. A script with a store that writes its argument to a JSON file printed:

```
after Turn 1: saves = 1 | file holds [ "first" ]
after Turn 2: saves = 2 | file holds [ "first", "second" ]
failed Turn 3: saves = 2 | file holds [ "first", "second" ] | Turn failed
new Session, same store: history = []
after its first Turn: file holds [ "after restart" ]
```

So a second Session on the same store starts empty and its first Turn overwrites what the first one saved. The store is reachable only through `Session.make({ persistence, limits })`; `Session.make(agent)` passes `persistence: "none"` (`agent/run.ts`), so an Agent, a Configuration and the CLI cannot use one.

What does carry over to a tree: a Turn is the unit of commit (staged together, published once); the save happens before publication; an unknown save outcome fences the Session. Only four lines read or write the list (the Model Context, the value saved, the assignment, the `history` read).

## pi 1.6.0 (installed docs and `dist/core/session-manager.js`)

- **One JSONL file per session**, append-only. Every entry has `id`, `parentId` and `timestamp`; the entries form a tree (`docs/session-format.md`).
- **The current position is a leaf held in memory.** `branch(id)` only assigns `this.leafId` (`session-manager.js:1182-1186`); the next append takes it as its parent. On load the leaf is the last entry in the file (`:746-751`), so a position reached by navigating without appending is not kept.
- **Navigation.** `/tree` moves within the file; selecting a user message puts its text back in the editor so that submitting it makes a branch. `/fork` and `/clone` write a new file that names its `parentSession` (`docs/sessions.md`).
- **The Model's context is a projection**: walk from the leaf to the root, apply the latest compaction on that path, then apply context edits (`docs/session-format.md`, "Context Building").
- **Many entry kinds in one stream**: message, compaction, branch summary, context edit, label, session name, model change, thinking level, usage, and two kinds for extensions (state that the Model never sees, and messages it does).
- **Each finalized message is appended on its own**, including an assistant message that ended in an error or was aborted; a Turn is not the unit (`docs/research/pi-reference-architecture.md`, "what is committed").
- **Writes are `appendFileSync` with no flush protocol** and memory is updated before the write (`session-manager.js:807-829`). Nothing stops two processes appending to one file.

## Durability: eve and Pi Durable

"Durable" is used for three different promises, each stronger than the last:

1. **Saved history.** A finished conversation can be opened again. A Turn that was running when the process died is gone.
2. **Durable execution.** A Turn that was running continues after a restart: finished Steps are not repeated, and an interrupted one is handled by a stated rule.
3. **Acknowledged writes.** What the store confirmed survives power loss, not only a process crash.

- **eve** runs its loop as a workflow on Vercel's Workflow SDK. "Completed steps never re-run; eve replays the recorded result. A step interrupted mid-execution re-runs, so make non-idempotent side effects like charges or emails idempotent, or gate them with approval" (`docs/concepts/execution-model-and-durability.mdx:65` in `.agent-sources/eve`).
- **Pi Durable** (`@earendil-works/pi-durable`, a separate package from the coding agent; https://earendil.com/posts/pi-durable/ and `packages/durable/README.md`, read 2026-11-24):
  - "Conversations, model turns, tool calls, and your own state are committed to storage before anything is shown." The unit is an atomic commit of entries, documents and tasks, written as the run proceeds, not a whole turn.
  - "Each call runs as its own durable task. Its intent is committed before `execute()` runs." After a crash, "the tool reruns on reopen only when it is declared `replay: "safe"`; otherwise the model gets an `interrupted` error result with the output committed so far."
  - A model request that was cut off is retried, and "its partial answer is kept as an aborted entry".
  - Branching is a fork into a new conversation: "A fork sees its parent's entries up to `entryId` and continues independently", without copying them. Navigating inside one conversation's tree is not described.
  - A custom backend implements `commit(batches, receive, context)`, which "resolves with `{ stored, refused? }`; it rejects for an unknown outcome". This is the same three-way answer as Mitome's saved, `not-written` and `unknown`.
  - `requestId` makes a submission exactly-once. SQLite "commits survive process crashes; the newest may be lost on power or host failure." The package calls itself experimental.

Both record progress per Step, not per Turn. Neither keeps a conversation all-or-nothing across a whole Turn, which Mitome's kernel does today: a Turn that fails or is interrupted publishes nothing, so the next Turn's Model Context holds no trace of the Tool calls that already ran.

## What the comparison suggests

|                       | pi                                                  | Mitome's kernel can do better because                                                 |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Unit stored           | One message                                         | A Turn already commits as a whole, so a stored node can always be a complete exchange |
| Current position      | In memory; last entry on load                       | It can be a stored fact, checked when a Turn commits                                  |
| Two writers           | Not detected                                        | A commit can name the position it expects, and be refused when that moved             |
| Write failure         | Not modelled                                        | "Not written" and "unknown" already exist, with the fence                             |
| Storage               | A file path                                         | A port, so a file, SQLite or a service are adapters                                   |
| What is in the stream | Conversation, UI state and extension state together | The kernel can hold conversation only and leave the rest to whoever owns it           |

## Open decisions

1. Is a node one Turn, one Step or one Message? This is the same question as what a Turn that stops half-way leaves behind.
2. Is the current position stored, or supplied by the Host when it opens a Session?
3. Who supplies the store: a `Session.make` option, a service the Configuration's layer provides, or the Host?
4. What is the smallest store contract (append under a parent, read the path to a position, list for navigation)?
5. How much ships in the MVP: the kernel shape only, or also one file adapter and `resume` in the CLI?
6. Later, on the same tree: Compaction and Checkpoints, Branch summaries, extension state.
