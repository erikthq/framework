import { html, defineRoute, useLayout } from "@erikt/framework";

import { layout } from "./layout.ts";

export default defineRoute((c) => {
  // defineRoute builds the response, so c.status and c.set apply to it —
  // without this the page would render but answer 200.
  c.status(404);
  c.set("title", "Not found — framework");

  useLayout(c, layout);

  return html` <section class="empty">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
      <path d="M9 10l.01 0" />
      <path d="M15 10l.01 0" />
      <path d="M9 15l6 0" />
    </svg>
    <h3>Page not found</h3>
    <p>There's nothing on this url.</p>
    <a href="/" class="button">Homepage</a>
  </section>`;
});
