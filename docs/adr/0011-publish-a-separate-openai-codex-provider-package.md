---
status: amended by ADR-0018, ADR-0031
---

# Publish a separate @mitome/openai-codex provider package

ChatGPT subscription access ships as `@mitome/openai-codex`, separate from `@mitome/openai`, because Codex is a different transport dialect and auth lifecycle — not the API-key OpenAI endpoint with another base URL — and API-key users must not install OAuth or credential-store code. The MVP implements browser PKCE login with a manual paste-the-redirect-URL fallback (device-code login is deferred until a user actually hits that gap) and an SSE-only Codex Responses transport with no WebSocket support. The package rides OpenAI's unofficial `chatgpt.com/backend-api` and is documented as best-effort compatibility: OpenAI tolerates third-party harnesses today but publishes no API contract, and the backend churns. Embedding the official Codex app-server was rejected because it owns login, model listing, threads, and the agent loop; it would replace Mitome's runtime rather than act as a model provider.
