---
"@mitome/core": patch
---

`fileTranscripts` no longer leaves a `.transcript-*` temporary file behind when a Transcript save fails while writing (for example on a full disk). Both disk stores now share one atomic-replace step that removes the temporary file on any failure.
