// A second Configuration, naming its Auth capability relative to this file as an author writes it.
import { Agent, Mitome, Provider } from "@mitome/core";
import { echoModel } from "../config/index.ts";

export default Mitome.make({
  agent: Agent.make({}),
  providers: [
    Provider.make("oauth", {
      modelIds: [],
      credential: { capability: { module: "../capability.ts" } },
      provision: () => echoModel("oauth"),
    }),
  ],
});
