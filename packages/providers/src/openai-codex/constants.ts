import { type OAuthConfig } from "../shared/oauth.js";

export const provider = "openai-codex";

export const oauth: OAuthConfig = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  callbackPort: 1455,
  callbackPath: "/auth/callback",
  authorizeParams: { originator: "mitome" },
};
