# @mitome/providers

Official Model providers for Mitome Agent Definitions.

```sh
npm install @mitome/sdk @mitome/providers
```

Import a provider from `@mitome/providers/openai`, `@mitome/providers/openai-compatible`, or `@mitome/providers/openai-codex`.

## OpenAI Responses transport

OpenAI uses HTTP/SSE by default. Opt into Responses WebSocket mode with
`{ transport: "websocket" }`. A custom `baseUrl` must accept a WebSocket upgrade at
`/responses` with authorization headers. WebSocket failures do not downgrade to SSE.
