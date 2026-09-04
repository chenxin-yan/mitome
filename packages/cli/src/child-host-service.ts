import { Context, Effect } from "effect";
import type { CredentialDescriptor } from "@mitome/core";
import type { CliError, ExitCode } from "./support.js";

export interface ProviderAuthentication {
  readonly id: string;
  readonly credential: CredentialDescriptor;
}

export interface ExtensionListItem {
  readonly name: string;
  readonly version: string;
  readonly direct: boolean;
  readonly dependents: ReadonlyArray<string>;
}

export interface ExtensionListResult {
  readonly exitCode: ExitCode;
  readonly extensions: ReadonlyArray<ExtensionListItem>;
}

export class ChildHost extends Context.Service<
  ChildHost,
  {
    readonly runHost: (
      path: string,
      message: string | undefined,
      mode: "auto" | "print",
    ) => Effect.Effect<ExitCode, CliError>;
    readonly install: (path: string) => Effect.Effect<ExitCode, CliError>;
    readonly removeDependency: (
      path: string,
      packageName: string,
    ) => Effect.Effect<ExitCode, CliError>;
    readonly listExports: (
      packageName: string,
      directory: string,
    ) => Effect.Effect<ReadonlyArray<string>, CliError>;
    readonly inspectExtensions: (path: string) => Effect.Effect<ExtensionListResult, CliError>;
    readonly inspectProviderAuthentication: (
      path: string,
    ) => Effect.Effect<ReadonlyArray<ProviderAuthentication>, CliError>;
    readonly runOAuthAuth: (
      path: string,
      providerId: string,
      command: "login" | "logout",
    ) => Effect.Effect<void, CliError>;
  }
>()("@mitome/cli/ChildHost") {}
