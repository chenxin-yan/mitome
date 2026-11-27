// A Configuration with the real Anthropic Provider, whose sign-in runs whatever `ant` is on PATH.
import { anthropic } from "@mitome/providers/anthropic";
import { Agent, Mitome } from "@mitome/core";

export default Mitome.make({ agent: Agent.make({}), providers: [anthropic()] });
