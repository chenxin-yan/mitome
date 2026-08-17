import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createSignal, For, onCleanup } from "solid-js";
import { render, useKeyboard, useRenderer } from "@opentui/solid";

const chunks = ["Streamed ", "model ", "output ", "arrives ", "incrementally."];

export interface SpikeResult {
  input: string;
  focusMoves: number;
  streamCompleted: boolean;
  scrollMoves: number;
}

export const Spike = (props: { readonly prompt: string; readonly result: SpikeResult }) => {
  const renderer = useRenderer();
  let outputRegion!: ScrollBoxRenderable;
  let inputRegion!: TextareaRenderable;
  let inputFocused = true;
  const [output, setOutput] = createSignal<ReadonlyArray<string>>([
    "OpenTUI + Solid child-host spike",
    `Initial prompt: ${props.prompt}`,
    ...Array.from({ length: 30 }, (_, index) => `Prior output line ${index + 1}`),
    "",
  ]);

  useKeyboard((key) => {
    if (key.name === "q" && !inputFocused) {
      props.result.input = inputRegion.plainText;
      renderer.destroy();
    }
    if (key.name === "tab") {
      inputFocused = !inputFocused;
      props.result.focusMoves += 1;
      (inputFocused ? inputRegion : outputRegion).focus();
    }
    if (key.name === "down" && !inputFocused) {
      outputRegion.scrollBy(1);
      props.result.scrollMoves += 1;
    }
  });

  let index = 0;
  const timer = setInterval(() => {
    setOutput((lines) => [...lines.slice(0, -1), `${lines.at(-1) ?? ""}${chunks[index]}`]);
    index += 1;
    if (index === chunks.length) {
      props.result.streamCompleted = true;
      outputRegion.scrollTo(outputRegion.scrollHeight);
      clearInterval(timer);
      if (process.env.MITOME_OPENTUI_SPIKE_AUTOMATED === "1") renderer.destroy();
    }
  }, 30);
  onCleanup(() => clearInterval(timer));

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <scrollbox
        ref={(renderable) => (outputRegion = renderable)}
        id="output"
        flexGrow={1}
        border
        title="Scrollable output (Tab moves focus)"
      >
        <For each={output()}>{(line) => <text>{line}</text>}</For>
      </scrollbox>
      <box border title="Multiline input (paste supported, Tab moves focus, then q exits)">
        <textarea
          ref={(renderable) => (inputRegion = renderable)}
          id="input"
          height={3}
          focused
          placeholder="Paste or type multiple lines"
        />
      </box>
    </box>
  );
};

export const runSpike = async (prompt: string): Promise<SpikeResult> => {
  const result: SpikeResult = {
    input: "",
    focusMoves: 0,
    streamCompleted: false,
    scrollMoves: 0,
  };
  await new Promise<void>((resolve, reject) => {
    render(() => <Spike prompt={prompt} result={result} />, {
      exitOnCtrlC: true,
      onDestroy: resolve,
    }).catch(reject);
  });
  return result;
};
