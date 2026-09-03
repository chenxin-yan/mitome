import type { Extension } from "@mitome/core";

export { instructionFiles, type InstructionFilesOptions } from "./instruction-files.js";

/** Creates an Extension with a static inline Instructions fragment. */
export const instructions = (text: string): Extension => ({ instructions: text });
