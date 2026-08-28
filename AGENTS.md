# Agent guide

Rules and context for AI agents working in this repo. Read this before making changes.

## What this repo is

A pnpm workspace:

| Package | Path | Role |
| --- | --- | --- |
| `framework` | `packages/framework` | The library. Runtime-agnostic. Publishable. The product. |
| `example` | `packages/example` | Private consumer app. Exists to exercise `framework`. |
| `node-adapter` | `packages/node-adapter` | Runs a `fetch` handler on `node:http`. The Node escape hatch. |
| `deno-adapter` | `packages/deno-adapter` | The same two ports on `Deno.serve` and Deno's filesystem. |
| `tests` | `packages/tests` | Private. **All** tests for the whole repo live here. |

Everything depends on `framework` via `workspace:*`, so it always resolves to the
local source. There is no build step anywhere in this repo.

Writing a `bun-adapter` or `workers-adapter`? The whole procedure — both ports,
the scaffolding, the conformance checklist — is in
[ADAPTERS.md](./ADAPTERS.md). Read that, and one of the two adapters that exist,
instead of reverse-engineering either from scratch.

**Only `framework` is bound by the Minimum Common API rule.** It is the portable
package. `example`, `node-adapter` and `tests` are Node-hosted and have Node
types; `deno-adapter` is Deno-hosted and has the `Deno` globals it declares
itself. That split is the whole architecture: keep it.

## Hard rules

### Web standards only — WinterTC Minimum Common API

`framework` targets the **[WinterTC][wintertc] Minimum Common API** ([spec][mca]),
the Ecma TC55 standard for the API surface shared across server-side JavaScript
runtimes. That specification — not our taste, and not whatever the local Node
happens to support — decides what `framework` may use.

The practical consequence: `framework` runs unchanged on Node, Deno, Bun,
Cloudflare Workers and in browsers. So in `packages/framework/src/`:

- **No `node:*` imports.** Not one. Not `node:fs`, not `node:path`, not
  `node:crypto`, not `node:buffer`, not even "harmless" ones.
- **No Node globals.** No `process` (so no `process.env`), no `Buffer`, no
  `__dirname` / `__filename`, no `require`, no `setImmediate`.
- **If it is not in the Minimum Common API, do not use it.** Check the spec
  before reaching for a global you have not used here before. Being present in
  Node 24 is not evidence that it is portable.
- **Anything platform-specific goes in an adapter.** Filesystem access, servers,
  env vars, process signals — none of it belongs in `framework`. `framework`
  defines an interface; an adapter implements it.

The Minimum Common API surface, as of the current spec:

