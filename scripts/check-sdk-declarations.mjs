import { Glob } from "bun";

const forbidden = [
  /from ["']effect(?:[/'"]|$)/,
  /["']effect["']/,
  /effect\//,
  /Effect</,
  /Layer</,
  /Scope/,
  /Stream</,
  /Context\.Tag/,
];
const files = [...new Glob("packages/sdk/dist/**/*.d.ts").scanSync()];

if (files.length === 0) {
  throw new Error("@mitome/sdk declarations have not been built");
}

for (const file of files) {
  const declaration = await Bun.file(file).text();
  const match = forbidden.find((pattern) => pattern.test(declaration));
  if (match !== undefined) {
    throw new Error(`${file} leaks ${match}`);
  }
}
