# example

A Node-hosted demo of `framework`, served by `node-adapter`.

```sh
pnpm dev            # http://localhost:3000
PORT=4173 pnpm dev  # somewhere else
```

Open it in a browser: `/` serves an HTML page that calls the JSON routes, plus
two [Datastar][datastar] demos — a counter whose signal round-trips through
`POST /api/count`, and a clock that `GET /api/clock` patches once a second over
one long-lived response. The `datastar` plugin that puts the browser's
signals on the context is one of `createApp`'s defaults, so `main.ts` does not
register it; the two routes read them with `readSignals` and answer with
`defineStream`. The Datastar runtime is vendored inside
`framework` and served from this app at `/datastar-1.0.3.js`; `main.ts` turns it
on with `datastar: { client: true }`, which also puts its tag in every page's
head. No CDN, nothing to install.

[datastar]: https://data-star.dev

That page is a `definePage` route in `src/routes/index.ts`, holding nothing but
the page's own markup. The document around it — doctype, head, styles — is the
`defineLayout` in `src/layout.ts`, which `main.ts` passes to `createApp` so every
page gets it. Both are template literals rather than `.html` files: `framework`
and `example` are typechecked without a filesystem, so neither can read one.

`src/layout.ts`, `src/main.ts` and `src/bag.ts` sit inside the store's root but
outside its `routes/` directory, so they never become routes. `src/bag.ts` is
types only: it declares `title` on `ContextBag`, which is what makes
`c.set("title", …)` in a page and `c.get("title")` in the layout check against
each other.

`src/scripts/` is browser code, picked up by the `scripts` plugin: read at
startup, stripped of its types, content-hashed and served at
`/scripts/<name>.<hash>.js`. A page gets a `<script>` tag only for what it asks
for with `useScript`, so `/` loads `json-routes.ts` (the JSON-route buttons) and
`/about` loads `clock-tick.ts` and neither loads the other. View source on both
and compare.

`routes/api/panel.ts` is a `defineEndpoint`: a fragment with no layout, whose
`useScript` tag is appended to the markup instead of going into a `<head>`.
The **GET /api/panel** button on the home page prints it raw, so you can see the
`<script>` travelling with the fragment.

Because that folder is browser code inside a Node package, it is typechecked
against `DOM` by its own `tsconfig.scripts.json`, and excluded from the main
`tsconfig.json`. `pnpm typecheck` runs both.
