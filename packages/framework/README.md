# @erikt/framework

Runtime-agnostic building blocks, built on web platform APIs only. No
dependencies, no Node.js.

- **defineConfig** — one file that wires a whole site: routes, scripts, styles,
  assets, runtime.
- **Server** — a `Request` → `Response` handler with routing and middleware.
- **compress** — response compression via `CompressionStream`.
- **Plugins** — lifecycle, per-request and HTML-injection hooks, plus a built-in
  startup banner and request logger.
- **assets** — a `public/` directory served as-is, with ETags, 304s and ranges.
- **scripts** — browser TypeScript from a folder, type-stripped, content-hashed
  and injected into the pages that declare they need it.
- **styles** — `css``` blocks written next to the markup, hashed and served as
  stylesheets.
- **datastar** — signals off the request, element and signal patches back over
  SSE. On by default.
- **defineRoute** — one route function for markup or data: an HTML page wrapped
  in the layout it asks for, a fragment that asks for none, or an object served
  as JSON.
- **fileRouter** — routes from a tree of files, read through a `FileStore`.
- **FileStore** — the file-reading port: one interface, one adapter per runtime.
- **Router** — URL matching on top of `URLPattern`.

## Server

`createApp` builds a web server as a single `fetch` handler: `Request` in,
`Response` out. Inspired by [Hono][hono], and deliberately a subset of it.

```ts
import { createApp, defineRoute } from '@erikt/framework'

const app = createApp()

app.use(async (c, next) => {
  const response = await next()

  response.headers.set('x-response-time', 'fast')

  return response
})

app.get('/', defineRoute(() => 'hello'))
app.get('/users/:id', defineRoute(c => ({ id: c.params.id })))
app.post(
  '/users',
  defineRoute(async c => {
    c.status(201)

    return await c.req.json()
  }),
)

const response = await app.fetch(new Request('http://localhost/users/42'))
```

There is no `listen`. `app.fetch` *is* the server, which is what makes it
portable: it is already the entry shape Deno, Bun and Workers expect.

```ts
export default app          // Deno, Bun, Cloudflare Workers
```

Running it on Node needs an adapter to bridge `node:http` to `Request`/
`Response`. That is `@erikt/framework-node` — `framework` itself never imports `node:*`.

```ts
import { serve } from '@erikt/framework-node'

const server = await serve(app, { port: 3000 })
```

### Routing

`get` `post` `put` `patch` `delete` `options` `head` `all`, plus
`on(method, pattern, handler)`. Every method returns the app, so calls chain.

Patterns are the router's, so everything in *Router* below applies —
`:params`, `*` wildcards, and `URLPatternInit` for matching the hostname or
search. The **first** matching route wins, so register specific routes first.

Two behaviours worth knowing:

- A path that matches but with the wrong method returns **405** with an `Allow`
  header, not 404.
- A `HEAD` with no `HEAD` route falls back to the `GET` route and strips the
  body.

### Context

| | |
| --- | --- |
| `c.req` | The `Request` |
| `c.url` | Its parsed `URL` |
| `c.params` | Path params from the matched route |
| `c.body` `c.redirect` | The two response builders. A route does not need them — see *Pages and layouts* |
| `c.header(name, value)` `c.status(code)` | Applied to whatever response is built |
| `c.status()` | Reads it back — the status the response *would* carry, 200 if nothing set it |
| `c.set(key, value)` `c.get(key)` | Per-request state, for passing data from middleware. Typed — see below |
| `c.signals` | Added by the `datastar` plugin — see *Plugin: datastar* |

There is no `c.text`, `c.json` or `c.html`. A route says what it is answering
with by what it returns — `html``` is HTML, a string is text, an object is JSON
— so the content type is decided once, where the content is. See *Pages and
layouts*. `c.body` is for the rest: middleware, a plugin hook, an `onError`
handler, anything that has to hand back a `Response` of its own.

`c.body` takes a status or a `ResponseInit` as its second argument, plus `type`:

```ts
c.body('no', { status: 401, type: 'text/plain; charset=utf-8' })
```

`type` is a *default* content type — it lands only if nothing has set one
already, so a `c.header('content-type', …)` still wins.

#### The context bag is typed

`c.set` and `c.get` are keyed by an interface, `ContextBag`. Declare your keys
once and the editor suggests them, `c.get` comes back typed, and a wrong value
is a compile error:

```ts
// bag.ts — types only, nothing to import at runtime
import type {} from '@erikt/framework'

declare module 'framework' {
  interface ContextBag {
    title: string
    user: { id: number }
  }
}
```

```ts
c.set('title', 'Home')
c.set('title', 123)          // ✗ number is not assignable to string

const title = c.get('title') // string | undefined
const user = c.get('user')   // { id: number } | undefined
```

The file needs no import anywhere — put it under your `tsconfig`'s `include` and
the augmentation applies across the project.

**Undeclared keys still work.** The key type is
`keyof ContextBag | (string & {})`, so anything goes and an undeclared key reads
back as `unknown`. The `& {}` is not decoration: a plain union with `string`
collapses to `string` and the editor stops offering the declared keys, which is
the whole point.

The framework declares the keys it uses itself — `logger:started`,
`datastar:signals`, `head:markup`, `head:taken`, `scripts:registry`,
`styles:base` — so they show up as taken rather than colliding with one of yours
by accident.
Reading them is fine; writing them is your own foot. `datastar:signals` has
`readSignals(c)` in front of it, which is the supported way in.

### Middleware

```ts
app.use(async (c, next) => {          // every request
  return next()
})

app.use('/admin/*', async (c, next) => {   // scoped by pattern
  if (c.req.headers.get('authorization') === null)
    return c.body('unauthorized', { status: 401, type: 'text/plain; charset=utf-8' })

  return next()
})
```

Middleware runs in registration order, wrapping the handler. Unlike Hono,
middleware **returns** the response rather than mutating `c.res` — call `next()`
to get the response from further down the chain, return something else to
short-circuit, and skip `next()` entirely to never reach the handler.

A handler that throws propagates past any `await next()`, so middleware does not
see the error unless it wraps `next()` in `try`/`catch`. `onError` catches it.

### Errors and 404s

```ts
app.notFound(
  defineRoute(c => {
    c.status(404)

    return { missing: c.url.pathname }
  }),
)

app.onError((error, c) =>
  c.body(JSON.stringify({ error: String(error) }), {
    status: 500,
    type: 'application/json; charset=utf-8',
  }),
)
```

Defaults are a plain-text 404 and a plain-text 500. `onError` catches throws from
handlers and middleware alike.

[hono]: https://hono.dev/

## Configuration

The quickest start is the starter, which writes everything below for you:

```sh
pnpm create @erikt/framework my-site
```

`createApp` and a handful of `app.plugin(…)` calls are the low-level way in.
`defineConfig` is the quick one: a single file that names what your site is, with
routes, scripts, styles and static assets wired up already.

```ts
// framework.config.ts
import { defineConfig } from '@erikt/framework-node'

import ErrorPage from './src/error.ts'
import NotFound from './src/not-found.ts'

export default defineConfig({
  title: 'my-site',
  root: new URL('./src/', import.meta.url),
  notFound: NotFound,
  error: ErrorPage,
})
```

```json
{ "scripts": { "dev": "node framework.config.ts" } }
```

That is the whole setup — one file, and it *is* the entry point. An adapter's
`defineConfig` starts the server itself, so there is no second file whose only
job is to call something. `src/routes/` are the routes, `src/scripts/` is browser
code, `src/public/` is served as-is, `css``` blocks are served as stylesheets, and
the Datastar runtime is served from your own origin.

The import on the first line is the only runtime-specific thing in the file.
Swap `@erikt/framework-node` for `@erikt/framework-deno` and nothing else changes.

| Option | Default | |
| --- | --- | --- |
| `title` | — | Shorthand for `banner: { title }` |
| `routes` | `'routes'` | Directory for file-based routes. `false` to turn off |
| `scripts` | `'scripts'` | Directory for browser code. `false` to turn off |
| `assets` | `'public'` | Directory served as-is. `false` to turn off |
| `styles` | on | `false` to turn off, or `StylesOptions` |
| `store` | — | A `FileStore` outright |
| `plugins` | `[]` | Your own, registered before the file router |
| `notFound` `error` | `not-found.ts` `error.ts` at the root | Named explicitly only to override the file |

