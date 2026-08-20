// Embedded and evaluated by the CLI's child-host spawn primitive.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const definitionPath = process.argv[1]!;
const prompt = process.argv[2]!;
const tuiPath = Bun.resolveSync("@mitome/tui", dirname(definitionPath));
const tui = (await import(pathToFileURL(tuiPath).href)) as {
  readonly runShell: (prompt: string) => Promise<void>;
};

await tui.runShell(prompt);
