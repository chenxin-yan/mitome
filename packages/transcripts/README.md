# @mitome/transcripts

Keeps a Configuration's conversations in files, so that they outlive the process and `mitome --continue` can pick one up again. Without it a Configuration keeps history in memory only.

```ts
import { Mitome } from "@mitome/core";
import { jsonlTranscripts } from "@mitome/transcripts/jsonl";

export default Mitome.make({ agent, providers, model, provide: jsonlTranscripts() });
```

`jsonlTranscripts({ directory? })` is a Layer that provides `Transcripts` from `@mitome/core` and requires nothing. Each conversation is one append-only JSONL file, `<id>.jsonl`, in `transcripts` under the state directory (`$MITOME_HOME`, else `$XDG_STATE_HOME/mitome`, by default `~/.local/state/mitome`; `%LOCALAPPDATA%\mitome` on Windows), or in `directory`. Building the Layer fails when neither can be resolved. On POSIX systems the directory, and any missing directory above it, is created `0700` and each file `0600`: conversations hold file contents and command output. On Windows those modes set no owner-only ACL, so choose a state directory or `directory` whose ACL already admits only you.

A file holds a header (`version`, `id`, `scope`, creation time), then one line per Entry, its Messages encoded with Effect's `Prompt.Message` codec, and one line per move of the position. An Entry line also moves the position to that Entry, so the position is the one the last line names. Each append takes the conversation's lock file (`<id>.lock`), refuses when another writer moved the position, and syncs before it answers. A last line without its newline, left by a crash, is ignored and overwritten. A process killed while it holds a lock leaves `<id>.lock` behind and later writes to that conversation fail, naming that file: delete it once no other process is writing there. The conversation holds plain data, JSON as Effect's `Schema.Json` defines it, and the store applies the kernel's rule, `isPlainData` from `@mitome/core`, to each Entry: one that is not plain data is not written, and that includes a record field whose value is `undefined`, which a Session has already dropped. JSON keeps all of plain data but the sign of negative zero, so an Entry appended directly is read back with negative zero as zero. Files of another version, or with a malformed line, fail to open with `TranscriptError`. See [Agents and Configurations](https://mitome.sh/docs/agents#keep-history).
