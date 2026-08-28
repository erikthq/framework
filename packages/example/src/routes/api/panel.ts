import { defineStream, html, useScript } from "framework";

export const GET = defineStream((stream, c) => {
  // No document to render here, so the tag is appended to the head of the one
  // already on screen — right after the markup below lands.
  useScript(c, "panel");

  stream.patchElements(html`
    <div id="panel" data-panel>
      A fragment from <code>defineStream</code>, patched in at
      ${new Date().toISOString()}.
    </div>
  `);
});
