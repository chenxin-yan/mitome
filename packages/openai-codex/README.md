# @mitome/openai-codex

`@mitome/openai-codex` is best-effort compatibility with ChatGPT's unofficial `chatgpt.com/backend-api`. OpenAI publishes no stable contract for this backend, so it can change without notice.

The provider uses browser PKCE credentials and the SSE-only Codex Responses transport. It intentionally has no device-code or WebSocket path.

`ModelId` is a hand-maintained known-model hint union plus arbitrary strings. Update the hints when releasing the package; unknown, future, private, and fine-tuned IDs pass through unchanged and the backend remains the entitlement authority.
