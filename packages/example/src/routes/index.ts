import { defineRoute, html, useLayout, useScript } from "@erikt/framework";

import { layout } from "../layout.ts";

export const GET = defineRoute((c) => {
  c.set("title", "framework");

  // Each page asks for its own layout; there is no app-wide default.
  useLayout(c, layout);

  // Only this page depends on it, so only this page gets the tag.
  useScript(c, "json-routes", "signals");

  return html`
    <div class="prose">
      <hgroup>
        <h1>framework</h1>
        <p>Served by <code>@erikt/framework-node</code> over <code>node:http</code>.</p>
      </hgroup>
    </div>

    <article class="prose secondary" data-signals="{count: 0}">
      <h2>Signals</h2>
      <p>
        The counter lives in the browser, rides along with every request, and
        comes back patched by <code>POST /api/count</code>.
      </p>
      <p>
        <button data-on:click="@post('/api/count')">Increment</button>
        <button data-on:click="$count = 0">Reset</button>
        <button data-bump="5">+5 from a browser module</button>
      </p>
      <p>Signal: <strong data-text="$count">0</strong></p>
      <p id="echo">The server has not answered yet.</p>
    </article>

    <hr />

    <article class="prose secondary">
      <h2>Streaming</h2>
      <p data-init="@get('/api/clock')">
        One long-lived response from <code>GET /api/clock</code> patches the
        clock once a second.
      </p>
      <p><time id="clock">waiting…</time></p>
    </article>

    <hr />

    <article class="prose">
      <h2>JSON routes</h2>
      <p>
        <button data-url="/api/users/42">GET /api/users/42</button>
        <button data-url="/api/time">GET /api/time</button>
        <button data-on:click="@get('/api/panel')">GET /api/panel</button>
        <button data-url="/api/missing">GET /api/missing</button>
      </p>
      <pre id="output">Click a button.</pre>
    </article>

    <hr />

    <article class="prose secondary">
      <div id="panel"></div>
    </article>
  `;
});
