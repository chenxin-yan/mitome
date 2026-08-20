import type { TextareaRenderable } from "@opentui/core";
import { render } from "@opentui/solid";

export const Shell = (props: { readonly prompt: string }) => (
  <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
    <text>mitome</text>
    <box border title="Prompt" flexGrow={1}>
      <textarea
        ref={(input: TextareaRenderable) => queueMicrotask(() => input.focus())}
        id="prompt"
        initialValue={props.prompt}
        placeholder="Type a prompt"
      />
    </box>
    <text>Ctrl-C to exit</text>
  </box>
);

export const runShell = async (prompt: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    render(() => <Shell prompt={prompt} />, { exitOnCtrlC: true, onDestroy: resolve }).catch(
      reject,
    );
  });
