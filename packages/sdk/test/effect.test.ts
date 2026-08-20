import { expect, test } from "vitest";

test("keeps the complete Effect facade export contract", async () => {
  expect(
    // String() defeats vite static analysis so the import resolves the built
    // dist via package self-reference, not src (turbo builds before testing).
    Object.keys(await import(String("@mitome/sdk/effect"))).sort(),
    "Core surface changed — widen deliberately and update this snapshot.",
  ).toMatchInlineSnapshot(`
    [
      "AgentDefinitionError",
      "ApprovalResolutionError",
      "CredentialDescriptorSchema",
      "SessionBusyError",
      "SessionReleasedError",
      "TranscriptMessageSchema",
      "TranscriptSchema",
      "TranscriptSchemaVersion",
      "TurnError",
      "compileAgentDefinition",
      "configDirectory",
      "configDirectoryMessage",
      "createSession",
      "credentialDescriptor",
      "defineAgent",
      "defineExtension",
      "makeProvider",
      "makeTranscript",
      "promptFromTranscript",
    ]
  `);
});
