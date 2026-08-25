import type { TextareaRenderable } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { SessionTurn, SessionViewModel, TranscriptPickerState } from "./view-model.js";

const Turn = (props: { readonly turn: SessionTurn }) => (
  <box flexDirection="column" gap={1}>
    <text>{`You\n${props.turn.prompt}`}</text>
    <For each={props.turn.activities}>{(item) => <text>{`• ${item}`}</text>}</For>
    <text>{`Assistant\n${props.turn.response}`}</text>
  </box>
);

const TranscriptPicker = (props: { readonly picker: TranscriptPickerState }) => (
  <box flexDirection="column" gap={1}>
    <text>Transcripts</text>
    <Show when={!props.picker.loading} fallback={<text>Loading…</text>}>
      <Show when={props.picker.summaries.length > 0} fallback={<text>No Transcripts yet.</text>}>
        <For each={props.picker.summaries}>
          {(summary, index) => (
            <text>{`${index() === props.picker.selected ? "›" : " "} ${new Date(summary.updatedAt).toLocaleString()}  ${summary.preview || "(no user message)"}`}</text>
          )}
        </For>
      </Show>
    </Show>
  </box>
);

export const Shell = (props: { readonly prompt: string; readonly viewModel: SessionViewModel }) => {
  const [state, setState] = createSignal(props.viewModel.getState());
  const [initialPrompt, setInitialPrompt] = createSignal(props.prompt);
  let input: TextareaRenderable | undefined;
  const unsubscribe = props.viewModel.subscribe(setState);
  onCleanup(unsubscribe);

  createEffect(() => {
    if (state().phase === "idle" && state().picker === undefined) {
      queueMicrotask(() => input?.focus());
    }
  });
  useKeyboard((key) => {
    const stop = (): void => {
      key.preventDefault();
      key.stopPropagation();
    };
    const picker = state().picker;
    if (picker !== undefined) {
      if (key.name === "escape" || key.name === "esc") {
        if (props.viewModel.closeTranscriptPicker()) stop();
      } else if (key.name === "up") {
        if (props.viewModel.moveTranscriptSelection(-1)) stop();
      } else if (key.name === "down") {
        if (props.viewModel.moveTranscriptSelection(1)) stop();
      } else if (key.name === "return" || key.name === "enter") {
        if (props.viewModel.resumeTranscript()) stop();
      }
      return;
    }
    if (key.ctrl && key.name.toLowerCase() === "o") {
      if (props.viewModel.openTranscriptPicker()) stop();
      return;
    }
    if (key.ctrl && key.name.toLowerCase() === "n") {
      if (props.viewModel.newSession()) stop();
      return;
    }
    if ((key.name === "escape" || key.name === "esc") && props.viewModel.interrupt()) stop();
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
        <Show
          when={state().picker}
          fallback={
            <box flexDirection="column" gap={1}>
              <For each={state().turns}>{(turn) => <Turn turn={turn} />}</For>
              <Show when={state().activeTurn}>
                {(turn: () => SessionTurn) => <Turn turn={turn()} />}
              </Show>
            </box>
          }
        >
          {(picker: () => TranscriptPickerState) => <TranscriptPicker picker={picker()} />}
        </Show>
        <Show when={state().notice}>{(notice: () => string) => <text>{notice()}</text>}</Show>
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
                : state().phase === "switching"
                  ? "Starting Session…"
                  : "Turn running…"
          }
          onSubmit={submit}
        />
      </box>
      <text>
        {state().picker === undefined
          ? "Alt-Enter send • Esc stop • Ctrl-O list • Ctrl-N new • Ctrl-C exit"
          : "↑/↓ select • Enter resume • Esc close • Ctrl-C exit"}
      </text>
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
