import type { Plugin } from "@mitome/core";

/** Creates a Plugin with a static inline Instructions fragment. */
export const instructions = (text: string): Plugin => ({
  name: "instructions",
  instructions: text,
});