`banner`, `compress`, `logger` and `datastar` pass straight through to
`createApp`, so everything under *Defaults* still applies. The one default a
site adds on top is `datastar: { client: true }` — a site serves its own runtime
rather than reaching for a CDN.

Adapters add three more, because they are the three things a portable runtime
cannot do:

| Option | |
| --- | --- |
| `root` | Directory the site is read from, turned into a store by the adapter |
| `port` `hostname` | Where to listen |
| `listen` | `false` to build the site without serving it |

The config is where the environment lands — nothing else reads it:

```ts
port: Number(process.env.PORT ?? 3000)
```

### Pages found by name

`not-found.ts` and `error.ts` at the root of your site are picked up without
being named in the config — the same way `routes/` and `public/` are. Each one
default-exports its page:

```ts
// src/not-found.ts
export default defineRoute(c => {
  c.status(404)
  useLayout(c, layout)

  return html`<h1>Nothing here</h1>`
})
```

```ts
// src/error.ts
export default defineErrorPage((error, c) => html`<p>${String(c.status())}</p>`)
```

They are ordinary pages: they ask for a layout the same way, and `useScript`
works inside them. Naming `notFound` or `error` in the config overrides the file; having
neither leaves the plain-text 404 and 500 from *Errors and 404s*.

Existence is decided from a directory listing, not by catching a failed import —
so a syntax error inside `not-found.ts` is an error you see, rather than a
silent fall back to the default. A file that exports something other than a
function is refused at startup, by name.

### The tsconfig

`framework` ships the compiler settings it expects, and each adapter narrows
them to its runtime. Extend your **adapter's** and write nothing else:

```json
{
  "extends": "@erikt/framework-node/tsconfig.base.json",
  "include": ["src/**/*.ts", "framework.config.ts"]
}
```

That gets you `strict` with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, `nodenext` resolution, `allowImportingTsExtensions`
(there is no build step, so relative imports carry `.ts`), and the
erasable-syntax rules Node's type stripping needs — `verbatimModuleSyntax`,
`isolatedModules`, `erasableSyntaxOnly`.

For code that does not run on your server, extend `@erikt/framework/tsconfig.browser.json`:
the web-standards flavour — `DOM`, no Node types — plus the types for the
Datastar runtime, so browser code can import it.

```json
// src/scripts/tsconfig.json
{
  "extends": "@erikt/framework/tsconfig.browser.json",
  "include": ["**/*.ts"]
}
```

Put it **in that folder and call it `tsconfig.json`**. An editor loads only
`tsconfig.json`, walking up from the file it is showing, so a
`tsconfig.scripts.json` at your project root works with `tsc -p` and leaves your
editor to guess — which shows up as `Cannot find module 'datastar'` underlined
in a file that builds fine.

A base carries no `include` of its own, deliberately — an inherited one resolves
against the directory it was written in, which would point you at the package's
source rather than yours.

### Serverless, and the two halves

`framework` exports its own `defineConfig` and `createSite`. That pair is the
**portable half**: it takes a `store` rather than a `root`, and it has no
`start`, because binding a port is not something a `Request`/`Response` runtime
does. It is what you want on Workers or Deno Deploy:

```ts
import { createSite, staticStore } from '@erikt/framework'

export default createSite({ store: staticStore(files) })
```

`app.fetch` is the entry shape those runtimes already expect, so `export default`
is the whole deployment.

An adapter's `defineConfig` is the same config plus `root`, `port`, `hostname`
and `listen` — and it *starts the server*. That is the difference between the
two halves: `framework`'s is a pure identity function, because a portable
runtime has nothing to start.

`listen: false` gives you the config back without a server, which is what a test
wants. To get the app itself, an adapter's `createSite` builds it from the same
config, `root` included, and never listens.

Adapters depend on `framework` for this layer, and only for this layer: `serve`
and the stores import types from it but no values, so a bare `serve(handler)`
still hosts any object with a `fetch` method.

Everything an adapter must implement is exported as one schema — `Adapter`,
`AdapterConfig`, `CreateStore`, `DirectoryStore`, `FetchHandler`, `Serve`,
`ServeHandle`, `ServeOptions`. Writing one is a matter of satisfying that type;
[ADAPTERS.md](../../ADAPTERS.md) is the long form.

### Reaching past the config

`createSite` returns a normal `App`, so anything the config does not cover is
still yours:

```ts
import { defineRoute } from '@erikt/framework'
import { createSite } from '@erikt/framework-node'

const app = createSite(config)

app.get('/health', defineRoute(() => ({ ok: true })))
```

Registration order is the one thing to know: the file router is registered
**last**, after your `plugins`, so a route you claim by hand is matched before a
file route that would also match it.

## Defaults

`createApp()` comes with **compress** and the **banner**, **logger** and
**datastar** plugins already registered. Nothing to wire up:

```ts
const app = createApp()   // compression + banner + request log + Datastar signals
```

Configure or switch them off through `createApp`:

```ts
createApp({ banner: false })                     // no banner
createApp({ compress: false })                   // no compression
createApp({ logger: false })                     // no request log
createApp({ datastar: false })                   // no signal parsing
createApp({ banner: { title: 'my-app' } })       // banner options
createApp({ compress: { threshold: 0 } })        // compress options
createApp({ logger: { header: false } })         // logger options
createApp({ datastar: { param: 'ds' } })         // datastar options
```

`compress` is registered before you can add anything, so it stays the outermost
middleware and compresses the final response — including whatever your own
middleware did to it. `logger` is the first plugin for the same reason: its
`onRequest` / `onResponse` pair brackets every other, so what it times is the
whole request, compression included. `datastar` comes next, before any plugin
you add, so your own `onRequest` hooks already see the signals it parsed.

**What the datastar default costs you.** On `GET` it is a `URLSearchParams`
lookup. On a request with a JSON body it clones the request and reads that body
to look for signals, whether or not the request came from Datastar — the clone
is why your handler can still call `c.req.json()`, but an app that posts large
JSON and never uses Datastar is paying for a read it does not need.
`createApp({ datastar: false })` is the way out.

**One caveat when testing.** With compression on, `app.fetch()` can hand back a
`Response` whose body is gzip, and `await response.text()` on a hand-built
`Response` does **not** decode it — only real HTTP clients do. It only bites when
a test sets `Accept-Encoding` and the body is over the threshold, but if a test
cares about body bytes rather than compression, use
`createApp({ compress: false })`. The test suite does exactly that — and turns
`logger` off too, so a few hundred request lines stay out of the test output.

## Middleware: compress

Compresses response bodies with the platform's [`CompressionStream`][cs].

**On by default** — see *Defaults* above. Register it by hand only when you have
switched the default off and want it somewhere specific in the chain:

```ts
import { compress, createApp } from '@erikt/framework'

const app = createApp({ compress: false })

app.use(compress({ threshold: 512 }))
```

Register it first, so it wraps everything else and sees the final response.

### What it does

Negotiates `Accept-Encoding` against its configured encodings, honouring
q-values (`q=0` is a refusal) and `*`, then pipes the body through
`CompressionStream`. It sets `Content-Encoding`, drops the now-wrong
`Content-Length`, and adds `Vary: Accept-Encoding` — appending to any existing
`Vary` rather than replacing it.

It leaves a response alone when:

- there is no body, or the status is 204, 205, 206 or 304
- `Content-Encoding` is already set
- `Cache-Control` contains `no-transform`
- the content type is not compressible
- the body is smaller than `threshold`
- the client accepts none of the configured encodings

### Options

| Option | Default | |
| --- | --- | --- |
| `encodings` | `['gzip', 'deflate']` | Preference order, best first |
| `threshold` | `1024` | Bodies below this many bytes are sent as-is |
| `types` | text, JSON, XML, JS, WASM, SVG | `RegExp` tested against `Content-Type` |
| `filter` | — | `(c, response) => boolean`, replacing the `types` check entirely |

### Encodings

`CompressionStream` supports `gzip`, `deflate` and `deflate-raw` — **not** `br`
or `zstd`, which throw. `deflate-raw` is not a valid HTTP `Content-Encoding`, so
only `gzip` and `deflate` are useful here; it is in the type for completeness.

### On the threshold