| Area | Available |
| --- | --- |
| Fetch | `fetch`, `Request`, `Response`, `Headers`, `FormData` |
| URLs | `URL`, `URLSearchParams`, `URLPattern` |
| Streams | `ReadableStream`, `WritableStream`, `TransformStream` + their readers, writers, controllers, `ByteLengthQueuingStrategy`, `CountQueuingStrategy` |
| Compression | `CompressionStream`, `DecompressionStream` |
| Encoding | `TextEncoder`, `TextDecoder`, `TextEncoderStream`, `TextDecoderStream`, `atob`, `btoa` |
| Crypto | `crypto`, `Crypto`, `CryptoKey`, `SubtleCrypto` |
| Events | `Event`, `EventTarget`, `CustomEvent`, `ErrorEvent`, `MessageEvent`, `PromiseRejectionEvent`, `AbortController`, `AbortSignal`, `MessageChannel`, `MessagePort` |
| Files | `Blob`, `File` |
| Time | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask`, `performance`, `Performance` |
| Data | `structuredClone` |
| Errors | `DOMException` |
| Misc | `console`, `globalThis`, `self`, `navigator.userAgent`, `WebAssembly` |

Explicitly **out of scope**, and therefore banned in `framework`:

- **DOM and HTML.** No `window`, `document`, `HTMLElement`, `localStorage`. The
  `DOM` lib is in `tsconfig.json` only because it is the only dependency-free
  source of types for the APIs above — its presence is not permission to use the
  rest of it.
- **Browser-only concepts** — origins, the document model, UI APIs.
- **`navigator` beyond `userAgent`.** Only that one property is specified.
- **Web Workers**, which the spec makes optional.
- **Performance Timeline / User Timing** — `performance.now()` is fine;
  `performance.mark`/`measure` are not specified.

**Exceptions — the only two places Node may appear:**

1. **`packages/node-adapter`**, the only place `node:*` imports and Node globals
   are allowed in shipped code. Anything platform-specific — servers, sockets,
   the filesystem, env vars, process signals — goes here or in a sibling adapter
   (`deno-adapter` today, `bun-adapter` or `workers-adapter` later); see
   [ADAPTERS.md](./ADAPTERS.md) for how to write one. Do not smuggle Node code
   into `framework` on the grounds that "the adapter needs it anyway".
2. **`packages/tests`**, which uses `node:test` as its harness. See *Testing*.
3. **`packages/example`**, a Node-hosted demo app.

Partly machine-enforced: the root `tsconfig.json` covers **only**
`packages/framework/src`, with `"types": []` and no `"node"`, so any `node:*`
import or Node global there is a typecheck error. Fix the code, never the config.
The DOM-beyond-MCA half is **not** enforced by types — that one is on you.

Note why the root config is scoped by `include` and not `exclude`: TypeScript
follows imports regardless of `exclude`, so an excluded Node-typed file still got
checked under the wrong lib as soon as something imported it.

[wintertc]: https://wintertc.org/
[mca]: https://min-common-api.proposal.wintertc.org

### TypeScript only — no JavaScript

Every source file is `.ts`. Do not create `.js`, `.mjs`, `.cjs`, or `.d.ts`
files, and do not add a compile step that emits them.

### Zero dependencies

`framework` and `example` have **no** `dependencies` or `devDependencies` beyond
the `workspace:*` link to `framework`. No bundler, no test runner, no polyfills,
no type packages, no linter.

**`framework` has zero dependencies and zero devDependencies.** That is the rule
that matters, and it is not negotiable.

The Node-hosted packages — `node-adapter`, `tests`, `example` — each carry
`@types/node` as a devDependency and nothing else. `deno-adapter` carries
nothing at all: Deno publishes no types this repo can depend on, so it declares
the `Deno` globals it uses in its own source. Types only; no runtime
dependency anywhere in the repo. Do not add an assertion library, a test
framework, a mocking library, a bundler, or a linter.

If you think any package needs a new dependency, stop and ask.

### Port 3000 belongs to the user

The user runs their own dev server on **port 3000**. Treat it as occupied at all
times.

- **Tests must bind `port: 0`** and read the real port off the handle
  (`server.port` / `server.url`). Never a fixed port — it collides with the user
  and with parallel test runs.
- **Never kill a process on 3000.** No `lsof -ti:3000 | xargs kill`, no
  `pkill -f "node src/main.ts"`. You cannot tell their server from a stale one,
  and killing theirs destroys work you did not own.
- **Do not run `pnpm dev` to verify a change** — it binds 3000. Use
  `PORT=4173 pnpm dev` (the example reads `PORT`), or better, `pnpm test`, which
  covers the same paths over ephemeral ports.
- If a port test genuinely needs a literal, pick something in the 4000s and say
  why.

`packages/example` still defaults to 3000 on purpose: that is the user's server.

### No raw control characters in source

Write escapes, not bytes: `'\u001b[0m'`, never a literal escape character. ANSI
sequences in `src/plugins/banner.ts` follow this. Invisible bytes are unreviewable
in a diff, and shell heredocs refuse to carry them.

### Minimise comments

Source code carries as few comments as possible. Default to none.

- **Never comment what the code already says.** No JSDoc that restates a type or
  a parameter name, no `// increment the counter`, no section banners, no
  commented-out code.
- **Write a comment only for a *why* the reader cannot recover from the code** —
  a workaround, a non-obvious constraint, a decision that looks wrong until
  explained. `packages/framework/src/router.ts` has three, and each exists to
  stop someone "fixing" the code and breaking it.
- **Prefer making the code self-explanatory** — a named helper, a clearer type, a
  better variable name — over explaining unclear code in prose.
- **Documentation belongs in the README**, not in source comments. Usage
  examples, API tables, and rationale go in `packages/<name>/README.md`.
- Applies to test files too. A test name should carry the explanation.

### Only erasable TypeScript syntax

Node strips types, it does not compile them. So no `enum`, no `namespace`, no
parameter properties (`constructor(private x: T)`), and no non-erasable
`import =`. Use `import type` / `export type` for type-only imports.
`erasableSyntaxOnly` and `verbatimModuleSyntax` enforce this in both tsconfigs —
respect the config rather than loosening it.

### Node 24 or newer

Every `package.json` declares `"engines": { "node": ">=24.0.0" }`, and `.npmrc`
sets `engine-strict=true`, so `pnpm install` **fails** on an older Node rather
than warning. The root also pins `"pnpm": ">=10.0.0"` and `packageManager`.

