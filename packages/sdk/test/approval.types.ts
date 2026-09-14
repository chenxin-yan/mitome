// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import type { Extension, Provider } from "@mitome/core";
import {
  defineAgent,
  defineExtension,
  type ApprovalPolicy,
  type ApprovalPolicyCall,
  type ApprovalPolicyDecision,
  type ApprovalRules,
} from "../src/index.js";
import { defineAgent as defineEffectAgent } from "../src/effect.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

declare const model: Provider<"test", readonly []>;

const files = defineExtension({
  name: "files",
  tools: ({ tool }) => [
    tool({
      name: "read_file",
      inputSchema: Schema.Struct({ path: Schema.String }),
      handler: async ({ path }) => path,
    }),
    tool({
      name: "write_file",
      inputSchema: Schema.Struct({ path: Schema.String, content: Schema.String }),
      handler: async ({ path }) => path,
    }),
  ],
});
// Hand-written Core Extension typed without contributions: its Tools are unknown to `approvals`.
declare const widened: Extension;

// Rule lists: known names are hints, every string is accepted.
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  approvals: { allow: ["read_file"], ask: ["write_file"], deny: ["drop_*", "*"] },
});
const plainList: string[] = ["anything"];
const typo = defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  approvals: { allow: ["raed_file", "not_a_tool"], deny: plainList },
});
export type ApprovalsAreStoredAsThePlainPolicy = Expect<
  Equal<typeof typo.approvals, ApprovalPolicy | undefined>
>;
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  // @ts-expect-error Only allow, ask, and deny are rule keys.
  approvals: { block: ["read_file"] },
});

// Extension callback: comparing `name` narrows `params`, also through destructuring.
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  approvals: (call) => {
    switch (call.name) {
      case "write_file":
        return call.params.content.length > 0 ? "ask" : "deny";
      case "read_file":
        // @ts-expect-error read_file has no content.
        void call.params.content;
        return call.params.path.startsWith("/tmp/") ? "allow" : undefined;
      // @ts-expect-error Only the known Tool names are comparable when every Extension is typed.
      case "legacy_tool":
        return "ask";
    }
  },
});
// One Extension typed without contributions leaves the whole call untyped: its Tools reach the
// callback too, so a closed `name` union would wrongly pass an exhaustiveness check.
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files, widened],
  approvals: (call) => {
    switch (call.name) {
      case "legacy_tool":
        return "ask";
      case "write_file":
        // @ts-expect-error params is unknown here.
        return call.params.content.length > 0 ? "ask" : "deny";
    }
    return undefined;
  },
});
export type MixedCallIsUntyped = Expect<
  Equal<
    ApprovalPolicyCall<readonly [typeof files, typeof widened]>,
    { readonly name: string; readonly params: unknown; readonly toolCallId: string }
  >
>;
// A conditionally selected Extension (`cond ? files : widened`) may resolve to the widened arm at
// runtime, so one slot holding a union with an untyped alternative also leaves the call untyped.
export type ConditionalSlotIsUntyped = Expect<
  Equal<
    ApprovalPolicyCall<readonly [typeof files | typeof widened]>,
    { readonly name: string; readonly params: unknown; readonly toolCallId: string }
  >
>;
// Without any known name the call is untyped.
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [widened],
  approvals: (call) => {
    // @ts-expect-error params is unknown here.
    void call.params.path;
    return call.name === "legacy_tool" ? "ask" : undefined;
  },
});
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  approvals: ({ name, params }) => (name === "read_file" && params.path === "" ? "deny" : "allow"),
});
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  // @ts-expect-error A decision must be allow, ask, deny, or undefined.
  approvals: () => "maybe",
});
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  // @ts-expect-error The callback is synchronous.
  approvals: async () => "allow",
});

// Inline `tools` after which the callback narrows; mixed with an Extension.
defineAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  tools: ({ tool }) => [
    tool({
      name: "run_shell",
      inputSchema: Schema.Struct({ command: Schema.String }),
      handler: async ({ command }) => command,
    }),
  ],
  approvals: (call) => {
    if (call.name === "run_shell") {
      // @ts-expect-error run_shell has no path.
      void call.params.path;
      return call.params.command.includes("rm") ? "deny" : "allow";
    }
    if (call.name === "read_file") return call.params.path === "" ? "deny" : undefined;
    return undefined;
  },
});
defineAgent({
  providers: [model],
  model: "test/default",
  tools: ({ tool }) => [
    tool({ name: "status", inputSchema: Schema.Void, handler: async () => "ready" as const }),
  ],
  approvals: { allow: ["status", "stat*"], ask: ["unknown"] },
});

// Regression case for the documented limitation: a callback written before inline `tools` is
// contextually typed before `tools` is inferred, so inline names are not known to it yet.
defineAgent({
  providers: [model],
  model: "test/default",
  approvals: (call) => {
    // @ts-expect-error Inline Tool names are only known to callbacks written after `tools`.
    if (call.name === "run_shell") return call.params.command ? "deny" : "allow";
    return undefined;
  },
  tools: ({ tool }) => [
    tool({
      name: "run_shell",
      inputSchema: Schema.Struct({ command: Schema.String }),
      handler: async ({ command }) => command,
    }),
  ],
});
// Rule lists are order-independent.
defineAgent({
  providers: [model],
  model: "test/default",
  approvals: { allow: ["run_shell"] },
  tools: ({ tool }) => [
    tool({
      name: "run_shell",
      inputSchema: Schema.Struct({ command: Schema.String }),
      handler: async ({ command }) => command,
    }),
  ],
});

// Named types users annotate with.
const rules: ApprovalRules<readonly [typeof files]> = { allow: ["read_file", "anything"] };
const decide = (
  call: ApprovalPolicyCall<readonly [typeof files]>,
): ApprovalPolicyDecision | undefined =>
  call.name === "write_file" && call.params.path.startsWith("/etc/") ? "deny" : undefined;
defineAgent({ providers: [model], model: "test/default", extensions: [files], approvals: rules });
defineAgent({ providers: [model], model: "test/default", extensions: [files], approvals: decide });
export type PlainCallHasUnknownParams = Expect<
  Equal<
    ApprovalPolicyCall,
    { readonly name: string; readonly params: unknown; readonly toolCallId: string }
  >
>;

// The Effect surface shares the Core typing.
defineEffectAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  approvals: (call) => (call.name === "read_file" && call.params.path === "" ? "deny" : undefined),
});
defineEffectAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  approvals: { allow: ["read_file", "*"] },
});
defineEffectAgent({
  providers: [model],
  model: "test/default",
  extensions: [files],
  // @ts-expect-error write_file has no command.
  approvals: (call) => (call.name === "write_file" && call.params.command ? "deny" : undefined),
});
