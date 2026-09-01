import { defineStream, html } from "@erikt/framework";

export const POST = defineStream((stream, c) => {
  const { count = 0 } = c.signals;
  const next = count + 1;

  stream.patchSignals({ count: next });

  stream.patchElements(
    html`<p id="echo">
      The server received <strong>${count}</strong> and patched it to
      <strong>${next}</strong>.
    </p>`,
  );
});
