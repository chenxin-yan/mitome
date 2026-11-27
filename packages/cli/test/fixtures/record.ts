import { appendFileSync } from "node:fs";

/** Appends one event to the file named by MITOME_FIXTURE_LOG, if set. */
export const record = (event: string) => {
  const file = process.env.MITOME_FIXTURE_LOG;
  if (file !== undefined) {
    appendFileSync(file, `${event}\n`);
  }
};
