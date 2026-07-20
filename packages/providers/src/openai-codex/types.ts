type Input = () => Promise<string | undefined>;
type Output = (text: string) => void;

export type OAuthCredential = {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
};

export interface LoginOptions {
  readonly configDirectory: string;
  readonly callbackPort?: number;
  readonly tokenUrl?: string;
  readonly openBrowser?: false | ((url: string) => void | Promise<void>);
  readonly input: Input;
  readonly output: Output;
}

export interface LogoutOptions {
  readonly configDirectory: string;
  readonly output?: Output;
}

export interface CodexOptions {
  /** Unofficial ChatGPT backend root; injectable for controlled transport fixtures. */
  readonly baseUrl?: string;
  /** Credential directory; defaults to XDG_CONFIG_HOME, Windows APPDATA, or Unix HOME. */
  readonly configDirectory?: string;
  /** OAuth token endpoint; injectable for controlled refresh fixtures. */
  readonly tokenUrl?: string;
}
