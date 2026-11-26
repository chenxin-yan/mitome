// Terminal options that bind no key to send the input.
import { Agent, Mitome } from "@mitome/core";
import { terminal } from "@mitome/core/terminal";
import { scripted } from "../config/index.ts";

export default Mitome.make({
  agent: Agent.make({}),
  provide: terminal({ keys: { "ctrl+j": terminal.newline, "ctrl+d": "/quit" } }),
  providers: [scripted],
  model: "scripted/echo",
});
