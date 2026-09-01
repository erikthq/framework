import { css, defineRoute, html, useLayout, useScript, useStyle } from "@erikt/framework";

import { layout } from "../layout.ts";

const styles = css`
  .card {
    border: 1px solid currentColor;
    border-radius: 0.5rem;
    padding: 1rem;
    opacity: 0.85;
  }

  .card time {
    font-variant-numeric: tabular-nums;
    font-size: 1.5rem;
  }
`;

export const GET = defineRoute((c) => {
  c.set("title", "about — framework");

  useLayout(c, layout);

  useScript(c, "clock-tick");
  useStyle(c, styles);

  return html`
    <h1>about</h1>
    <p>
      This page asks for <code>clock-tick</code> and one <code>css</code> block,
      so the home page's <code>json-routes</code> never reaches it. View source
      and compare.
    </p>
    <div class="card" data-init="@get('/api/clock')">
      <p>
        The clock is patched by the same long-lived response as on the home
        page; <code>clock-tick</code> flashes it on every change, and the
        <code>.card</code> rule comes from this file.
      </p>
      <p><time id="clock">waiting…</time></p>
    </div>
    <p><a href="/">← home</a></p>
  `;
});
