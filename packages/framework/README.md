# framework

Runtime-agnostic building blocks, built on web platform APIs only. No
dependencies, no Node.js.

- **Server** — a `Request` → `Response` handler with routing and middleware.
- **compress** — response compression via `CompressionStream`.
- **Plugins** — lifecycle, per-request and HTML-injection hooks, plus a built-in
  startup banner and request logger.
- **scripts** — browser TypeScript from a folder, type-stripped, content-hashed
  and injected into the pages that declare they need it.
- **datastar** — signals off the request, element and signal patches back over
  SSE. On by default.
- **definePage** — an HTML page, wrapped in your layout automatically, and
  **defineEndpoint** for a fragment that is not.
- **fileRouter** — routes from a tree of files, read through a `FileStore`.
- **FileStore** — the file-reading port: one interface, one adapter per runtime.
- **Router** — URL matching on top of `URLPattern`.

## Server

`createApp` builds a web server as a single `fetch` handler: `Request` in,
`Response` out. Inspired by [Hono][hono], and deliberately a subset of it.

```ts
import { createApp } from 'framework'

const app = createApp()

app.use(async (c, next) => {
  const response = await next()

  response.headers.set('x-response-time', 'fast')

  return response
})

app.get('/', c => c.text('hello'))
app.get('/users/:id', c => c.json({ id: c.params.id }))
app.post('/users', async c => c.json(await c.req.json(), 201))

const response = await app.fetch(new Request('http://localhost/users/42'))
```

There is no `listen`. `app.fetch` *is* the server, which is what makes it
portable: it is already the entry shape Deno, Bun and Workers expect.

```ts
export default app          // Deno, Bun, Cloudflare Workers
```

Running it on Node needs an adapter to bridge `node:http` to `Request`/
`Response`. That is `node-adapter` — `framework` itself never imports `node:*`.

```ts
import { serve } from 'node-adapter'

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
| `c.text` `c.json` `c.html` `c.body` `c.redirect` | Response helpers |
| `c.header(name, value)` `c.status(code)` | Applied to the response the helpers build |
| `c.set(key, value)` `c.get(key)` | Per-request state, for passing data from middleware. Typed — see below |

Helpers take a status or a `ResponseInit` as their second argument:
`c.json(value, 201)` or `c.text('no', { status: 401, headers: { … } })`. An
explicit `content-type` always beats the helper's default.

#### The context bag is typed

`c.set` and `c.get` are keyed by an interface, `ContextBag`. Declare your keys
once and the editor suggests them, `c.get` comes back typed, and a wrong value
is a compile error:

```ts
// bag.ts — types only, nothing to import at runtime
import type {} from 'framework'

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

The framework declares the keys its own plugins use — `logger:started`,
`datastar:signals`, `scripts:registry`, `scripts:used`, `scripts:taken` — so
they show up as taken rather than colliding with one of yours by accident.
Reading them is fine; writing them is your own foot. `datastar:signals` has
`readSignals(c)` in front of it, which is the supported way in.

### Middleware

```ts
app.use(async (c, next) => {          // every request
  return next()
})

app.use('/admin/*', async (c, next) => {   // scoped by pattern
  if (c.req.headers.get('authorization') === null) return c.text('unauthorized', 401)

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
app.notFound(c => c.json({ missing: c.url.pathname }, 404))
app.onError((error, c) => c.json({ error: String(error) }, 500))
```

Defaults are a plain-text 404 and a plain-text 500. `onError` catches throws from
handlers and middleware alike.

[hono]: https://hono.dev/

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
import { compress, createApp } from 'framework'

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
import { createApp } from 'framework'

