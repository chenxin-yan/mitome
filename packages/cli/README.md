# @mitome/cli

The `mitome` command. The compiled binary embeds Bun and loads one explicitly selected application module (`--app <file>`) whose default export is `defineMitome(...)` from `@mitome/core`.

```text
mitome run --app <file> [--provider <id>] [--model <provider/model>] [--grace <duration>] [input]
mitome providers --app <file>
mitome auth status|login|logout --app <file> [--provider <id>]
```

`run` is one-shot: it reads one input (the argument, else all of non-terminal stdin), runs one Turn and writes only the rendered result to stdout. See the [CLI guide](https://mitome.sh/docs/cli).