The floor is 24 because this repo depends on two things below it: unflagged
execution of `.ts` files (type stripping), and a global `URLPattern`. Do not
lower it without removing those dependencies, and raise it only deliberately —
it is a breaking change for consumers of `framework`.

Note the asymmetry: `engines.node` describes the floor *when running on Node*.
`framework` itself targets the Minimum Common API and has no Node dependency at
all, so it also runs on Deno, Bun, Workers and browsers, none of which read this
field.

### Other invariants

- **Relative imports carry the `.ts` extension:** `import { x } from './thing.ts'`.
  Node's resolver does not guess extensions and will not rewrite `.js` to `.ts`.
- **pnpm only.** Never run `npm` or `yarn`; they produce a competing lockfile and
  break workspace resolution. Commit `pnpm-lock.yaml` changes.
- **ESM only.** Every package is `"type": "module"`. No `require`.
- **Cross-package imports go through the package name.** Write
  `import { … } from 'framework'`. Never reach across with a relative path like
  `../../framework/src`.
- **`framework`'s public API is whatever `exports` says.** It points at
  `./src/index.ts` — the package ships TypeScript source. `index.ts` is a
  re-export barrel and nothing else; put implementation in a sibling module and
  re-export it. If you add an entry point, add it to `exports`; deep imports into
  `src/` are unsupported.
- **`framework/src` must typecheck under *both* tsconfigs.** The tests package
  imports it under `@types/node` with no `DOM` lib, and the two libs expose
  different subsets of some web API types — and disagree on `Uint8Array`'s
  `ArrayBuffer` type parameter. Three ways out, in order of preference:
  derive the type from a value the libs agree on (`ResponseBody` in `context.ts`,
  `ByteChunk` in `middleware/compress.ts`); declare it locally (`PatternOptions`
  in `router.ts`); or write the expression inline and let inference handle it —
  annotating an intermediate is what usually triggers these errors.

## Testing

**All tests live in `packages/tests`.** No other package has a test script, a
`test/` directory, or `*.test.ts` files. Mirror the source layout with one
directory per package under test — `packages/tests/framework/…` holds
`framework`'s tests.

### Test the public API only — black box

- **Import through the package name**, exactly as a consumer would:
  `import { createApp } from 'framework'`. **Never** import
  `../../framework/src/…`. This is the mechanism that keeps tests honest — if
  something is unreachable via the package's `exports`, it is not testable, and
  that is correct.
- **Assert on observable behavior**, not on internal structure. Test what a
  consumer can see: return values, thrown errors, emitted events, the contents of
  a `Response`. Do not assert on private fields, internal state, call counts,
  the shape of objects a consumer never inspects, or the order in which internal
  functions run.
- **Do not test unexported functions.** If an internal helper feels like it needs
  its own test, that is a signal either that it should be public, or that its
  behavior should be covered through the public API that uses it. Do not export
  something solely to make it testable.
