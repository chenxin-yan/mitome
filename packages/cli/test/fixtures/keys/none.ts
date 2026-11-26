// A Configuration that provides no terminal options.
import { Agent, Mitome } from "@mitome/core";
import { scripted } from "../config/index.ts";

export default Mitome.make({
  agent: Agent.make({}),
  providers: [scripted],
  model: "scripted/echo",
});
