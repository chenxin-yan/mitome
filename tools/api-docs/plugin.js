// Local TypeDoc plugin: fumadocs needs a `title` frontmatter, flat stable slugs, and a meta.json
// for sidebar order; none of the published plugins produce those three from `@module` names.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReflectionKind, RendererEvent } from "typedoc";
import { MarkdownPageEvent, ModuleRouter } from "typedoc-plugin-markdown";

// Module names are public import paths (`@mitome/sdk/effect`); as file paths they would nest.
const slug = (name) => name.replace(/^@mitome\//, "").replaceAll("/", "-");

class EntryPointRouter extends ModuleRouter {
  getReflectionAlias(reflection) {
    return reflection.kind === ReflectionKind.Module
      ? slug(reflection.name)
      : super.getReflectionAlias(reflection);
  }
}

export function load(app) {
  app.renderer.defineRouter("entry-point", EntryPointRouter);
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    // Relative `x.md` links would hit the raw-markdown route; point them at the rendered pages.
    const contents = page.contents.replace(/\]\(([\w-]+)\.md(?=[#)])/g, "](/docs/reference/api/$1");
    page.contents = `---\ntitle: "${page.model.name}"\n---\n\n${contents}`;
  });
  app.renderer.on(RendererEvent.END, (event) => {
    const pages = ["index", ...event.project.children.map((module) => slug(module.name))];
    writeFileSync(
      join(event.outputDirectory, "meta.json"),
      `${JSON.stringify({ title: event.project.name, pages }, null, 2)}\n`,
    );
  });
}