- **Name tests after consumer-visible behavior** ("an app can be created and
  started"), not after implementation ("createApp sets this.options").
- A refactor that changes no public behavior must not require changing a single
  test. If it does, the test was reaching too deep.

### Harness

`node:test` and `node:assert/strict` — nothing else. Discovery is bare
`node --test` from the package root; do not pass a directory argument, since
`node --test test` treats it as a module path and fails.

One harness, even for a runtime Node cannot host. `packages/tests/deno-adapter`
spawns a real `deno run` subprocess and asserts on what comes back over HTTP and
over the JSON it prints — the same move as the gzip test's raw socket, and the
reason there is no `deno test` script anywhere. Those tests skip themselves when
`deno` is not on `PATH`, so the suite still passes without it. **Adding a second
harness — `deno test`, `bun test`, vitest — still needs asking first.**

## Commands

```sh
pnpm dev        # serves the example on http://localhost:3000 (blocks) — the user's port
pnpm test       # runs packages/tests
pnpm typecheck  # all five tsconfigs; fetches tsc via `pnpm dlx` — see caveat
```

There are **six** tsconfigs, checked separately, and the separation is the point:

| Config | Covers | `types` | `lib` |
| --- | --- | --- | --- |
| `tsconfig.json` | `packages/framework/src` | `[]` | + `DOM` |
| `packages/node-adapter/tsconfig.json` | its own `src` | `["node"]` | — |
| `packages/deno-adapter/tsconfig.json` | its own `src` | `[]` | + `DOM` |
| `packages/example/tsconfig.json` | its own `src`, minus `src/scripts` | `["node"]` | — |
| `packages/example/tsconfig.scripts.json` | `src/scripts` only | `[]` | + `DOM` |
| `packages/tests/tsconfig.json` | its own tests | `["node"]` | — |

`packages/example` has two because `src/scripts` is **browser** code living in a
Node package: it needs `DOM` and must not see `process`. Its main config
`exclude`s that folder, and this is the one place `exclude` is safe — nothing
imports those files, they are read as text by the `scripts` plugin, so
TypeScript cannot follow an import into them. The example's `typecheck` script
runs both.

The root one is what forbids Node in `framework`. `pnpm typecheck` runs it and
then `pnpm -r typecheck` for the rest.

`typecheck` pulls `typescript` through `pnpm dlx` at whatever version is current,
so it needs network. Nothing in the run path depends on tsc, so a typecheck
failure never blocks `pnpm dev` or `pnpm test`.

## Current state, so you don't rediscover it

- There is **no build step and no `dist/`**. `exports` points straight at `.ts`
  source. Deliberate, not an unfinished setup.
- **`node-adapter` exists** and bridges `node:http` to `Request`/`Response`.
  Its Node imports are **`node:http` for `serve`, and `node:fs/promises`,
  `node:path`, `node:url` for `nodeStore`** — nothing else. Stream conversion
  uses the web Streams API (`new ReadableStream({ pull })` and `getReader()`), not
  `node:stream`. Keep it that way: even where `node:*` is permitted, prefer the
  web API when one exists.
  `serve(handler, { port, hostname })` resolves to a handle with `url`, `port` and
  `close()`. It is deliberately **not** dependent on `framework` — it serves any
  object with a `fetch` method. See its README for what the bridge covers and
  the limits (no TLS, HTTP/2 or WebSocket upgrade).
- **`deno-adapter` exists too**, and is the proof that the two ports are enough:
  `serve` over `Deno.serve` and `denoStore` over `Deno.readDir` / `Deno.open`,
  with **no `node:*` imports and no dependencies at all**. There is no
  request/response bridge in it, because `Deno.serve` is already fetch-shaped —
  the package is the handle, the `start`/`stop` calls, and a 500 that does not
  leak the error. Two things it does differently from `nodeStore`, both because
  Deno makes them free: `read` **streams** rather than buffering, and the `Deno`
  globals are **declared in the modules that use them** rather than typed by a
  dependency. Its tsconfig therefore has `"types": []` and the `DOM` lib, like the
  root one. Verify it with `pnpm test`, and optionally `deno check src/index.ts`
  from the package — that one checks against Deno's real definitions.
- **`pnpm dev` now starts a real server** on `http://localhost:3000` and blocks
  until interrupted. Open it in a browser: `/` is an HTML page that calls the
  JSON routes. It prints the `banner` plugin's box on startup.
- **The example's routes are files** under `packages/example/src/routes/`. It
  builds one `nodeStore` rooted at `src/` and mounts `fileRouter({ store, dir:
  'routes' })`, so `main.ts` and `layout.ts` sit in the store without becoming
  routes. It no longer calls `app.get` directly — that path is still covered by
  the tests.
- **The example defaults to port 3000**, overridable with `PORT`. That port is the
  user's — see the rule above. `serve` rejects with `EADDRINUSE` if it is taken;
  use another port rather than freeing 3000.
- **The example's home page is a `definePage` route** (`src/routes/index.ts`)
  wrapped by `src/layout.ts`, which is a `defineLayout` holding the document
  shell. There is no `page.ts` any more — it was one big template literal, and
  the split is what the feature is for. Both stay template literals rather than
  `.html` files, because `framework` and `example` cannot read files from disk
  under their tsconfigs.
- `framework` is two things, both documented in `packages/framework/README.md`:
  `createApp` (`src/app.ts` + `src/context.ts`) — a Hono-inspired web server that
  is a single `fetch` handler — and `createRouter` (`src/router.ts`), the
  `URLPattern` matcher it is built on. `src/index.ts` is the re-export barrel.
- **There is no `listen`, and there cannot be.** Binding a port needs `node:net`
  or a runtime-specific `serve`, neither of which `framework` may import.
  `app.fetch(request)` is the whole server; it is already the entry shape Deno,
  Bun and Workers expect. Running it on Node needs the adapter below.
- **`compress`, `banner`, `logger` and `datastar` are on by default.** `createApp()`
  registers all three, and
  `createApp({ banner: false, compress: false, datastar: false, logger: false })`
  opts out. An object in any slot passes options through.
  `compress` is registered inside `createApp` *before the caller can add
  middleware*, which is what keeps it outermost — do not move it. `logger` is
  registered as the *first* plugin for the same reason: hooks run in registration
  order, so its `onRequest`/`onResponse` pair brackets every other one, and what
  it times is the whole request including compression. `datastar` is registered
  second, ahead of anything the caller adds, so a user plugin's `onRequest`
  already sees the signals it parsed.
- **Tests opt out of three of the four.** Each test file defines
  `newApp = () => createApp({ banner: false, compress: false, logger: false })`.
  Three reasons: banner would print ~100 boxes into the test output, logger a
  line per request on top of that, and a compressed `Response` returned straight
  from `app.fetch()` does **not** decode on `.text()` — only real HTTP clients
  decompress. `datastar` stays **on**, because it writes nothing to stdout and
  does not touch a response — so most files exercise the default incidentally.
  The exception is `plugin.test.ts`, which asserts on `StartInfo.plugins` and so
  opts out of all four. `defaults.test.ts` is the one file that exercises the
  defaults on purpose. The Deno test scripts opt out too, and `logger` especially: their
  stdout is a protocol the Node side parses.
- **Middleware ships in `src/middleware/`**, plugins in `src/plugins/`. `compress`
  is the first: response compression via `CompressionStream`, which is in the
  Minimum Common API. `CompressionStream` supports only `gzip`, `deflate` and
  `deflate-raw` — `br` and `zstd` throw, verified against the runtime.
- **`compress` peeks the body to apply its threshold.** Most responses have no
  `Content-Length`, so a header-only check would make the option dead code. It
  buffers at most `threshold` bytes, then replays them into the compressed
  stream. Do not "simplify" it back to a `Content-Length` check.
- **Plugins** (`src/plugin.ts`, `src/plugins/`) are objects with a `name` and any
  of `setup` / `onStart` / `injectHTML` / `onRequest` / `onResponse` / `onError` /
  `onStop`, registered with `app.plugin()`. `banner` is the built-in startup
  plugin; `logger` is the built-in per-request one.
- **`injectHTML` is the one hook that is not on every request's path.** It runs
  inside `withMarkup`, so only what `definePage` or `defineEndpoint` rendered is
  ever rewritten — a JSON route, a bare `c.html()` and a Datastar patch are not.
  Its second argument is the `InjectTarget`: `'document'` for a page wrapped in
  a layout, `'fragment'` for an endpoint or a layout-less page. It exists
  because a plugin cannot tell the two apart from the context, and a page-wide
  concern — a runtime, a stylesheet — belongs in the first and not the second.
  `datastar`'s `client` option is the reason it was added. `app.ts` collects `{ head, body }` from every plugin in registration
  order and `page.ts`'s `insertMarkup` splices them in: `head` before the first
  `</head>`, `body` before the last `</body>`. Two details that look wrong until
  explained — both offsets are read *before* either splice, since the body one is
  always later and so cannot be moved by the head one; and markup with no closing
  tag to sit before is appended rather than dropped, which is what makes a
  fragment layout work. Do not make this a response-level transform: regexing
  every `text/html` body was the alternative and it would hit fragments and
  patches too.
- **`logger` is a plugin, not middleware**, and that is the point: plugin hooks
  wrap the middleware chain, so it times `compress` too, which middleware could
  never do from the inside. It carries the start time in the context bag
  (`c.set`/`c.get`) rather than in a map of its own, and it **rebuilds** the
  response to add `x-response-time` rather than setting the header in place —
  a handler may return a response whose headers are immutable, such as anything
  straight from `fetch()` or a `Response.redirect()`. Consequence worth knowing:
  a thrown error is never logged, because `onResponse` does not run on the error
  path. `onError` is where that would go if it is ever wanted.
- **The Datastar browser runtime is vendored, not linked.**
  `src/plugins/datastar-client.ts` is the official v1.0.3 bundle verbatim, as a
  JSON-escaped string constant, under its MIT licence with the notice kept in
  the header. Three things about it:
  - **It is a string, and it has to be.** `framework` may not read files from
    disk, and importing it as a module would execute browser code in the server
    runtime, where `document` does not exist. Encoding it also keeps the repo's
    "every source file is `.ts`" rule intact — a `.js` file next to it would
    break that.
  - **The escaping is `JSON.stringify` with `ensure_ascii`**, so the file holds
    no invisible bytes and no raw control characters, per the rule above. The
    header carries the source URL and how to regenerate it; to take a newer
    Datastar, replace the whole file rather than editing it.
  - **`client` is off by default.** The plugin is on by default, and an app that
    never touches Datastar should not be handed 33KB of runtime. On, it serves
    `/datastar-<version>.js` (`immutable`, the version is in the path) and
    injects the tag into **documents only** — a fragment is patched into a page
    already running it.
- **`datastar` (`src/plugins/datastar.ts`) is the [Datastar][datastar] integration**,
  and it is two halves that only share a context-bag key. The plugin's
  `onRequest` parses the signals the client sends — the `datastar` query
  parameter on `GET`/`HEAD`, a JSON body otherwise — and `readSignals(c)` reads
  them back inside a route. `defineStream(render)` is the other half: a
  `Handler` returning an SSE response whose `stream` patches elements and
  signals. It is **on by default**, registered second — after `logger`, ahead
  of anything the caller adds. Five things not to undo:
  - **The body is cloned, never consumed.** `c.req.clone().text()`, so a handler
    can still call `c.req.json()` on the body it was sent.
  - **Bad input is not an error.** The hook runs on every request, most of which
    have nothing to do with Datastar, so unparseable JSON reads as `{}` rather
    than becoming a 500.
  - **SSE responses carry `Cache-Control: no-transform`**, which is what makes
    `compress` skip them. Without it, compress's peek-to-threshold would hold
    the first events of a live stream back until enough bytes accumulated. Do
    not "tidy" the header away, and do not special-case `text/event-stream`
    inside `compress` instead.
  - **A throw inside a render cannot reach `onError`.** The status line is
    already sent, so it errors the stream. The Datastar answer is to patch an
    error element or signal.
  - **Being a default has a price, and it is known.** The hook clones and reads
    the body of every JSON-bodied request, Datastar or not. That was a
    deliberate call — the alternative, gating on the `Datastar-Request: true`
    header the client sends, would make the default free but would stop signals
    reaching a route from any client that does not send it. Do not switch to the
    header gate without asking.
  `closed` is set from the request's `AbortSignal` as well as from stream
  cancellation, because a `while (!stream.closed)` loop would otherwise outlive
  the client. `example` exercises both halves: `routes/api/count.ts` (one-shot)
  and `routes/api/clock.ts` (long-lived).
- **All file reading goes through one port, `FileStore` (`src/file-store.ts`).**
  `list` is required; `read` and `import` are **optional, and that is the whole
  design** — a store advertises capability by having the method, so Workers
  (which cannot walk a directory or import by path) and Node satisfy the same
  interface. Do not add `node:fs` to `framework` to "simplify" this, and do not
  turn the optional methods into a runtime check on `navigator.userAgent`.
  - `read` returns `Promise<Response | null>`, not bytes: every runtime's asset
    story is already fetch-shaped, and it keeps content-type, ETag and streaming
    in the store. Conditional requests and ranges belong in `framework`
    middleware, not in each adapter.
  - `listFiles` is what features call, never `store.list`. It NFC-normalizes,
    rejects `..`/absolute/backslash paths, sorts, de-dupes, and re-applies the
    filters, so a store may ignore `ListOptions` entirely and still be correct.
  - `staticStore` is the baked store; `generateStore` emits its source as a
    string (pure — the caller writes the file), which is how a bundled runtime
    gets a listing. It omits `modified` on purpose: a timestamp would rewrite
    the file every build.
  - `withRead(store, read)` grafts platform bytes onto a baked listing. That is
    the Workers composition: baked `list` + `import`, `env.ASSETS.fetch` for
    `read`.
- **Pages, endpoints and layouts are `src/page.ts`.** `definePage(render)` and
  `defineEndpoint(render)` both return a `Handler` *branded* with its render
  function under a module-private symbol — a different symbol each. `app.on`
  passes every handler through `withMarkup`, which renders the brand it finds,
  wraps a **page** in `createApp({ layout })` if there is one, and applies the
  plugins' `injectHTML` to the result. An **endpoint** is deliberately never
  wrapped: it renders a fragment, so its injections are appended to that
  fragment rather than going into a `<head>` it does not have. That is what
  makes `useScript` work in a partial — the tag travels with the markup that
  needs it. A page with **no** layout behaves the same way, and that is on
  purpose: the alternative was `useScript` silently doing nothing there.
  Three consequences worth keeping:
  - The wrap happens **at registration, not per request**, and `fileRouter`
    registers through `app.on` like everything else — which is why file routes,
    `app.get` and `notFound` all get layouts with no code in any of them.
  - A page with **no layout configured still works**, serving its fragment. The
    brand is inert until an app supplies a layout.
  - `html` returns a **`SafeString`, not a primitive** (`typeof` is `'object'`),
    which is exactly what stops a layout's `html` from escaping the page it
    wraps. Do not "fix" `definePage` to return `String(...)`, and note that a
    test comparing `html` output needs `String()` around it.
  Page metadata rides on the context bag: the page calls `c.set('title', …)` and
  the layout reads `c.get('title')`. There is no `title` option, on purpose.
- **The context bag is keyed by an interface, `ContextBag` (`src/context.ts`).**
  `set`/`get` are generic over `K extends ContextKey`, so a declared key checks
  its value and `get` returns the right type with no explicit type argument.
  Four things to know before touching it:
  - **`ContextKey` is `keyof ContextBag | (string & {})`, and the `& {}` is
    load-bearing.** A plain union with `string` collapses to `string` and the
    editor stops suggesting the declared keys, which is the entire feature. Do
    not "simplify" it.
  - **Apps extend it by declaration merging** — `declare module 'framework'`
    with `import type {} from 'framework'` to make the file a module. Verified
    to merge even though `index.ts` only re-exports the interface.
    `packages/example/src/bag.ts` and `packages/tests/framework/bag.ts` are the
    two worked examples; the tests one is deliberately not a `*.test.ts` so the
    runner ignores it.
  - **The framework's own plugin keys are declared in `context.ts`**, not in
    each plugin. One reviewable list, no relative-path module augmentation, and
    none of them needs a type imported from a plugin — they are all `number`,
    `Set<string>` and the like. Adding a plugin key means adding it there.
  - **`c.get<T>(key)` no longer takes a value type parameter.** The type
    argument slot is the *key* now. A caller that really must assert a type
    casts the result, as `readSignals` does for its own generic.
- **`scripts` (`src/plugins/scripts.ts`) serves browser code with no bundler.**
  At `setup` it lists a folder through the store, strips types, hashes the
  result and registers a GET route per file. It requires `store.read` and says
  so, by name, if it is missing.
- **Scripts are opt-in per route, not injected wholesale.** `useScript(c, …names)`
  is how a page, layout, component or stream declares a dependency; `injectHTML`
  emits a tag only for what was asked. Where the tag lands depends on what is
  rendering: a `definePage` with a layout puts it in the `<head>`, a
  `defineEndpoint` (or a layout-less page) appends it to the fragment, and a
  `defineStream` appends it to the head of the document already on screen, via a
  `datastar-patch-elements` with `selector head` and `mode append`. That last
  path is why `datastar.ts` imports `takeScriptTags` from `scripts.ts` — the one
  plugin-to-plugin import in the package, and the alternative was a speculative
  hook on `Plugin` that only these two would ever use. `takeScriptTags` drains:
  it bookmarks how many of the used-set have gone out, so a long-lived stream
  sends each script once and a later `useScript` sends only the new one. The
  flush happens **after** each event and once at close, not before, so a script
  arrives once the markup it came with is in the DOM.
- **An endpoint deliberately cannot target the head, and this was decided, not
  overlooked.** One HTTP response is one body with one target — Datastar's
  `datastar-selector`/`datastar-mode` headers describe a non-SSE response as a
  whole — so putting a fragment in `#panel` *and* a tag in `head` is two
  destinations, and two destinations need two events. The answer is
  `defineStream`, which costs one wrapper over `defineEndpoint`. Two things that
  look like fixes and are not: shipping a client-side runtime that hoists
  `<script>` out of fragments into the head, which would make `framework` ship
  browser JavaScript for the first time; and having `defineEndpoint` answer as
  SSE whenever `useScript` was called, which makes the content-type depend on
  whether a function was called mid-render. Ask before doing either. The wiring is worth understanding before changing
  it: `onRequest` puts the plugin's name → URL map on the context bag, so
  `useScript` can resolve **at the call site** and throw where the typo was
  written rather than deferring to injection time. That is one bag write per
  request and no allocation — the merge branch only allocates when a second
  `scripts` plugin is registered, and `injectHTML` filters to its own URLs so
  two plugins emit their own tags instead of both emitting everything. An
  unknown name throws and lists what exists; do not soften that to a silent
  skip, which is how a script quietly stops loading. There is no "always"
  option on purpose — the layout runs for every page, so asking there is
  already the answer.
  Four more things not to undo:
  - **Only TypeScript extensions are stripped.** `.js`/`.mjs` are served
    byte-for-byte, matching Node. Running the TypeScript lexer over real
    JavaScript would risk reading `a < b > (c)` as type arguments.
  - **The hash is of the stripped code, not the source**, so it changes exactly
    when the served bytes change — which is what makes the `immutable`
    `Cache-Control` honest.
  - **The URL is escaped before it becomes a route pattern.** It is a literal, so
    anything `URLPattern` reads as syntax has to be backslashed; the pattern and
    the `src` differ by those backslashes on purpose.
  - **Everything happens in `setup`.** Editing a script needs a restart, for the
    same reason `fileRouter` does: `app.on` only appends, and there is no route
    removal. See the dev-reload open question below.
  - **Every script is served whether or not anything asks for it.** Declaring
    decides who gets a tag, not what exists at a URL.
  `example` uses it, which is why that package now has **two** tsconfigs — see
  *Commands*.
- **File-based routing is `src/file-router.ts`**, and it is a plugin — `setup`
  receives the app, so it needs no change to `app.ts`. `framework` owns path →
  pattern, specificity sorting and registration; the store owns the I/O.
  `fileRouter` requires `store.import` and says so, by name, if it is missing.
- **The file router sorts, and the sort is load-bearing.** Registration order is
  match priority and a directory listing has no order, so it ranks literal →
  param → optional → catch-all at the first differing segment, then shorter path,
  then path. Catch-alls compile to `{/:rest}*` rather than `/:rest*` so they also
  match the parent path; verified against `URLPattern`, so do not "tidy" the
  braces away.
- **`app.fetch` awaits `app.start()`**, so plugin setup and `onStart` always run
  before the first request even if nobody calls `start()` — which is what makes
  the Workers-style `export default app` path work. Do not remove that await.
- **Runtime detection uses `navigator.userAgent`**, the only runtime identifier in
  the Minimum Common API. Never reach for `process.version`.
- **`onError` hooks observe, they do not handle.** `app.onError` produces the
  response; plugin `onError` is for logging and reporting. Keep that split.
- **Middleware returns its response** rather than mutating `c.res` as Hono does.
  This is a deliberate simplification, not an oversight — do not "fix" it toward
  Hono's shape without asking.
- **The app caches its compiled routers** and invalidates on registration, so
  patterns compile once rather than per request. Keep it that way.
- **`URLPattern` is used unpolyfilled.** It is in the Minimum Common API and is
  Baseline 2025 — fine on Node 24+, Deno, Bun, Workers and current browsers,
  absent on older runtimes. A polyfill would be a dependency, so it is out; the
  `engines.node` floor covers the Node case.
- **Gotcha, already handled:** `URLPattern` fills unspecified components with
  `'*'`, which captures a junk `'0'` group. `collectParams` skips any component
  whose compiled pattern is exactly `'*'`. Do not "simplify" that check away.
- There is **no linter or formatter**, and **no CI**.
- `example` runs as a plain Node script. It is a Node consumer of a
  runtime-agnostic library — that asymmetry is expected.

[datastar]: https://data-star.dev

## Open questions — ask, don't guess

- **Whether `example` should serve its client assets from disk.** The `FileStore`
  port and `nodeStore` now exist, so the missing piece is a static-file
  middleware in `framework` over `store.read` — including the ETag /
  `If-None-Match` / `Range` handling that deliberately does *not* live in
  adapters, and a MIME table, which nothing in the repo has yet. The example's
  page is still a template literal.
- **Whether `bun-adapter` or `workers-adapter` are wanted.** `deno-adapter`
  exists and needed only a `serve` shim plus a `FileStore`, which is the evidence
  that `framework` is portable enough for the rest — and `staticStore` +
  `withRead` already cover the Workers case without a package.
- **Whether plugins should be scopeable to a path** the way middleware is. Today
  every hook sees every request.
- **Whether the file router should support directory-level middleware** — a
  `_middleware.ts` applying to its subtree. Today only a route file's own `use`
  export is honoured, scoped to that route's pattern.
- **How dev-time reloading should work.** A store could grow an optional
  `watch()`, but `app.on` only appends and there is no route removal, so
  re-registering would duplicate routes. That needs a decision in `app.ts` —
  route generations, or a rebuild-the-app dev loop — before a store method
  would help.
- **Whether `nodeStore.read` should stream.** It buffers whole files today,
  which is fine for modules and layouts and wrong for large assets. Streaming
  means `node:stream`'s `Readable.toWeb`, i.e. a fifth Node import.
- **Whether `banner` should auto-detect colour support.** It cannot within the
  MCA, so it defaults to on; an adapter could pass a value it detects.
- **TLS, HTTP/2 and WebSocket upgrade** are unimplemented in `node-adapter`.

## Verifying a change

```sh
pnpm test && pnpm typecheck
```

`pnpm dev` blocks — it is a server — and it binds the user's port 3000. Do not run
it to verify your own work; `pnpm test` covers the same paths on ephemeral ports.
If you must serve manually, use `PORT=4173 pnpm dev`.

If you changed `framework`'s public API, update `packages/example/src/main.ts` to
use it, so the example keeps proving the API works.
