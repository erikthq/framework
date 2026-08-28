import { defineStream, html, readSignals } from "framework";

type Counter = { count?: number };

export const POST = defineStream((stream, c) => {
  const { count = 0 } = readSignals<Counter>(c);
  const next = count + 1;

  stream.patchSignals({ count: next });

  stream.patchElements(
    html`<p id="echo">
      The server received <strong>${count}</strong> and patched it to
      <strong>${next}</strong>.
    </p>`,
  );
});
