# Codex transport and auth design

ChatGPT subscription access is a distinct transport dialect and auth lifecycle, not the API-key OpenAI endpoint with another base URL. The MVP implements browser PKCE login with a manual paste-the-redirect-URL fallback; device-code login is deferred until a user hits that gap. Its Codex Responses transport is SSE-only, with no WebSocket support.

The adapter uses OpenAI's unofficial `chatgpt.com/backend-api` and offers best-effort compatibility: OpenAI tolerates third-party harnesses today but publishes no API contract, and the backend churns. Embedding the official Codex app-server was rejected because it owns login, model listing, threads, and the Agent loop; it would replace Mitome's runtime rather than act as a model Provider.
