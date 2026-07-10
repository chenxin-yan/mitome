import { expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Response, Toolkit } from "effect/unstable/ai";
import { makeModel } from "@mitome/core";
import { defineAgent, definePlugin, tool, withSession } from "@mitome/sdk";

const toolThenText = (name: string) => {
  let calls = 0;
  return makeModel(
    Layer.succeed(LanguageModel.LanguageModel, {
      streamText: (options: { readonly toolkit?: Toolkit.WithHandler<any> }) => {
        calls += 1;
        if (calls === 2)
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
        const call = Response.makePart("tool-call", {
          id: "call-1",
          name,
          params: "hello",
          providerExecuted: false,
        });
        return Stream.concat(
          Stream.succeed(call),
          Stream.unwrap(
            options.toolkit!.handle(name, "hello").pipe(
              Effect.map((results) =>
                Stream.map(results, (result) =>
                  Response.makePart("tool-result", {
                    id: call.id,
                    name: call.name,
                    providerExecuted: false,
                    ...result,
                  }),
                ),
              ),
            ),
          ),
        );
      },
    } as LanguageModel.Service),
  );
};

// #region plugin
const auditedPlugin = (log: Array<string>) =>
  definePlugin<{ readonly prefix: string }>({
    name: "audited",
    setup: async () => ({ prefix: "audit" }),
    dispose: async ({ prefix }) => void log.push(`dispose:${prefix}`),
    tools: [
      tool({
        name: "echo",
        description: "Returns a string.",
        inputSchema: Schema.String,
        outputSchema: Schema.String,
        handler: async (input, { resource, signal }) => {
          if (signal.aborted) throw new Error("Turn cancelled");
          log.push(`tool:${resource.prefix}`);
          return input;
        },
      }),
    ],
    hooks: {
      sessionStart: async ({ resource }) => void log.push(`sessionStart:${resource.prefix}`),
      sessionEnd: async ({ resource }) => void log.push(`sessionEnd:${resource.prefix}`),
      turnStart: async (text) => void log.push(`turnStart:${text}`),
      turnEnd: async (text) => void log.push(`turnEnd:${text}`),
      stepStart: async () => void log.push("stepStart"),
      stepEnd: async () => void log.push("stepEnd"),
      preStep: async (prompt) => prompt,
      preTool: async ({ name }) => (name === "echo" ? undefined : { reason: "not allowed" }),
      postTool: async ({ result }) => result,
    },
  });
// #endregion plugin

test("the documented Plugin runs every Hook with its private resource", async () => {
  const log: Array<string> = [];
  const definition = defineAgent({
    instructions: "Use echo.",
    model: toolThenText("echo"),
    plugins: [auditedPlugin(log)],
  });

  await withSession(definition, async (session) => {
    for await (const _event of session.prompt("hello")) {
      // Consume the complete Turn so the Session scope can close.
    }
  });

  expect(log).toEqual([
    "sessionStart:audit",
    "turnStart:hello",
    "stepStart",
    "tool:audit",
    "stepEnd",
    "stepStart",
    "stepEnd",
    "turnEnd:hello",
    "sessionEnd:audit",
    "dispose:audit",
  ]);
});
