import { defineStream, html } from "framework";

const TICK = 1000;

export const GET = defineStream(async (stream) => {
  while (!stream.closed) {
    const now = new Date().toISOString();

    stream.patchElements(
      html`<time id="clock" datetime="${now}">${now.slice(11, 19)} UTC</time>`,
    );

    await new Promise((resolve) => setTimeout(resolve, TICK));
  }
});
