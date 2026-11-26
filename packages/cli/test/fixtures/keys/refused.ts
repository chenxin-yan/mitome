// Terminal options that bind Tab, which the terminal keeps for moving to an Approval.
import { Agent, Mitome } from "@mitome/core";
import { terminal } from "@mitome/core/terminal";
import { scripted } from "../config/index.ts";

export default Mitome.make({
  agent: Agent.make({}),
  provide: terminal({ keys: { enter: terminal.submit, tab: terminal.newline } }),
  providers: [scripted],
  model: "scripted/echo",
});
