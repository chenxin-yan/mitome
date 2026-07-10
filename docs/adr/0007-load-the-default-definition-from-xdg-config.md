# Load the default Definition from XDG config

Mitome loads `$XDG_CONFIG_HOME/mitome/agent.ts`, falling back to `~/.config/mitome/agent.ts`, and only loads another Definition through `--use <path>`, which must point to an explicit TypeScript entry-point file, never a directory. This avoids implicitly executing project-local TypeScript and postpones a project trust subsystem.
