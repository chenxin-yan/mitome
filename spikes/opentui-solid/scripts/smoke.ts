import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEmbeddedHost } from "../../../packages/cli/src/child-host.js";
// @ts-expect-error Bun embeds the standalone spike host as source text.
// oxlint-disable-next-line import/default
import spikeHost from "../src/host.ts" with { type: "text" };

const directory = dirname(fileURLToPath(import.meta.url));
const definition = join(directory, "../definition.ts");
const preload = Bun.resolveSync("@opentui/solid/preload", dirname(definition));
const exit = await runEmbeddedHost(spikeHost, definition, "PTY smoke", preload);
process.exitCode = exit;
