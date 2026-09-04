# create-mitome

Create a Mitome Agent project in the current directory.

```sh
npm create mitome
```

The scaffolder prompts for a Provider and native Model id, then generates a registered Provider and qualified Default Model for a Promise-first or Effect-native template. Existing project files are never overwritten.

The `create-mitome/template` export is internal plumbing shared with `mitome init`; it carries no stability guarantee.
