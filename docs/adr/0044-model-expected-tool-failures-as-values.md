# Model expected Tool failures as values

A Promise-first Tool may declare `failureSchema` alongside `outputSchema`. Its handler then returns `ok(value)` or `fail(error)`. Both branches are validated against their declared schemas; the success and failure types come from those schemas, with the handler positions excluded from inference. The const-generic helpers preserve discriminants and are the sanctioned authoring form.

A validated `fail(error)` becomes a failed Tool result whose error value is visible to the Model. This channel is for expected outcomes the Agent can react to, such as a missing record or a rejected operation. A thrown error, rejected Promise, or invalid result remains a defect and keeps the existing opaque `SDK tool handler failed` mapping, so implementation details and secrets are not exposed accidentally.

The channel is opt-in. Without `failureSchema`, handlers return their success value directly. `outputSchema` is also optional; omitted output is inferred from the handler and passed through without validation.
