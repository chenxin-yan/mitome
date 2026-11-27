// The real Anthropic Provider reading a profile other than `mitome`.
import { anthropic } from "@mitome/providers/anthropic";
import { Agent, Mitome } from "@mitome/core";

export default Mitome.make({ agent: Agent.make({}), providers: [anthropic({ profile: "work" })] });