Most responses carry no `Content-Length`, so a length-only check would make
`threshold` do nothing. Instead the middleware reads from the body until it has
either passed the threshold or reached the end: a short body is sent uncompressed
from the bytes already in hand, and anything longer is re-streamed with those
bytes replayed first. Buffering never exceeds `threshold`, so large and streaming
responses stay streamed.

[cs]: https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream

## Plugins

A plugin is a plain object with a `name` and any of the lifecycle hooks. Register
with `app.plugin(...)`.

```ts
import { createApp, defineRoute } from '@erikt/framework'

app.plugin({
  name: 'request-id',

  setup(app) {
    app.get('/healthz', defineRoute(() => 'ok'))
  },

  onRequest(c) {
    c.set('requestId', crypto.randomUUID())
  },

  onResponse(c, response) {
    response.headers.set('x-request-id', c.get<string>('requestId') ?? '')
  },
})
```

### Hooks

| Hook | When | Returning a value |
| --- | --- | --- |
| `setup(app)` | Once, on start. Register routes and middleware here. | — |
| `onStart(info)` | Once, after every plugin's `setup`. | — |
| `injectHTML(c, target)` | Per request, for anything rendering markup. | `{ head, body }`, spliced into it. |
| `onRequest(c)` | Per request, before routing and middleware. | A `Response` short-circuits everything. |
| `onResponse(c, response)` | Per request, after the handler. | A `Response` replaces it. |
| `onError(error, c)` | A handler or middleware threw. Observation only. | — |
| `onStop()` | On `app.stop()`. | — |

Hooks run in registration order and every one may be `async` — they are awaited.
`onError` observes; it does not handle. Use `app.onError` to produce the response.

`injectHTML` is the one hook that is not on the path of every request. It runs
only where a `defineRoute` route renders — see *Pages and layouts* — so a JSON
route, a raw `c.body()` and a Datastar patch are never rewritten:

```ts
app.plugin({
  name: 'analytics',
  injectHTML: (c, target) => ({
    head: '<script src="/analytics.js"></script>',
    body: `<!-- rendered ${c.url.pathname} -->`,
  }),
})
```

`target` is `'document'` when the route asked for a layout and `'fragment'`
when it did not. Check it whenever what you
inject is page-wide — a runtime, a stylesheet, a meta tag — since a fragment is
patched into a page that already has those. The `datastar` plugin's `client`
option is exactly this case.

`head` goes before the first `</head>` and `body` before the last `</body>`.
Every injecting plugin contributes, concatenated in registration order. Markup
with no closing tag to sit before is **appended** rather than dropped, so a
layout that returns a fragment still gets it. What you return is spliced in
verbatim — it is markup, not text, so escape anything that came from a user.

### Starting

```ts
const info = await app.start({ url: 'http://localhost:3000' })
```

`start()` runs each `setup` then each `onStart`, exactly once — later calls return
the first result. **You rarely call it yourself:** `app.fetch` awaits it, so an
app that is only ever fetched still starts correctly, and no request is served
before startup finishes. `@erikt/framework-node`'s `serve` calls it with the bound URL.

`StartInfo` carries what a plugin needs to report itself:

| | |
| --- | --- |
| `runtime` | From `navigator.userAgent` — `'Node.js/24'`, `'Deno/2.x'`, … |
| `url`, `hostname`, `port` | Whatever the caller passed; absent when unknown |
| `routes` | `{ method, pattern }` for every registered route |
| `plugins` | Registered plugin names |
| `startedAt` | `Date.now()` at startup |

`app.routes` exposes the same route list at any time.

### banner

The built-in startup plugin, **registered by default**. Prints a box with the
URL, runtime, plugin list and route table. Configure it through `createApp`:

```ts
const app = createApp({ banner: { title: 'my-app' } })
```

Or register it yourself after opting out, e.g. to control plugin order:

```ts
import { banner, createApp } from '@erikt/framework'

const app = createApp({ banner: false }).plugin(banner({ title: 'my-app' }))
```

```
╭───────────────────────────╮
│ my-app ready              │
│                           │
│   ▸ http://localhost:3000 │
│   runtime  Node.js/24     │
│   routes   4              │
│   plugins  logger, banner │
│                           │
│   GET    /                │
│   GET    /api/time        │
│   GET    /api/users/:id   │
│   POST   /api/users       │
╰───────────────────────────╯
```

| Option | Default | |
| --- | --- | --- |
| `title` | `'framework'` | |
| `color` | `true` | ANSI colour. `framework` cannot detect a TTY — the MCA has no such API — so this is yours to set. |
| `routes` | `true` | Include the route table |
| `log` | `console.log` | Where to write. Handy for tests. |

### logger

The built-in request logger, **registered by default**. Times every response,
logs a line per request, and reports the same figure in a response header:

```
GET /api/users/7 → 200 (1.4ms)
POST /api/users → 201 (0.6ms)
GET /missing → 404 (0.2ms)
```

```ts
const app = createApp({ logger: { header: 'x-elapsed' } })
```

Or register it yourself after opting out, e.g. to time only what a plugin
registered before it did not already handle:

```ts
import { createApp, logger } from '@erikt/framework'

const app = createApp({ logger: false }).plugin(logger())
```

| Option | Default | |
| --- | --- | --- |
| `header` | `'x-response-time'` | Response header carrying the elapsed time. `false` to log only |
| `log` | `console.log` | Where to write. Handy for tests. |

Two things follow from it being a plugin rather than middleware, and both are
deliberate:

- **It measures everything**, because plugin hooks run outside the whole
  middleware chain — `compress` included. Middleware could only time what is
  registered after it.
- **A thrown error is not logged.** `onResponse` does not run when a handler
  throws; the framework's own 500 is not a response the logger ever sees. Plugin
  `onError` is the hook for that, and it is the one to add if you want failures
  reported — see *Hooks*.

The header is added by rebuilding the response rather than by setting it in
place, because a handler is free to return a response whose headers are immutable
— anything straight from `fetch()`, or a `Response.redirect()`.

## Plugin: assets

Serves a directory of files as they are — a `public/` folder of favicons,
images, fonts, robots.txt — through a `FileStore`, with the conditional-request
handling that makes a browser cache actually work.

```ts
import { assets, createApp } from '@erikt/framework'
import { nodeStore } from '@erikt/framework-node'

const store = nodeStore(new URL('./', import.meta.url))

const app = createApp().plugin(assets({ store, dir: 'public' }))
```

`src/public/favicon.svg` is then `GET /favicon.svg`.

| Option | Default | |
| --- | --- | --- |
| `store` | — | Required. A `FileStore` with `read` |
| `dir` | `'public'` | Folder to serve, relative to the store's root |
| `base` | `'/'` | URL prefix to serve it under |
| `cacheControl` | `public, max-age=0, must-revalidate` | Sent with every file |
| `types` | a table of the common web types | Merged over the built-in one, keyed by extension including the dot |

### What it adds to the file

The store hands back bytes with `Content-Length` and `Last-Modified`. Everything
else is this plugin's job, because it is the same everywhere and so does not
belong in an adapter:

- **`Content-Type`** from the extension. A type the store set itself is left
  alone — the store knows more than a table does.
- **`ETag`**, weak, derived from size and mtime rather than the bytes, so
  serving a file never costs a hash of it. It is not a claim about content, and
  it says so with the `W/` prefix.
- **`304 Not Modified`** for a matching `If-None-Match`, or `If-Modified-Since`
  when there is no `If-None-Match` — the order the spec asks for. The 304
  carries the validators and no body.
- **`206 Partial Content`** for a `Range`, with `Content-Range` and
  `Accept-Ranges: bytes`. `bytes=2-5`, `bytes=7-` and `bytes=-3` all work; a
  range past the end is a `416`. A multi-range or unparseable header is
  ignored and the whole file is sent, which the spec allows.

The body is only buffered when a range was actually asked for. Otherwise it is
passed through in whatever shape the store returned, so a store that streams
keeps streaming.

### How it decides what to serve

The directory is listed **once at startup** into a path map, and the plugin then
registers one piece of middleware. Two things follow, both deliberate:

- **A request for anything else costs a `Map` lookup and falls through** to the
  router. Nothing is read from disk on a miss, and no route pattern is
  registered that could shadow one of yours — `/` still reaches your `/` route
  even with `base: '/'`.
