import { defineErrorPage, html, useLayout } from "@erikt/framework";

import { layout } from "./layout.ts";

export default defineErrorPage((error, c) => {
  c.set("title", "Something went wrong — framework");

  useLayout(c, layout);

  const status = c.status();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : String(error);

  return html`<section class="empty">
      <h3>Something went wrong</h3>
      <!-- html escapes this: an error message is not trusted markup. Showing it
         at all is a choice an example can make and a public app should not. -->
      <code>${status}</code>
      <p>${message}</p>

      <a href="/" class="button">Homepage</a>
    </section>

    <pre><code>${stack}</code></pre> `;
});
