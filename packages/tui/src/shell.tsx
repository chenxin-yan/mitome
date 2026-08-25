import { render, useKeyboard } from "@opentui/solid";
import type { TextareaRenderable } from "@opentui/core";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { SessionTurn, SessionViewModel } from "./view-model.js";

const Turn = (props: { readonly turn: SessionTurn }) => (
  <box flexDirection="column" gap={1}>
    <text>{`You\n${props.turn.prompt}`}</text>
    <For each={props.turn.activities}>{(item) => <text>{`• ${item}`}</text>}</For>
    <text>{`Assistant\n${props.turn.response}`}</text>
  </box>
);

export const Shell = (props: { readonly prompt: string; readonly viewModel: SessionViewModel }) => {
  const [state, setState] = createSignal(props.viewModel.getState());
  const [initialPrompt, setInitialPrompt] = createSignal(props.prompt);
  let input: TextareaRenderable | undefined;
  const unsubscribe = props.viewModel.subscribe(setState);
  onCleanup(unsubscribe);

  createEffect(() => {
    if (state().phase === "idle") queueMicrotask(() => input?.focus());
  });
  useKeyboard((key) => {
    if ((key.name !== "escape" && key.name !== "esc") || !props.viewModel.interrupt()) return;
    key.preventDefault();
    key.stopPropagation();
  });

  const submit = (): void => {
    if (input !== undefined && props.viewModel.submit(input.plainText)) {
      setInitialPrompt("");
      input.clear();
    }
  };

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
      <text>mitome</text>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        <box flexDirection="column" gap={1}>
          <For each={state().turns}>{(turn) => <Turn turn={turn} />}</For>
          <Show when={state().activeTurn}>
            {(turn: () => SessionTurn) => <Turn turn={turn()} />}
          </Show>
          <Show when={state().notice}>{(notice: () => string) => <text>{notice()}</text>}</Show>
        </box>
      </scrollbox>
      <box border title="Prompt" height={5}>
        <textarea
          ref={(element: TextareaRenderable) => {
            input = element;
          }}
          id="prompt"
          initialValue={initialPrompt()}
          placeholder={
            state().phase === "idle"
              ? "Type a prompt"
              : state().phase === "interrupting"
                ? "Interrupting…"
                : "Turn running…"
          }
          onSubmit={submit}
        />
      </box>
      <text>Alt-Enter send • Enter newline • Esc interrupt • Ctrl-C exit</text>
    </box>
  );
};

export const runShell = async (viewModel: SessionViewModel, prompt: string): Promise<void> => {
  try {
    await new Promise<void>((resolve, reject) => {
      render(() => <Shell prompt={prompt} viewModel={viewModel} />, {
        exitOnCtrlC: true,
        onDestroy: resolve,
      }).catch(reject);
    });
  } finally {
    await viewModel.dispose();
  }
};
