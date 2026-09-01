# example

A Node-hosted demo of `framework`, served by `@erikt/framework-node`.

```sh
pnpm dev            # http://localhost:3000
PORT=4173 pnpm dev  # somewhere else
```

`framework.config.ts` at the package root is the whole app — `pnpm dev` runs
that file and nothing else. Routes, scripts, public assets, styles and the
Datastar runtime are wired by default, so it only names the directory to read
and the port — `src/not-found.ts` and `src/error.ts` are found by name. Two
lines in it are
runtime-specific: the `@erikt/framework-node` import, and `process.env.PORT`.

Open it in a browser: `/` serves an HTML page that calls the JSON routes, plus
two [Datastar][datastar] demos — a counter whose signal round-trips through
`POST /api/count`, and a clock that `GET /api/clock` patches once a second over
one long-lived response. The `datastar` plugin that puts the browser's
signals on the context is one of the defaults, so the config does not
register it; the two routes read them with `readSignals` and answer with
`defineStream`. The Datastar runtime is vendored inside
`framework` and served from this app at `/datastar-1.0.3.js`, which a site turns
on by default — its tag goes into every page's head. No CDN, nothing to install.

[datastar]: https://data-star.dev

That page is a `defineRoute` route in `src/routes/index.ts`, holding nothing but
the page's own markup. The document around it — doctype, head, styles — is the
`defineLayout` in `src/layout.ts`, which the page asks for with
`useLayout(c, layout)`. Every page here does, since there is no app-wide
default. Both are template literals rather than `.html` files: `framework`
and `example` are typechecked without a filesystem, so neither can read one.

`src/layout.ts` and `src/bag.ts` sit inside the store's root but outside its
`routes/` directory, so they never become routes. `src/bag.ts` is
types only: it declares `title` on `ContextBag`, which is what makes
`c.set("title", …)` in a page and `c.get("title")` in the layout check against
each other.

Every page carries a **Refresh this page** button in `src/layout.ts`, wired to
the one `routes/api/refresh.ts` endpoint. It calls `stream.patchPage()`, which
re-renders whichever page asked and morphs the whole document back in — the
server-rendered timestamp in the footer changes, nothing else reloads.

`src/not-found.ts` is the 404 page, wired with `app.notFound`, and `src/error.ts`
is the 500 page, a `defineErrorPage` wired with `app.onError` — `/boom` throws on
purpose so there is something to see. Both sit outside `routes/`, so neither
becomes a route of its own.

`src/public/` is served as-is from the root by the `assets` plugin, so
`public/favicon.svg` is `GET /favicon.svg` — with an ETag, a 304 on
revalidation, and range support. The layout links it as the page icon.

`src/scripts/` is browser code, picked up by the `scripts` plugin: read at
startup, stripped of its types, content-hashed and served at
`/scripts/<name>.<hash>.js`. A page gets a `<script>` tag only for what it asks
for with `useScript`, so `/` loads `json-routes.ts` (the JSON-route buttons) and
`/about` loads `clock-tick.ts` and neither loads the other. View source on both
and compare.

`routes/about.ts` also holds a `css` block, served by the `styles` plugin at
`/styles/<hash>.css` and linked from that page alone — the home page never gets
it. CSS and scripts share one queue, so both land in the head in the order the
page asked for them.

`routes/api/panel.ts` is a `defineStream` that calls `useScript`. It renders no
document of its own, so the tag is appended to the head of the page already on
screen as a Datastar patch — the **GET /api/panel** button on the home page
triggers it.

Because that folder is browser code inside a Node package, it is typechecked
against `DOM` by its own `src/scripts/tsconfig.json`, and excluded from the main
`tsconfig.json`. `pnpm typecheck` runs both.