- **A file added while the server is running is not served** until it restarts,
  the same as `fileRouter` and `scripts`. What is *in* the file is read per
  request, so editing one is picked up immediately; it is the listing that is
  fixed.

There is no directory index: `/` is never quietly answered with
`public/index.html`, because that would take a path your router almost certainly
wants. Link the file by name if you want it.

Only `GET` and `HEAD` are handled; anything else falls through, so you can still
`POST` to a path that happens to match a file.

## Plugin: datastar

Server-driven UI over [Datastar][datastar]. The plugin reads the signals the
browser sends and puts them on the context; `defineStream` is how a route
answers, by patching elements and signals back.

**On by default** — see *Defaults* above, including what it costs an app that
does not use it. Switch on `client` and the browser runtime is served and
wired up too, so there is nothing to add to your layout:

```ts
const app = createApp({ datastar: { client: true } })
```

### The browser runtime

The Datastar client is **vendored** — `src/plugins/datastar-client.ts` holds the
official v1.0.3 bundle verbatim, under its MIT licence, with the notice kept in
the file header. There is no CDN in your critical path and nothing to install.

With `client: true` the plugin serves it at `/datastar-1.0.3.js` and injects
`<script type="module">` into the `<head>` of every **document** it renders. Not
into fragments: an endpoint's markup is patched into a page that is already
running the runtime, so shipping a second copy with every partial would be
noise. The URL carries the version, so it is served `immutable` — a given URL
never changes what it returns.

The tag goes in ahead of anything `useScript` adds, because plugin hooks run in
registration order and `datastar` is registered before your own plugins.

`client` is **off by default**, since the plugin itself is on by default and an
app that never touches Datastar should not be handed 33KB of runtime. If you
would rather place the tag yourself — behind a CDN, under a different path, on
some pages only — leave it off and use the exports:

```ts
import { DATASTAR_CLIENT, DATASTAR_VERSION } from '@erikt/framework'

app.get('/vendor/datastar.js', c => c.body(DATASTAR_CLIENT, { headers: { … } }))
```

To take a newer Datastar, replace that file: the header carries the source URL
and the two commands that regenerate it.

### Reading signals

Datastar sends every signal that does not start with `_` on every request: in
the `datastar` query parameter on `GET`, in a JSON body on everything else. The
plugin's `onRequest` hook parses both, and they arrive as **`c.signals`**:

```ts
export const POST = defineRoute(c => c.signals)
```

`signals` is not part of core: the plugin adds it to `Context` itself, which is
why `Context` is an interface. Turn the plugin off and nothing puts one there.

**Declare every signal your app defines.** Put them in one place, the same way
`ContextBag` works, and adding one is what gives it a type and an autocomplete
entry on `c.signals`:

```ts
// src/bag.ts — types only, nothing to import at runtime
import type {} from '@erikt/framework'

declare module 'framework' {
  interface Signals {
    query?: string
    page?: number
  }
}
```

```ts
c.signals.query      // string | undefined
c.signals.anything   // unknown — undeclared keys still read
```

**Declare them optional.** A signal is whatever the browser chose to send, so a
route should still say what it wants when nothing arrives:

```ts
const { page = 1 } = c.signals
```

Declaring `page: number` would type that default as dead code while the request
that omits it hands you `undefined` anyway — the destructuring default is what
keeps `POST /api/count` with an empty body from computing `NaN`. A declaration
is a claim about a payload **the client controls**, not a guarantee; validate
anything you are going to trust.

The framework declares its own — `headAssets`, which `useScript` uses to know
what a page already holds — so it shows as taken rather than colliding with one
of yours.

| Option | Default | |
| --- | --- | --- |
| `param` | `'datastar'` | Query parameter carrying signals on `GET` and `HEAD` |
| `client` | `false` | Serve the vendored browser runtime and inject its tag |

Register it by hand only when you have switched the default off and want it in a
particular position among your own plugins:

```ts
import { createApp, datastar } from '@erikt/framework'

const app = createApp({ datastar: false }).plugin(datastar())
```

Two things the hook deliberately does not do. It **does not turn bad input into
an error** — it runs on every request, including ones with nothing to do with
Datastar, so unparseable JSON reads as no signals rather than a 500. And it
**does not consume the body**: the request is cloned first, so a handler can
still call `c.req.json()` on the body it was sent.

### Patching back

`defineStream` returns a `Handler`, so it registers like any other — including
as a `GET`/`POST` export in `routes/`:

```ts
import { defineStream, html, readSignals } from '@erikt/framework'

type Counter = { count?: number }

export const POST = defineStream((stream, c) => {
  const { count = 0 } = readSignals<Counter>(c)

  stream.patchSignals({ count: count + 1 })
  stream.patchElements(html`<p id="echo">Counted ${count + 1}.</p>`)
})
```

The response is an SSE stream, and it stays open until the render function
returns. That is the whole difference between a one-shot patch and a live one:

```ts
export const GET = defineStream(async stream => {
  while (!stream.closed) {
    stream.patchElements(html`<time id="clock">${new Date().toISOString()}</time>`)

    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
```

### Reaching the runtime from browser code

With `client` on, the plugin claims an entry in the page's **import map**, so a
`scripts/` module can import the runtime by name — no URL, no global:

```ts
// src/scripts/signals.ts
import { getPath, mergePatch } from 'datastar'

const count = getPath<number>('count') ?? 0

mergePatch({ count: count + 1 })
mergePatch({ stale: null })        // null removes a signal
```

The full surface — sixteen values, typed in `framework/src/datastar-runtime.ts`:

| Signals | |
| --- | --- |
| `mergePatch(patch, { ifMissing })` | Merge into the store, batched. `null` removes a signal |
| `mergePaths(entries, options)` | The same, from `[path, value]` pairs |
| `getPath<T>('a.b')` | Read one signal by dot path, `undefined` when absent |
| `filtered({ include, exclude }, from)` | A plain snapshot, narrowed by path |
| `root` | The live store itself |

| Reactivity | |
| --- | --- |
| `signal(initial)` | Call bare to read, with a value to write |
| `computed(getter)` | A derived read-only value |
| `effect(run)` | Runs now and on change; returns a stop function |
| `beginBatch()` `endBatch()` | Coalesce writes into one notification |
| `startPeeking()` `stopPeeking()` | Read without subscribing |

| Extending it | |
| --- | --- |
| `action(plugin)` | Register an `@name()` action |
| `attribute(plugin)` | Register a `data-*` attribute |
| `watcher(plugin)` | Register a global watcher |
| `actions` | Every registered action, by name |

There is one import map per document — a browser allows no more — so `framework`
owns it and plugins contribute entries. It is emitted **before** every module
script, because a browser ignores a map that arrives after module loading has
begun, and only into a whole document: a fragment is patched into a page that
already has one. Injected head markup lands just before `</head>`, so do not
load modules higher up in your layout's head.

Types come from `@erikt/framework/tsconfig.browser.json` — see *The tsconfig*. At
runtime the bare specifier resolves through the map to the same module instance
the page already loaded, so it is the same signal store.

**This is not Datastar's documented surface.** Its reference covers `data-*`
attributes and the SSE events, so treat a version bump as a place to re-check
these. The signatures come from Datastar's own v1.0.3 source rather than being
inferred. One deliberate simplification: `attribute` plugins are typed loosely,
because Datastar derives which of `key`/`value`/`rx` a plugin receives from its
own `requirement` through conditional types that shift between versions.

To *observe* changes instead, no import is needed: Datastar dispatches a
`datastar-signal-patch` `CustomEvent` on `document`, whose `detail` carries what
changed.

Prefer a `data-on:` expression or a server-sent `patchSignals` where either will
do — the backend driving state is the point of the thing.

### Patching a whole page

Sometimes the simplest answer to "what changed?" is *the page*. `patchPage`
re-renders a route through the app and sends it as one patch, and Datastar
morphs it over `documentElement` — a soft reload that keeps scroll position and
does not re-fetch assets:

```ts
// routes/api/refresh.ts
export const GET = defineStream(async stream => {
  await stream.patchPage()
})
```

With no argument it renders **the page the request came from**, read off
`Referer`. That is what makes one endpoint work from every page: the same button
in your layout refreshes `/` from `/` and `/about` from `/about`. Name a route to
override it — `patchPage('/dashboard')`.

