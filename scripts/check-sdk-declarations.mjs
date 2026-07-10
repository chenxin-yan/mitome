import { Glob } from "bun";

const forbidden = /["']effect(?:\/|["'])/;
const files = [...new Glob("packages/sdk/dist/**/*.d.ts").scanSync()];

if (files.length === 0) {
  throw new Error("@mitome/sdk declarations have not been built");
}

for (const file of files) {
  const declaration = await Bun.file(file).text();
  if (forbidden.test(declaration)) {
    throw new Error(`${file} leaks Effect types`);
  }
}
