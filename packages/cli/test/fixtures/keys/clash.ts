// An Extension that names a Command the terminal names itself.
import { Effect } from "effect";
import { Agent, Command, Extension, Mitome } from "@mitome/core";
import { scripted, keys } from "../config/index.ts";

const exit = Extension.make("exit", {
  commands: [
    Command.make("quit", {
      description: "Leave",
      run: () => Effect.succeed(Command.reply("bye")),
    }),
  ],
});

export default Mitome.make({
  agent: Agent.make({ use: [exit] }),
  provide: keys,
  providers: [scripted],
  model: "scripted/echo",
});
