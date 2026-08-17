// Embedded and evaluated by the CLI's child-host spawn primitive.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const definitionPath = process.argv[1]!;
const prompt = process.argv[2]!;
const spikePath = Bun.resolveSync("@mitome/opentui-spike", dirname(definitionPath));
const spike = (await import(pathToFileURL(spikePath).href)) as typeof import("./index.js");

const result = await spike.runSpike(prompt);
process.stderr.write(`MITOME_OPENTUI_SPIKE_RESULT ${JSON.stringify(result)}\n`);
