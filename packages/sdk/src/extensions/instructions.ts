import type { Extension } from "@mitome/core";

/** Creates an Extension with a static inline Instructions fragment. */
export const instructions = (text: string): Extension => ({
  name: "instructions",
  instructions: text,
});