app.plugin({
  name: 'request-id',

  setup(app) {
    app.get('/healthz', c => c.text('ok'))
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
only where a `definePage` route is wrapped in a `createApp({ layout })` — see
*Pages and layouts* — so a JSON route, a raw `c.html()` and a Datastar patch are
never rewritten:

```ts
app.plugin({
  name: 'analytics',
  injectHTML: (c, target) => ({
    head: '<script src="/analytics.js"></script>',
    body: `<!-- rendered ${c.url.pathname} -->`,
  }),
})
```

`target` is `'document'` when a page is being wrapped in a layout and
`'fragment'` for an endpoint or a layout-less page. Check it whenever what you
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
before startup finishes. `node-adapter`'s `serve` calls it with the bound URL.

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
import { banner, createApp } from 'framework'

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
import { createApp, logger } from 'framework'

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

## Plugin: datastar

Server-driven UI over [Datastar][datastar]. The plugin reads the signals the
browser sends and puts them on the context; `defineStream` is how a route
answers, by patching elements and signals back.

**On by default** — see *Defaults* above, including what it costs an app that
does not use it. Switch on `client` and the browser runtime is served and
wired up too, so there is nothing to add to your layout:

```ts
const app = createApp({ layout, datastar: { client: true } })
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
import { DATASTAR_CLIENT, DATASTAR_VERSION } from 'framework'

app.get('/vendor/datastar.js', c => c.body(DATASTAR_CLIENT, { headers: { … } }))
```

To take a newer Datastar, replace that file: the header carries the source URL
and the two commands that regenerate it.

### Reading signals

Datastar sends every signal that does not start with `_` on every request: in
the `datastar` query parameter on `GET`, in a JSON body on everything else. The
plugin's `onRequest` hook parses both and stores the result on the context bag,
where `readSignals` picks it up:

```ts
import { readSignals } from 'framework'
import type { Context } from 'framework'

type Search = { query?: string }

export const POST = (c: Context) => c.json(readSignals<Search>(c))
```

`readSignals` returns `{}` when there are no signals, so it never returns
`undefined`. The type parameter is a claim about a payload the client controls,
not a guarantee — validate anything you are going to trust.

| Option | Default | |
| --- | --- | --- |
| `param` | `'datastar'` | Query parameter carrying signals on `GET` and `HEAD` |
| `client` | `false` | Serve the vendored browser runtime and inject its tag |

Register it by hand only when you have switched the default off and want it in a
particular position among your own plugins:

```ts
import { createApp, datastar } from 'framework'

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
import { defineStream, html, readSignals } from 'framework'

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

`useScript` works inside a stream: with no document to render, the tag is
appended to the `<head>` of the one already on screen as an element patch. See
*Where the tag lands* under *Plugin: scripts*.

| Method | |
| --- | --- |
| `patchElements(elements, options?)` | Morph markup into the page |
| `patchSignals(signals, options?)` | Merge values into the client's signals. `null` removes one |
| `removeElements(selector)` | Shorthand for a `remove`-mode patch |
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
import { createApp, scripts } from 'framework'
import { nodeStore } from 'node-adapter'

const store = nodeStore(new URL('./', import.meta.url))

const app = createApp({ layout }).plugin(scripts({ store, dir: 'scripts' }))
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
import { definePage, html, useScript } from 'framework'

export const GET = definePage(c => {
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
**throws**, naming what is available — a typo is a 500 you see immediately
rather than a script that silently never loads. So does calling `useScript` with
the plugin unregistered.

### Where the tag lands

The same `useScript` call, three different destinations, decided by what is
rendering:

| Rendered by | The tag goes |
| --- | --- |
| `definePage` with a layout | into the document's `<head>` |
| `defineEndpoint`, or a page with no layout | appended to the fragment, so a partial carries its own script |
| `defineStream` | appended to the `<head>` of the document already on screen, as a Datastar patch |

A handler that renders no markup at all — `c.json`, or a bare `c.html` — has
nowhere to put one, and `useScript` there does nothing.

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
data: elements <script type="module" src="/scripts/panel.212a66bf.js"></script>
```

The head patch is sent **after** the events that were already queued when you
asked, so a script arrives once the markup it came with is in the DOM. A stream
that asks and then sends nothing still gets it, at close. Each script goes out
once per request however many events follow, and asking again later in the same
stream sends only the new one.

Appending the same module twice is harmless if it happens — a browser evaluates
a module once per URL, so a reconnecting stream re-appending its tag does not
re-run it.

Finally, every script in the folder is **served** whether or not anything asks
for it; declaring only decides who gets a tag.

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
`tsconfig.scripts.json`, and excludes `src/scripts` from its main config.
`exclude` is safe there for once: nothing ever *imports* these files, so
TypeScript has no way to pull them into the other config.

## Pages and layouts

`definePage` marks a handler as an HTML page. Give `createApp` a `layout` and
every page is wrapped in it before it is served — the page returns a fragment,
the layout returns the document.

```ts
// layout.ts
import { defineLayout, html } from 'framework'

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
import { definePage, html } from 'framework'

export const GET = definePage(c => {
  c.set('title', 'Home')

  return html`<h1>Home</h1>`
})
```

```ts
// main.ts
const app = createApp({ layout }).plugin(fileRouter({ store, dir: 'routes' }))
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
| `definePage(render)` | `render(c)` returns the page's HTML. Returns a `Handler`, so it works anywhere a handler does |
| `defineEndpoint(render)` | The same, minus the layout — a fragment, not a document |
| `defineLayout(layout)` | `layout(content, c)` returns the document. Only there to infer the argument types — a plain function typed as `Layout` is the same thing |
| `createApp({ layout })` | The layout for every page in this app |

There is no `title` option, on purpose: page metadata rides on the context bag,
so a page sets whatever a layout wants to read and the framework stays out of
it. Declare those keys on `ContextBag` — see *The context bag is typed* — and
both ends are checked.

Both may be `async`. The response is `text/html`, and `c.status`, `c.header` and
`c.set` called inside a page all still apply — so a page can be a 404:

```ts
app.notFound(definePage(c => {
  c.status(404)

  return html`<h1>Not found: ${c.url.pathname}</h1>`
}))
```

### Endpoints

`defineEndpoint` is `definePage` without the document. It renders a fragment, it
is **never** wrapped in the layout however the app is configured, and it is the
right thing for markup that is going somewhere other than a fresh page load — a
panel fetched on demand, a row appended to a table, a partial re-render.

```ts
// routes/api/panel.ts
import { defineEndpoint, html, useScript } from 'framework'

export const GET = defineEndpoint(c => {
  useScript(c, 'panel')

  return html`<div id="panel">open</div>`
})
```

```html
<div id="panel">open</div><script type="module" src="/scripts/panel.212a66bf.js"></script>
```

That is the point of it. A page's `useScript` puts a tag in the layout's
`<head>`; an endpoint has no `<head>`, so the tag is **appended to the fragment**
and travels with the markup that needs it. The fragment stays self-contained:
whatever inserts it gets the script along with it.

Everything else matches `definePage` — `c.status`, `c.header` and `c.set` apply,
`html` escapes interpolations, and the result is a `Handler`, so it registers
through `app.get`, `fileRouter` or anything else.

One browser caveat that is not this framework's to fix: `innerHTML` and
`insertAdjacentHTML` do **not** execute a `<script>` they insert. A client that
inserts through DOM APIs — a morphing library, for one — does. Check what you
are inserting with.

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

Otherwise stay with `defineEndpoint`. Its tag riding along in the fragment is
the feature, not a compromise: the markup is self-contained, and it is a plain
`text/html` response that anything can consume.

### Where the wrapping happens

At **registration**, not per request, and `fileRouter` registers through the same
`app.on` as everything else. So file routes, `app.get` and `app.notFound` all get
layouts without any of them knowing that layouts exist. Consequences:

- **A handler that is not a page or an endpoint is never touched.**
  `c.html('<h1>hi</h1>')` returns exactly that, and so does a `c.json`. Only
  what `definePage` and `defineEndpoint` render is rewritten.
- **A page with no layout serves its fragment**, unwrapped. The same page is
  reusable across apps that wrap it differently. It still collects its
  `injectHTML` markup, appended — a layout-less page and an endpoint behave the
  same way here, which is what keeps `useScript` from silently doing nothing.
- **A thrown error does not reach the layout.** `onError` produces that response,
  and it is not a page.

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
import { createApp, fileRouter } from 'framework'
import { nodeStore } from 'node-adapter'

const app = createApp()
const store = nodeStore(new URL('./', import.meta.url))

app.plugin(fileRouter({ store, dir: 'routes' }))
```

```ts
// routes/users/[id].ts
import type { Context } from 'framework'

export const GET = (c: Context) => c.json({ id: c.params.id })
export const POST = (c: Context) => c.text('saved', 201)
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
| `GET` `POST` `PUT` `PATCH` `DELETE` `OPTIONS` `HEAD` `ALL` | A handler for that method — a `definePage` is one, and gets the app's layout |
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
import { fileRouter, staticStore } from 'framework'

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
import { withRead } from 'framework'
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
import { generateStore } from 'framework'
import { nodeStore } from 'node-adapter'
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
import { createRouter } from 'framework'

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
