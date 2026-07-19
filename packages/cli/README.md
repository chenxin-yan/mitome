# @mitome/cli

The mitome command-line interface.

## Installation

```sh
npm install -g @mitome/cli
# or: pnpm add -g @mitome/cli · yarn global add @mitome/cli · bun add -g @mitome/cli
```

The CLI is a self-contained native binary — it bundles its own runtime and has
no runtime dependencies. The matching binary for your platform (macOS, Linux
glibc/musl, or Windows; x64 or arm64) is installed automatically as an
optional dependency. No postinstall scripts run.

> **Bun without Node.js:** the `mitome` launcher is a Node script, so either
> have Node on your PATH or run it with Bun directly: `bunx --bun @mitome/cli`.

## Usage

```sh
mitome --help
```