It works because Datastar parses markup containing `</html>` as a whole document
and morphs it over the current one, so the patch carries no `selector` and no
`mode`; the default outer morph is the one that does this.

The render is a real request back through your own app — same routes, same
middleware, same layout — with four headers dropped, each because it would
answer with something other than the page's markup: `Accept-Encoding` (a
compressed body `.text()` cannot decode), `Range`, `If-None-Match` and
`If-Modified-Since` (a 304 with no body at all), and `Datastar-Request` (so a
route that branches on it renders its page form). It carries
`X-Framework-Render: 1`, which is both a signal to your own routes and the guard
that stops a page from patching itself forever.

It refuses, loudly, rather than sending something useless: no `Referer` and no
argument, another origin, a route that answers with something other than HTML,
or a render that is already a render. A stream reports those the way it reports
any throw — by aborting.

**What a full-page morph costs you.** `data-signals` is re-applied as the
document morphs, so a signal declared with a literal default goes back to that
default: `data-signals="{count: 0}"` resets `count` to `0`. That is not a bug to
work around so much as the Datastar model asserting itself — the server owns the
state, so render the current value into the attribute rather than a literal.
Signals the server never writes are better off `_`-prefixed and local.

Reach for it when a change touches several parts of a page at once, or when one
endpoint serves pages that differ. A targeted `patchElements` is cheaper and
does not disturb anything else.

`useScript` works inside a stream: with no document to render, the tag is
appended to the `<head>` of the one already on screen as an element patch. See
*Where the tag lands* under *Plugin: scripts*.

| Method | |
| --- | --- |
| `patchElements(elements, options?)` | Morph markup into the page |
| `patchSignals(signals, options?)` | Merge values into the client's signals. `null` removes one |
| `removeElements(selector)` | Shorthand for a `remove`-mode patch |
| `patchPage(target?)` | Re-render a whole page and morph it in. `await`s |
| `event(name, lines)` | Raw event, for anything the helpers do not cover |
| `close()` | End the stream early |
| `closed` | `true` once it has ended, or the client has gone away |

`patchElements` takes `selector`, `mode`, `namespace`, `useViewTransition` and
`viewTransitionSelector`; the modes are `outer` (the default), `inner`,
`replace`, `prepend`, `append`, `before`, `after` and `remove`. `patchSignals`
takes `onlyIfMissing`. Markup is emitted one `data:` line per line, so the `html`
helper's multi-line template literals go over the wire unchanged — and escape
their interpolations on the way.

Three consequences of streaming, all of them load-bearing:

- **`onError` never sees a failure here.** The status line is already on the
  wire by the time the render function runs, so a throw can only abort the
  stream, not become a 500. Report failures the Datastar way — patch an error
  element or an error signal.
- **`compress` leaves these responses alone**, because they are sent with
  `Cache-Control: no-transform`. That middleware peeks up to its threshold
  before deciding whether to compress, which would hold back the first events of
  a live stream until enough bytes had piled up.
- **A dropped connection sets `closed`**, from the request's `AbortSignal` as
  well as from stream cancellation. A loop that does not check it will run
  forever after the client has gone.

[datastar]: https://data-star.dev

## Plugin: scripts

Browser JavaScript from a folder, with no bundler. Every `.ts` and `.js` file in
the folder is read once at startup, stripped of its types, hashed by content and
served at a URL carrying that hash. A page, an endpoint or a stream then declares which of them it needs,
and gets a `<script>` tag for those and no others.

**Off by default.** It needs a store that can `read`:

```ts
import { createApp, scripts } from '@erikt/framework'
import { nodeStore } from '@erikt/framework-node'

const store = nodeStore(new URL('./', import.meta.url))

const app = createApp().plugin(scripts({ store, dir: 'scripts' }))
```

| Option | Default | |
| --- | --- | --- |
| `store` | — | Required. A `FileStore` with `read` |
| `dir` | `'scripts'` | Folder to read, relative to the store's root |
| `base` | the value of `dir` | URL prefix the scripts are served under |
| `extensions` | `['.ts', '.js']` | Which files count |

### Declaring a dependency

`useScript(c, ...names)` is how a route says what it needs. Nothing is injected
unless something asked for it:

```ts
import { defineRoute, html, useScript } from '@erikt/framework'

export const GET = defineRoute(c => {
  useScript(c, 'json-routes')

  return html`<button data-url="/api/time">GET /api/time</button>`
})
```

`src/scripts/json-routes.ts` then becomes
`<script type="module" src="/scripts/json-routes.3f9a1c0e.js"></script>` in that
page's `<head>` — and only that page's.

A name is the file's path under `dir` without its extension, so
`scripts/widgets/menu.ts` is `'widgets/menu'`. An extension or a leading `/` or
`./` is accepted too, in case that reads better where you call it.

Anything holding the context can call it, which is the point: a **component**
that renders a fragment declares its own dependency, and asking twice still
injects one tag.

```ts
const menu = (c: Context) => {
  useScript(c, 'widgets/menu')

  return html`<nav>…</nav>`
}
```

Want one script on every page? Ask for it in the **layout** — it runs for every
page, so there is no separate option for it:

```ts
export const layout = defineLayout((content, c) => {
  useScript(c, 'analytics')

  return html`<!doctype html>…`
})
```

Tags come out in the order they were asked for. A name that does not exist
still gets a tag, at an unhashed `/scripts/<name>.js` that nothing serves — the
page renders as it would otherwise, and the browser reports one 404 naming the
file it could not load. A deleted or misspelt script costs you that script, not
the page. It is not skipped silently either: the 404 is the signal, so keep an
eye on the console when a script does not seem to run.

Calling `useScript` with the plugin unregistered does still throw — that is a
misconfigured app rather than a missing file.

### Where the tag lands

The same `useScript` call, three different destinations, decided by what is
rendering:

These are the destinations for a `useStyle` `<link>` too — both fill the same
per-request queue.

| Rendered by | The tag goes |
| --- | --- |
| `defineRoute` that asked for a layout | into the document's `<head>` |
| `defineRoute` that did not | appended to the fragment, so a partial carries its own script |
| `defineStream` | appended to the `<head>` of the document already on screen, as a Datastar patch |

A handler that renders no markup at all — a bare `c.body`, or a `defineRoute`
that returned text or data — has nowhere to put one, and `useScript` there does
nothing.

There is deliberately no way to make an **endpoint** target the head. One HTTP
response is one body with one target; addressing the fragment and the head at
once is two destinations, so it needs two events. Use `defineStream` — see
*Endpoints* under *Pages and layouts*.

A stream has no document of its own to render, so it sends the tag as an
element patch instead:

```ts
export const GET = defineStream((stream, c) => {
  useScript(c, 'panel')

  stream.patchElements(html`<div id="panel">open</div>`)
})
```

```
event: datastar-patch-elements
data: elements <div id="panel">open</div>

event: datastar-patch-elements
data: selector head
data: mode append
data: elements <script type="module" id="asset-scripts-panel-212a66bf-js" src="/scripts/panel.212a66bf.js"></script>
```

The head patch is sent **after** the events that were already queued when you
asked, so a script arrives once the markup it came with is in the DOM. A stream
that asks and then sends nothing still gets it, at close. Each script goes out
once per request however many events follow, and asking again later in the same
stream sends only the new one.

#### It will not append what is already there

A stream is *told* what the page already holds rather than asking the DOM. Every
tag carries an `id` derived from its URL, a document seeds those ids into a
`headAssets` signal, and Datastar sends signals back with every request — so the
stream knows what to skip:

```html
<meta name="framework-head-assets" data-signals="{&quot;headAssets&quot;:{&quot;asset-styles-0632c4bd444c-css&quot;:true}}" />
```

Whatever a stream *does* send is recorded back into the same signal:

```
event: datastar-patch-elements
data: selector head
data: mode append
data: elements <script type="module" id="asset-scripts-panel-212a66bf-js" src="…"></script>

event: datastar-patch-signals
data: signals {"headAssets":{"asset-scripts-panel-212a66bf-js":true}}
```

So a page that already loaded an asset does not get a second tag, and clicking a
button twice appends once — the second request arrives carrying the id.

