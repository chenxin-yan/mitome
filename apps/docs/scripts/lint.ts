import { relative, sep } from "node:path";
import { printErrors, readFiles, scanURLs, validateFiles } from "next-validate-link";

const contentDirectory = "content/docs";
const toUrl = (file: string): string => {
  const path = relative(contentDirectory, file)
    .replaceAll(sep, "/")
    .replace(/\.mdx?$/, "");
  return path === "index" ? "/docs" : `/docs/${path}`;
};
// ponytail: special-character or duplicate headings slug differently; use github-slugger if it lands in-tree.
const hash = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const files = await readFiles(`${contentDirectory}/**/*.mdx`, { pathToUrl: toUrl });
const pages = ["", ...files.map((file) => file.url!.slice(1))];
const meta = Object.fromEntries(
  files.map((file) => [
    file.url!.slice(1),
    { hashes: [...file.content.matchAll(/^#{2,6}\s+(.+)$/gm)].map((match) => hash(match[1]!)) },
  ]),
);
const scanned = await scanURLs({ preset: "tanstack-start", pages, meta });
const results = await validateFiles(files, {
  scanned,
  checkRelativePaths: "as-url",
  markdown: { components: { Card: { attributes: ["href"] } } },
});

printErrors(results, true);
