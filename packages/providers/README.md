# @mitome/providers

Official Model providers for Mitome Agent Definitions.

```sh
npm install @mitome/sdk @mitome/providers
```

Import a provider from `@mitome/providers/openai`, `@mitome/providers/openai-compatible`, or `@mitome/providers/openai-codex`.

## OpenAI Responses transport

OpenAI uses Responses WebSocket mode by default on Bun and Node, reusing one connection across
Tool continuations. Other runtimes use HTTP/SSE because standards-only WebSocket constructors
cannot attach the required authorization header. Pass `{ transport: "http" }` for HTTP-only
proxies; a WebSocket `baseUrl` must accept an authenticated upgrade at `/responses`. WebSocket
failures do not replay the request over HTTP.
