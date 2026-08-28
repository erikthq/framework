import { definePage, html, useScript } from "framework";

export const GET = definePage((c) => {
  c.set("title", "about — framework");

  // A different page, a different dependency: json-routes is not served here.
  useScript(c, "clock-tick");

  return html`
    <h1>about</h1>
    <p>
      This page asks for <code>clock-tick</code> and nothing else, so the home
      page's <code>json-routes</code> never reaches it. View source and compare.
    </p>
    <p data-init="@get('/api/clock')">
      The clock below is patched by the same long-lived response as on the home
      page; <code>clock-tick</code> flashes it on every change.
    </p>
    <p><time id="clock">waiting…</time></p>
    <p><a href="/">← home</a></p>
  `;
});