**Why not just check the DOM?** Because Datastar cannot express "insert if
missing" in one patch. A guard like `selector head:not(:has(#id))` skips
correctly, but when the selector matches nothing Datastar logs
`PatchElementsNoTargetsFound` — so every correct skip would print a console
warning. Targeting `#id` with `mode outer` inverts the problem: it dedupes when
the asset is present and fails to insert when it is absent, which is the case
that matters. Carrying the answer in a signal is the only version that is both
silent and right, and it is what Datastar's own model suggests: the backend is
told the state and decides.

The cost is one small `<meta>` in the head of any document that asked for an
asset, plus those ids on Datastar requests from that page. If you have no
Datastar client on the page the meta is inert.

Within a single request no signal is needed: the head queue is keyed by that id,
so two components asking for the same asset produce one tag.

Finally, every script in the folder is **served** whether or not anything asks
for it; declaring only decides who gets a tag.

### Writing markup in browser code

The same `html``` a route is written with is served to the browser, under
`@erikt/framework/html`:

```ts
// src/scripts/menu.ts
import { html } from '@erikt/framework/html'

class Menu extends HTMLElement {
  connectedCallback() {
    this.innerHTML = html`<button>${this.getAttribute('label') ?? 'Open'}</button>`
  }
}
```

It escapes what you interpolate, which a bare template literal assigned to
`innerHTML` does not — the difference between a label and an injection.

The entry is claimed **only when a script the page actually loads imports it**,
so a page with no browser code carries no import map at all. Types come from
`@erikt/framework/tsconfig.browser.json`; see *The tsconfig*.

What is served is derived from `helpers/html.ts` by `stripTypes`, never written
beside it — `framework` cannot read its own files at runtime, so the browser
build is carried as a string, and a test re-derives it and fails if the two
drift.

### What it does to a file

`.ts` (and `.tsx`, `.mts`, `.cts`) go through `stripTypes`; `.js` and `.mjs` are
served byte-for-byte. That split is deliberate and matches Node: a `.js` file is
already browser JavaScript, and running a TypeScript lexer over it would put an
expression like `a < b > (c)` at risk of being read as type arguments.

`stripTypes` erases in place — every character it removes becomes a space, and
newlines are kept — so the output is the same length as the input and every
surviving character keeps its offset. A stack trace in the browser points at the
right line *and* column of the original `.ts` file, with no source map. What it
refuses is anything that would need code generated: `enum`, `namespace`,
parameter properties, `import x = require()`. Those throw **at startup**, naming
the file and the line, rather than shipping something broken.

`stripTypes` is exported too, if you want it for something else.

### Hashing and caching

The URL carries the first eight hex digits of a SHA-256 of the *stripped* code,
so it changes exactly when the served bytes do. That makes the response safe to
freeze, and it is sent with `Cache-Control: public, max-age=31536000, immutable`.

The consequence is that **editing a script needs a restart**: the listing, the
hashes and the routes are all built in `setup`, and there is no route removal to
rebuild them onto. Same as `fileRouter`.

### Typechecking browser code

A folder of browser code inside a Node package needs its own `tsconfig.json` —
`lib: ["DOM"]` and `types: []`, rather than the Node types the rest of the
package is checked against. `packages/example` does exactly that, in
`src/scripts/tsconfig.json`, and excludes `src/scripts` from its main config.
`exclude` is safe there for once: nothing ever *imports* these files, so
TypeScript has no way to pull them into the other config.

## Plugin: styles

CSS written next to the markup it styles, with no build step. A `css``` block is
hashed by its content, served as its own stylesheet, and linked from the pages
that ask for it — `useScript`'s counterpart.

```ts
import { css, defineRoute, html, useStyle } from '@erikt/framework'

const styles = css`
  .card {
    border: 1px solid currentColor;
    border-radius: 0.5rem;
  }
`

export const GET = defineRoute(c => {
  useStyle(c, styles)

  return html`<div class="card">…</div>`
})
```

```html
<link rel="stylesheet" href="/styles/0632c4bd444c.css" />
```

Register it once:

```ts
const app = createApp().plugin(styles())
```

| Option | Default | |
| --- | --- | --- |
| `base` | `'styles'` | URL prefix the stylesheets are served under |

### How it differs from scripts

`scripts` reads files from a store at startup. A `css``` block is written
*inline*, and evaluated when its module is — so the two are built differently in
three ways worth knowing:

- **The hash is FNV-1a, not SHA-256.** `css``` is called while a module is being
  evaluated and has to hand back a usable hash there and then, and
  `crypto.subtle` is async. It is a cache key, not a signature: 48 bits tells a
  handful of stylesheets apart and none of it is security.
- **One route serves every stylesheet.** `/styles/:hash.css` looks the hash up
  in a registry that `css``` fills as modules load, so nothing needs registering
  as blocks are discovered — and a stylesheet is reachable at its URL even
  before a page has asked for it, which is what stops a cached page from
  breaking after a restart.
- **Identical CSS is one stylesheet.** Blocks are keyed by their text, so the
  same rules written in two components hash once, link once and are served once.
  Surrounding whitespace is trimmed first, so indentation does not fork it.

### Interpolation, and what not to put in it

`${…}` is substituted into the text, which makes composing and sharing constants
work:

```ts
const brand = '#663399'

const button = css`
  .button { background: ${brand}; }
`
```

But the text is the cache key, so **a value that varies per request mints a new
stylesheet every time** and the registry grows without bound. Interpolate
build-time constants, not request data. For anything that genuinely varies per
request, set a CSS custom property inline on the element and read it in the
block — which is the better CSS answer anyway:

```ts
html`<div class="bar" style="--fill: ${percent}%">…</div>`
```

For the same reason, and because the result is served as a static file, `css```
does **not** escape what you interpolate the way `html``` does. It is authored
content; do not feed it user input.

### Where the link lands

Exactly where a `useScript` tag does — see *Where the tag lands* — because both
fill the same per-request queue: the `<head>` of a document, appended to the
fragment of an endpoint, and patched into the live head from a stream. Asking
twice, or from two components, yields one `<link>`, and a stream will not append
a stylesheet the page already has.

Plugin injections come first in the head, then whatever the page asked for in
the order it asked, so a runtime lands ahead of the assets that use it.

## Pages and layouts

`defineRoute` marks a handler as an HTML page. Call `useLayout` inside it and
the render is wrapped before it is served — the page returns a fragment, the
layout returns the document. There is no app-wide default: a route that does not
ask for a layout answers with its markup as-is, which is what a fragment wants.

```ts
// layout.ts
import { defineLayout, html } from '@erikt/framework'

export const layout = defineLayout(
  (content, c) => html`<!doctype html>
    <html lang="en">
      <head>
        <title>${c.get<string>('title') ?? 'my-app'}</title>
      </head>
      <body>
        ${content}
      </body>
    </html>`,
)
```

```ts
// routes/index.ts
import { defineRoute, html, useLayout } from '@erikt/framework'

import { layout } from '../layout.ts'

export const GET = defineRoute(c => {
  c.set('title', 'Home')
  useLayout(c, layout)

  return html`<h1>Home</h1>`
})
```

```ts
// main.ts
const app = createApp().plugin(fileRouter({ store, dir: 'routes' }))
```

```html
<!doctype html>
<html lang="en">
  <head>
    <title>Home</title>
  </head>
  <body>
    <h1>Home</h1>
  </body>
</html>
```

| | |
| --- | --- |
| `defineRoute(render)` | `render(c)` returns the route's markup, or an object to serve as JSON. Returns a `Handler`, so it works anywhere a handler does |
| `useLayout(c, layout)` | Wrap this response in `layout`. Without it the render is served as-is |
| `defineErrorPage(render)` | A page for `onError`. `render(error, c)` — the error comes first |
| `defineLayout(layout)` | `layout(content, c)` returns the document. Only there to infer the argument types — a plain function typed as `Layout` is the same thing |

There is no `title` option, on purpose: page metadata rides on the context bag,
so a page sets whatever a layout wants to read and the framework stays out of
it. Declare those keys on `ContextBag` — see *The context bag is typed* — and
both ends are checked.

Both may be `async`. The response is `text/html`, and `c.status`, `c.header` and
`c.set` called inside a page all still apply — so a page can be a 404:

```ts
app.notFound(defineRoute(c => {
  c.status(404)

  return html`<h1>Not found: ${c.url.pathname}</h1>`
}))
```

### Data

Return an object instead of markup and the route answers with JSON:

```ts
// routes/api/users/[id].ts
export const GET = defineRoute(c => ({ id: c.params.id, name: 'ada' }))
```

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8

{"id":"42","name":"ada"}
```

A string is markup and anything else is data — `html` returns a string, so a
page is a page. Arrays count as data, and so does an object from a database
layer; `c.status`, `c.header` and `c.set` apply either way:

```ts
export const POST = defineRoute(async c => {
  c.status(201)

  return await save(await c.req.json())
})
```

Nothing else touches a data response: no layout wraps it and no plugin injects
into it, because there is no markup to put anything in. A route that calls
`useLayout` and then returns data still answers with JSON — what it returned is
what it meant.

### Fragments

A route that is answering with a **fragment** — a panel fetched on demand, a row
appended to a table, a partial re-render — simply does not ask for a layout:

```ts
// routes/api/panel.ts
export const GET = defineRoute(c => {
  useScript(c, 'panel')

  return html`<div id="panel">open</div>`
})
```

```html
<div id="panel">open</div><script type="module" src="/scripts/panel.212a66bf.js"></script>
```

That last part is the point. In a document, `useScript` puts its tag in the
layout's `<head>`; a fragment has no `<head>`, so the tag is **appended to the
markup** and travels with it. The fragment stays self-contained: whatever
inserts it gets the script along with it.

The layout is read **after** the render, so a route — or a component it called —
can decide partway through, and the last `useLayout` wins:

```ts
useLayout(c, bareShell)
```
 Everything else is unchanged: `c.status`,
`c.header` and `c.set` apply, `html` escapes interpolations, and the result is a
`Handler`, so it registers through `app.get`, `fileRouter` or anything else.

#### Want the tag in the head instead? Use a stream

There is no option for it, and that is a structural limit rather than a gap. An
endpoint's response is **one body with one target** — even Datastar's
`datastar-selector` / `datastar-mode` headers describe the response as a whole.
Putting the fragment in `#panel` *and* a tag in `head` is two destinations, and
two destinations need two events. That is SSE, which is `defineStream`:

```ts
export const GET = defineStream((stream, c) => {
  useScript(c, 'panel')

  stream.patchElements(html`<div id="panel">open</div>`)
})
```

One wrapper and `stream.patchElements(…)` in place of `return`, and the tag is
appended to the live document's `<head>` — see *Where the tag lands* under
*Plugin: scripts*. Reach for it when you want the head specifically, when the
same script backs several fragments and you would rather not re-send the tag
with each one, or the moment a response needs to touch more than one place.

Otherwise stay with `defineRoute`. Its tag riding along in the fragment is
the feature, not a compromise: the markup is self-contained, and it is a plain
`text/html` response that anything can consume.

### Where the wrapping happens

At **registration**, not per request, and `fileRouter` registers through the same
`app.on` as everything else. So file routes, `app.get` and `app.notFound` all get
layouts without any of them knowing that layouts exist. Consequences:

- **A handler that is not a `defineRoute` is never touched.**
  A `c.body(…)` returns exactly what it was given. Only markup that a
  `defineRoute` rendered is rewritten — text or data it returned is not.
- **A page with no layout serves its fragment**, unwrapped. The same page is
  reusable across apps that wrap it differently. It still collects its
  `injectHTML` markup, appended — a layout-less page and an endpoint behave the
  same way here, which is what keeps `useScript` from silently doing nothing.
- **A thrown error reaches the layout only through `defineErrorPage`.** A plain
  `onError` handler builds its own response and is left alone — see *Error pages*
  below.

### Error pages and 404s

They are different hooks, and the difference catches people out: a URL that
matches no route **does not throw**, so `onError` never sees it. `notFound` is
the one you want for a 404, and it runs a `defineRoute` through the layout like
any other route:

```ts
// not-found.ts
export default defineRoute(c => {
  c.status(404)

  return html`<h1>Nothing here</h1>`
})
```

```ts
app.notFound(NotFound)
```

Set the status yourself: `defineRoute` builds the response, which answers 200
unless the page says otherwise.

`onError` is for a handler or middleware that actually threw. `defineErrorPage`
is its page form, and it takes **the error first**:

```ts
// error.ts
export default defineErrorPage((error, c) => {
  c.set('title', 'Something went wrong')

  return html`<p>${error instanceof Error ? error.message : String(error)}</p>`
})
```

```ts
app.onError(ErrorPage)
```

Three things it does that a plain handler does not:

- **It is wrapped in the layout** and collects `injectHTML` markup, so an error
  page looks like the rest of the site.
- **It keeps a status the failing handler chose.** `c.status(401)` followed by
  a throw still answers 401; only an untouched default becomes a 500. So a
  handler can reject by setting a status and throwing, and the page can read it
  back with `c.status()`:

  ```ts
  export const GET = defineRoute(c => {
    c.status(401)

    throw new Error('not signed in')
  })
  ```

  ```ts
  export default defineErrorPage((error, c) => html`<h1>${String(c.status())}</h1>`)
  ```

  `c.status` inside the render still wins over both.
- **It falls back to a plain 500 if it throws itself** — most likely from the
  layout, which is exactly when a second throw would escape and lose the
  response altogether.

A plain `app.onError((error, c) => …)` is untouched by all of this: it builds its
own response, so nothing is wrapped and no status is assumed.

`html` escapes what you interpolate, so putting `error.message` on the page
cannot inject markup. Whether to show it at all is a different question — an
example can, a public app should not.

### On escaping

`html` escapes every interpolated value and nothing else — the template itself is
trusted, the values are not:

```ts
html`<h1>${'<script>'}</h1>`   // <h1>&lt;script&gt;</h1>
```

What it returns is marked as already-escaped, which is what lets a layout
interpolate a page without double-escaping it, and lets pages nest:

```ts
html`<ul>${items.map(item => html`<li>${item.name}</li>`)}</ul>`
```

Arrays are joined, `null` and `undefined` become `''`. The value is a `String`
object rather than a primitive — that marking *is* the object — so `typeof` is
`'object'`, and a test comparing it to a literal needs `String()` around it.
Anything that takes a string, including `Response`, treats it as one.

## File-based routing

`fileRouter` turns a tree of route files into registered routes. It is a plugin,
so it registers during `setup` — before the first request, since `app.fetch`
awaits `start()`.

It reads through a **`FileStore`** (below), never through a filesystem, because
the Minimum Common API has none. The plugin does only the portable half: path →
pattern, ordering, and registration.

```ts
import { createApp, fileRouter } from '@erikt/framework'
import { nodeStore } from '@erikt/framework-node'

const app = createApp()
const store = nodeStore(new URL('./', import.meta.url))

app.plugin(fileRouter({ store, dir: 'routes' }))
```

```ts
// routes/users/[id].ts
import { defineRoute } from '@erikt/framework'

export const GET = defineRoute(c => ({ id: c.params.id }))
export const POST = defineRoute(c => {
  c.status(201)

  return 'saved'
})
```

| Option | Default | |
| --- | --- | --- |
| `store` | — | Required. Must be able to `import`; the plugin says so, and how to fix it, if not |
| `dir` | `''` | The subtree to route. Patterns are derived from paths relative to it |
| `extensions` | `MODULE_EXTENSIONS` | `.ts` `.tsx` `.mts` `.js` `.jsx` `.mjs`. `.d.ts` is never a route |

### Paths

| File under `dir` | Pattern | |
| --- | --- | --- |
| `index.ts` | `/` | |
| `about.ts` | `/about` | |
| `blog/index.ts` | `/blog` | Same as `blog.ts` — using both is an error |
| `users/[id].ts` | `/users/:id` | One segment, named `id` |
| `posts/[[page]].ts` | `/posts{/:page}?` | Optional — matches `/posts` too |
| `files/[...rest].ts` | `/files{/:rest}*` | The remaining segments as one group; matches `/files` too |
| `(marketing)/pricing.ts` | `/pricing` | A parenthesised directory groups files without adding a segment |
| `_helper.ts`, `_lib/…` | — | Not routed. Dotfiles are skipped too |

The trailing extension is stripped from the filename, so `logo.png.ts` serves
`/logo.png`. Characters that mean something to `URLPattern` are escaped in
literal segments, so a filename cannot smuggle in pattern syntax.

### Order

