import type defaultMdxComponents from "fumadocs-ui/mdx";

declare global {
  type MDXProvidedComponents = typeof defaultMdxComponents;
}