Registration order is match priority, and a directory listing has none, so the
plugin sorts: **literal → `[param]` → `[[optional]]` → `[...catch-all]`** at the
first segment where two paths differ, then the shorter path, then the path
itself. `users/me.ts` therefore wins over `users/[id].ts` no matter which order
the store lists them in, and the result never depends on the filesystem.

### Exports

| Export | |
| --- | --- |
| `GET` `POST` `PUT` `PATCH` `DELETE` `OPTIONS` `HEAD` `ALL` | A handler for that method — a `defineRoute` is one, and gets the app's layout |
| `default` | A handler for **every** method. A method export in the same file wins over it |
| `pattern` | Overrides the derived pattern — a `string` or `URLPatternInit`, escape hatch for a route the conventions cannot spell |
| `use` | Middleware scoped to this route's pattern. It runs inside `compress`, like any middleware you register yourself |

These all throw from `start()`, naming the file, rather than becoming a route
that fails later: a file that exports none of the above, an export that is not a
function, two files claiming the same method and pattern, a `[...catch-all]` that
is not the last segment, and a parameter name that is not an identifier.

## FileStore

`framework` cannot read a directory — the Minimum Common API has no filesystem —
so it defines the port and an adapter implements it. One store serves every
file-reading feature; each one scopes itself with `dir`. Writing one for a new runtime is
documented in [ADAPTERS.md](../../ADAPTERS.md).

```ts
type FileEntry = { path: string; size?: number; modified?: number }
type ListOptions = { prefix?: string; extensions?: readonly string[] }

type FileStore = {
  name: string
  list(options?: ListOptions): Promise<readonly FileEntry[]>
  read?(path: string): Promise<Response | null>
  import?(path: string): Promise<unknown>
}
```

Three capabilities, two of them optional — a store advertises what it can do by
having the method, and a feature that needs a missing one fails at `start()` with
a message naming the store and the way out. That split is not cosmetic: it is the
difference between runtimes.

| | `list` | `import` | `read` |
| --- | --- | --- | --- |
| Node, Deno, Bun | walk the directory | dynamic import | the filesystem |
| Vercel (Node functions) | walk — but the bundler traces only static references, so route files need `includeFiles` or a baked store | dynamic import | the filesystem |
| Workers, Vercel Edge, browsers | **baked at build time** — there is nothing to walk | a static import map | the platform's asset binding |

`read` returns a **`Response`**, not bytes, because every runtime's asset story
is already fetch-shaped — `env.ASSETS.fetch()`, `new Response(Bun.file(p))`,
`new Response(file.readable)`. Content type, `ETag` and streaming therefore come
from the store for free, and no new vocabulary enters `framework`. `null` means
absent, so the consumer picks the status; conditional requests and ranges belong
in middleware here, written once for every runtime, rather than in each adapter.

`list` returns an array rather than an `AsyncIterable`: a feature that sorts —
which the router must — needs the whole set anyway, and an array is one line to
implement.

### The path contract

What makes two stores interchangeable. `listFiles` enforces it, so a store that
breaks it fails loudly instead of producing a subtly wrong route:

- relative, `/`-separated, no leading `/`, no `.` or `..` segment, no backslash
- **NFC-normalized.** macOS reports `café.ts` decomposed and Linux reports it as
  written; without normalizing, one file is two routes depending on where the
  store runs
- case is preserved and significant — the listing is the truth, and a
  case-insensitive filesystem will happily disagree with production Linux
- the order `list` returns is meaningless; consumers sort

```ts
listFiles(store, { prefix: 'routes', extensions: ['.ts'] })
```

Feature authors should use `listFiles` rather than `store.list` directly. It
normalizes, sorts, de-duplicates, and **re-applies the filters** — so the
cheapest correct store is one that ignores `ListOptions` and returns everything.

### staticStore

The in-package store, for anywhere there is no directory to walk:

```ts
import { fileRouter, staticStore } from '@erikt/framework'

const store = staticStore({
  'routes/index.ts': () => import('./routes/index.ts'),
  'routes/users/[id].ts': { import: () => import('./routes/users/[id].ts') },
  'public/logo.svg': { size: 1024 },
})
```

A function value is shorthand for `{ import }`. An entry with no `import` is
listable but not importable — which is what a store of assets looks like.

### withRead

Composes a store's listing with someone else's bytes. This is the Workers shape:
the listing is baked, the bytes come from the assets binding.

```ts
import { withRead } from '@erikt/framework'
import { store as baked } from './generated-store.ts'

const store = withRead(baked, async path => {
  const response = await env.ASSETS.fetch(new Request(`https://assets/${path}`))

  return response.status === 404 ? null : response
})
```

### generateStore

Baking the listing is a deploy-time job, and `framework` has no filesystem, so it
provides the **pure** half: entries in, TypeScript source out. Node, Deno or Bun
runs it and writes the file; the bundled runtime imports the result.

```ts
import { generateStore } from '@erikt/framework'
import { nodeStore } from '@erikt/framework-node'
import { writeFile } from 'node:fs/promises'

const entries = await nodeStore('src').list({ prefix: 'routes/' })

await writeFile('src/generated-store.ts', generateStore(entries, { base: './' }))
```

| Option | Default | |
| --- | --- | --- |
| `base` | `'./'` | Specifier prefix for the emitted imports. A relative path, an absolute path, or a URL — a bare specifier is rejected |
| `specifier` | `'framework'` | Where the generated file imports `staticStore` from |
| `modules` | `MODULE_EXTENSIONS` | Which entries get an `import` thunk; the rest are listed only |
| `name`, `exportName` | `'generated'`, `'store'` | |

The output is sorted by path and carries `size` but never `modified`: a timestamp
would rewrite the file on every build. Same input, same bytes — so it is safe to
commit and to diff.

## Router

`createRouter` matches a URL against a manifest of registered URLs and URL
patterns, using the platform's [`URLPattern`][urlpattern] API.

```ts
import { createRouter } from '@erikt/framework'

const router = createRouter([
  { name: 'home', pattern: '/' },
  { name: 'user', pattern: '/users/:id' },
  { name: 'assets', pattern: '/assets/*' },
  { name: 'about', pattern: 'https://example.com/about' },
  { name: 'tenant', pattern: { hostname: ':tenant.example.com', pathname: '/dashboard' } },
])

router.match('/users/42')?.params.id        // '42'
router.match('/assets/img/logo.svg')?.params['0']  // 'img/logo.svg'
router.match(new Request('https://example.com/about'))?.route.name  // 'about'
```

### Patterns

A `pattern` is either a string or a `URLPatternInit`:

| Form | Matched against |
| --- | --- |
| `'/users/:id'` | The pathname only — any protocol, any host. |
| `'https://example.com/about'` | The whole URL. Patterns work here too: `'https://:tenant.example.com/*'`. |
| `{ hostname, pathname, search, … }` | Exactly the components you name. |

Strings are treated as whole-URL patterns when they contain `://`, and as
pathname patterns otherwise. Pattern syntax — `:named` groups, `*` wildcards,
`{}` groups, `?` optional, regex groups — is `URLPattern`'s, not ours.

### Matching

`match` returns the **first** matching route in manifest order, so register
specific routes before catch-alls. `matchAll` returns every match; `test`
returns a boolean.

A match carries:

- `route` — the manifest entry, including its `data` payload
- `params` — named groups and wildcard indices, merged across components
- `result` — the raw `URLPatternResult`, when per-component groups matter
- `url` — the resolved `URL`

`params` omits groups from components the manifest never specified, since
`URLPattern` fills those with `*` and they capture nothing meaningful.

### Options

```ts
createRouter(manifest, {
  base: 'https://api.example.com/v1/',  // resolves relative input; default 'http://localhost/'
  ignoreCase: true,                      // passed through to URLPattern
})
```

### Errors

Patterns compile when the router is built, not on first match, so an invalid
pattern throws a `TypeError` up front. Duplicate route names throw too.

### Typed payloads

```ts
type Page = { title: string }

const router = createRouter<Page>([{ pattern: '/', data: { title: 'Home' } }])

router.match('/')?.route.data?.title  // string | undefined
```

## Availability

`URLPattern` is Baseline 2025 — available in current browsers, Node 24+, Deno,
Bun and Workers, but not in older runtimes. A polyfill exists; adding it would
mean taking a dependency, which this package does not do.

[urlpattern]: https://developer.mozilla.org/en-US/docs/Web/API/URLPattern
