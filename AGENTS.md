# Agent guide

Rules and context for AI agents working in this repo. Read this before making changes.

## What this repo is

A pnpm workspace. The four publishable packages are scoped under `@erikt`;
the directories under `packages/` keep their shorter historical names, and the
docs below call the library `framework` for short:

| Package | Path | Role |
| --- | --- | --- |
| `@erikt/framework` | `packages/framework` | The library. Runtime-agnostic. Publishable. The product. |
| `example` | `packages/example` | Private consumer app. Exists to exercise `framework`. |
| `@erikt/framework-node` | `packages/framework-node` | Runs a `fetch` handler on `node:http`. The Node escape hatch. |
| `@erikt/framework-deno` | `packages/framework-deno` | The same two ports on `Deno.serve` and Deno's filesystem. |
| `@erikt/create-framework` | `packages/create-framework` | The `pnpm create` starter, and the template it copies. |
| `tests` | `packages/tests` | Private. **All** tests for the whole repo live here. |

`packages/create-framework/template` is a workspace package of its own — the
extra entry in `pnpm-workspace.yaml` — so the starter can be run and typechecked
here rather than only after someone scaffolds it. Its dependencies are
`workspace:*` for that reason, and `scaffold()` rewrites them to a published
range on the way out; that rewrite is the only difference between what runs here
and what a user gets.

Everything depends on `framework` via `workspace:*`, so it always resolves to the
local source. Nothing in this repo is built to run — the one exception is
publishing, and it is invisible from here; see *Publishing* below.

Writing a `bun-adapter` or `workers-adapter`? The whole procedure — both ports,
the scaffolding, the conformance checklist — is in
[ADAPTERS.md](./ADAPTERS.md). Read that, and one of the two adapters that exist,
instead of reverse-engineering either from scratch.

**Only `framework` is bound by the Minimum Common API rule.** It is the portable
package. `example`, `@erikt/framework-node` and `tests` are Node-hosted and have Node
types; `@erikt/framework-deno` is Deno-hosted and has the `Deno` globals it declares
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

1. **`packages/framework-node`**, the only place `node:*` imports and Node globals
   are allowed in shipped code. Anything platform-specific — servers, sockets,
   the filesystem, env vars, process signals — goes here or in a sibling adapter
   (`@erikt/framework-deno` today, `bun-adapter` or `workers-adapter` later); see
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

The Node-hosted packages — `@erikt/framework-node`, `tests`, `example` — each carry
`@types/node` as a devDependency. `@erikt/framework-deno` carries no types at all: Deno
publishes none this repo can depend on, so it declares the `Deno` globals it uses
in its own source.

Both adapters also depend on `framework` itself, at `workspace:*`, for their
config layer — see *Rule 1* in [ADAPTERS.md](./ADAPTERS.md). The graph is
one-way and acyclic, and the rule above is untouched: nothing outside the repo is
depended on anywhere, and `framework` depends on nothing at all. Do not add an
assertion library, a test framework, a mocking library, a bundler, or a linter.

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
  `import { … } from '@erikt/framework'`. Never reach across with a relative path like
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
  `import { createApp } from '@erikt/framework'`. **Never** import
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

One harness, even for a runtime Node cannot host. `packages/tests/framework-deno`
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

Every flag lives in **one** shared base, and the configs that are checked only
add `include`. Three bases, in a chain:

| Base | Extends | `types` | `lib` |
| --- | --- | --- | --- |
| `packages/framework/tsconfig.base.json` | — | `[]` | + `DOM` |
| `packages/framework-node/tsconfig.base.json` | framework's | `["node"]` | — |
| `packages/framework-deno/tsconfig.base.json` | framework's | `[]` | + `DOM` |

A base carries **no `include`**, and must not: an inherited one resolves against
the directory it was written in, so it would point every extender at that
package's own source. Six configs do the checking, each one an `extends` plus an
`include`:

| Config | Extends | Covers |
| --- | --- | --- |
| `tsconfig.json` | framework's base | `packages/framework/src` |
| `packages/framework-node/tsconfig.json` | its own base | its `src` |
| `packages/framework-deno/tsconfig.json` | its own base | its `src` |
| `packages/example/tsconfig.json` | `@erikt/framework-node/tsconfig.base.json` | its `src`, minus `src/scripts` |
| `packages/example/src/scripts/tsconfig.json` | `@erikt/framework/tsconfig.browser.json` | that folder only |
| `packages/tests/tsconfig.json` | `@erikt/framework-node/tsconfig.base.json` | its own tests |

`packages/example` is what an app looks like: it extends its **adapter's** base
and writes no compiler options of its own. Its browser folder extends
`@erikt/framework/tsconfig.browser.json` instead — the web-standards flavour, plus the
`paths` entry that types the Datastar runtime.

**That one is named `tsconfig.json` and lives inside `src/scripts/`, and both
halves of that matter.** An editor only loads `tsconfig.json`, walking up from
the file it is showing; a `tsconfig.scripts.json` at the package root is found
by `tsc -p` and by nothing else. Since the main config *excludes* `src/scripts`,
those files landed in an inferred project with no `paths` — so
`import … from 'datastar'` was underlined in the editor while `pnpm typecheck`
stayed green. A nested `tsconfig.json` is what closes that gap. It is not served
by the `scripts` plugin, whose extensions are `.ts` and `.js`.

Each base is reachable by package specifier because its `package.json` names it
in `exports` and `files`. Adding a flag means editing one file.

`packages/example` has two because `src/scripts` is **browser** code living in a
Node package: it needs `DOM` and must not see `process`. Its main config
`exclude`s that folder, and this is the one place `exclude` is safe — nothing
imports those files, they are read as text by the `scripts` plugin, so
TypeScript cannot follow an import into them. The example's `typecheck` script
runs both.

`framework`'s base is what forbids Node in `framework`: `types: []` and no
`"node"`, so a `node:*` import or a Node global there is a typecheck error. `pnpm typecheck` runs it and
then `pnpm -r typecheck` for the rest.

`typecheck` pulls `typescript` through `pnpm dlx` at whatever version is current,
so it needs network. Nothing in the run path depends on tsc, so a typecheck
failure never blocks `pnpm dev` or `pnpm test`.

## Current state, so you don't rediscover it

- **Nothing is built to run here.** `exports` points straight at `.ts` source
  and every consumer resolves it through a workspace link. Deliberate, not an
  unfinished setup — but see *Publishing*, which is the one place a `dist/`
  exists, and only while a tarball is being made.
- **`@erikt/framework-node` exists** and bridges `node:http` to `Request`/`Response`.
  Its Node imports are **`node:http` for `serve`, and `node:fs/promises`,
  `node:path`, `node:url` for `nodeStore`** — nothing else. Stream conversion
  uses the web Streams API (`new ReadableStream({ pull })` and `getReader()`), not
  `node:stream`. Keep it that way: even where `node:*` is permitted, prefer the
  web API when one exists.
  `serve(handler, { port, hostname })` resolves to a handle with `url`, `port` and
  `close()`. `serve.ts` and `store.ts` are deliberately **not** dependent on
  `framework` — `serve` hosts any object with a `fetch` method, and there is a
  test holding it to that. Only `config.ts` imports `framework`; keep that split
  when editing. See its README for what the bridge covers and
  the limits (no TLS, HTTP/2 or WebSocket upgrade).
- **`@erikt/framework-deno` exists too**, and is the proof that the two ports are enough:
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
- **`packages/tests/fixtures/` is listed exhaustively** by both store tests, so
  adding a fixture means updating the expected path list in
  `@erikt/framework-node/store.test.ts` and `@erikt/framework-deno/store.test.ts`. That is the
  cost of the assertion proving nothing extra is returned; keep it.
- **The example's routes are files** under `packages/example/src/routes/`. It
  builds one `nodeStore` rooted at `src/` and mounts `fileRouter({ store, dir:
  'routes' })`, so `layout.ts` and `bag.ts` sit in the store without becoming
  routes. The app's entry is `framework.config.ts` at the package root, outside
  the store entirely. It no longer calls `app.get` directly — that path is still covered by
  the tests.
- **The example defaults to port 3000**, overridable with `PORT`. That port is the
  user's — see the rule above. `serve` rejects with `EADDRINUSE` if it is taken;
  use another port rather than freeing 3000.
- **The example's home page is a `defineRoute` route** (`src/routes/index.ts`)
  that asks for `src/layout.ts`, a `defineLayout` holding the document shell.
  Every page in the example does so explicitly — there is no app-wide default to
  inherit. There is no `page.ts` any more — it was one big template literal, and
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
  inside `withMarkup`, so only markup a `defineRoute` rendered is ever rewritten
  — a bare `c.body()` and a Datastar patch are not, and neither is text or data
  a `defineRoute` returned.
  Its second argument is the `InjectTarget`: `'document'` when the render asked
  for a layout, `'fragment'` when it did not. It exists
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
  - **With `client` on it also injects an import map**, `{"datastar": "/datastar-<version>.js"}`,
    so browser code can `import { mergePatch } from 'datastar'`. Three things
    hold it up: the map is built by **string concatenation, not `html`** — a
    `<script>` body is raw text, so an escaped quote would arrive as a literal
    `&quot;` and the JSON would not parse; it is pushed **before** the runtime
    tag, because a browser ignores an import map that arrives after module
    loading starts; and the types live in `src/datastar-runtime.ts`, wired up by
    `paths` in `@erikt/framework/tsconfig.browser.json`, which is what browser code
    should extend. All sixteen of the bundle's exports are declared there, with
    signatures taken from Datastar's own v1.0.3 source rather than inferred from
    the minified build. It is a `.ts` of `export declare`, **not** a `.d.ts` —
    this repo ships no declaration files, and an editor consumes the two
    identically. Datastar documents none of this surface, so a version bump is a
    place to re-check it; `attribute` plugins are typed loosely on purpose,
    since Datastar derives their context through conditional types that change
    between releases.
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
- **Routes and layouts are `src/page.ts`.** `defineRoute(render)` returns a
  `Handler` *branded* with its render function under a module-private symbol;
  `app.on` passes every handler through `withMarkup`, which renders the brand it
  finds, wraps it in the layout the render asked for, and applies the plugins'
  `injectHTML`. `useLayout(c, layout)` asks for that layout.
  There used to be two functions here, `definePage` and `defineEndpoint`, whose
  only difference was one line — whether a layout was applied. They collapsed
  into `defineRoute` plus `useLayout`. Things to keep:
  - **There is no app-wide layout: a page asks, or it gets none.** `createApp`
    and `defineConfig` used to take a `layout`, which made every route a
    document by default and left a fragment saying `useLayout(c, false)` to opt
    out. Naming the layout in the page that uses it is what an import already
    expresses, so the option went and `false` went with it — a route that does
    not ask answers with its markup as-is, which is what a fragment wants.
  - **The choice is read *after* the render**, out of the `route:layout` bag
    key, so a route — or a component it called — can decide partway through.
    That is also why `withMarkup` can no longer return the handler untouched:
    what it will do is not known until the request runs.
  - **A fragment's injections are appended to the markup** rather than going
    into a `<head>` it does not have, which is what makes `useScript` work in a
    partial — the tag travels with the markup that needs it.
  - **What a route returns picks the content type**, and `page.ts`'s `respond`
    is the only place that decides: an `html``` result is `text/html`, a plain
    string is `text/plain`, anything else is `application/json`. There used to be
    `c.html`, `c.text` and `c.json` on the context; they are gone, because a
    route saying what it is and then building a response about it says the same
    thing twice. Five things here are load-bearing:
    - **`isSafeString`, not `typeof === 'object'`.** `html` returns a String
      *object*, so a naive object check would answer every page as JSON. The
      predicate lives in `helpers/html.ts` because that is where the class is —
      which means the browser build carries it too, so `html-client.ts` has to be
      regenerated when html.ts changes (a test in `packages/tests` enforces it).
    - **A hand-built string is text, not markup.** `'<p>' + value + '</p>'` and
      two `html` results concatenated are both primitives, so both answer
      `text/plain`. Deliberate, and worth saying out loud when someone reports it
      as a bug: the string that skipped `html` is the one whose interpolations
      were never escaped, and showing it verbatim beats handing a browser markup
      to execute. Do not "fix" this by sniffing for a leading `<`.
    - **Decided on the render's return, once.** Not on the finished document:
      wrapping and injecting both concatenate, so a page is a primitive string by
      the time it is whole, and re-reading it would answer `text/plain`.
    - **`RouteResult` is `string | object`**, on purpose on both sides. `object`
      takes an interface or a class instance out of a database layer, where a
      real `JsonValue` would reject `{ id: string | undefined }` from `c.params`;
      leaving out `undefined` and the primitives still makes a forgotten `return`
      an error.
    - **Text and data return before the layout is read.** There is nothing for a
      layout to hold or a plugin to splice into, so a route that calls
      `useLayout` and then returns one of those still gets it as it is. Do not
      add an option or a second function for any of this — the return value
      already says which was meant, the same argument that collapsed
      `definePage` and `defineEndpoint`.
  - **`c.body` is the only builder left**, with `c.redirect`. It grew a `type`
    option to replace what the three helpers had: a content type that applies
    *only* when nothing has set one, so a handler's own
    `c.header('content-type', …)` still wins. Middleware, plugin hooks and plain
    `onError` handlers use it, since they hand back a `Response` rather than
    rendering.
  - **Wrapping is decided per request**, not at registration as it once was —
    `useLayout` can only have been called during the render. What still happens
    at registration is `app.on` passing every handler through `withMarkup`,
    `fileRouter` included, which is why `useLayout` works the same in a file
    route, an `app.get` and a `notFound`.
  - **`defineErrorPage` is the error path's page**, and `withErrorMarkup` is its
    own function rather than a branch inside `withMarkup`: its render takes
    `(error, c)`, it **keeps a status the failing handler set** and falls back to
    500 only when the status is still the untouched 200 — so `c.status(401)`
    then `throw` answers 401, while a page that forgets cannot answer a crash
    with a 200 — and it **catches its own failure** and returns the plain 500.
    The 500 is applied *before* the render, so `c.status()` reads the right
    value inside it. That last one is not optional — the likely thrower is the layout,
    and a second throw inside `onError` escapes `app.fetch` entirely. A plain
    `ErrorHandler` is returned unchanged, so nothing is wrapped and no status is
    assumed for it.
  - **404 is `notFound`, not `onError`.** A URL matching no route returns
    `handleNotFound` without throwing, so `onError` never sees it. This is the
    single most common misunderstanding of the two hooks; keep the README's
    *Error pages and 404s* section saying so.
  - A page that **asks for no layout still works**, serving its fragment. The
    brand only decides that the render goes through `withMarkup`, not that
    anything wraps it.
  - `html` returns a **`SafeString`, not a primitive** (`typeof` is `'object'`),
    which is exactly what stops a layout's `html` from escaping the page it
    wraps. Do not "fix" `defineRoute` to return `String(...)`, and note that a
    test comparing `html` output needs `String()` around it.
  Page metadata rides on the context bag: the page calls `c.set('title', …)` and
  the layout reads `c.get('title')`. There is no `title` option, on purpose.
- **`c.status` reads as well as writes.** `c.status(code)` sets it, `c.status()`
  returns what the response would carry — 200 when nothing set one. Overloaded
  rather than given a second name, because it is one idea; declared with real
  function overloads inside `createContext` so the object literal needs no cast.
  The status is *not* on the context bag: `c.get('status')` is a user key and
  means nothing to the framework.
- **The context bag is keyed by an interface, `ContextBag` (`src/context.ts`).**
  `set`/`get` are generic over `K extends ContextKey`, so a declared key checks
  its value and `get` returns the right type with no explicit type argument.
  Four things to know before touching it:
  - **`ContextKey` is `keyof ContextBag | (string & {})`, and the `& {}` is
    load-bearing.** A plain union with `string` collapses to `string` and the
    editor stops suggesting the declared keys, which is the entire feature. Do
    not "simplify" it.
  - **Apps extend it by declaration merging** — `declare module 'framework'`
    with `import type {} from '@erikt/framework'` to make the file a module. Verified
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
- **`Context` is an `interface` so plugins can extend it, and `datastar` does.**
  Core knows nothing about signals: `plugins/datastar.ts` declares the
  `Signals` interface, augments `Context` with `readonly signals` through
  `declare module '../context.ts'`, and fills it in its own `onRequest`.
  `readSignals` is gone. Four things that fall out of that, all load-bearing:
  - **`createContext` ends in `as Context`, and that is not laziness.** Core
    builds an object that is deliberately incomplete, because it cannot know
    what a plugin added. Written as an assertion on the literal rather than a
    separate `const` so the methods keep their contextual types — otherwise
    every parameter falls back to implicit `any`. It stays a *downcast*, so a
    misspelt method or a wrong signature is still `TS2352`; only unknown
    properties are waived. Do not widen it to `as unknown as Context`.
  - **The type says `signals` is always there; with `datastar: false` it is
    not.** That is the price of the plugin owning it, and the only place the
    claim is a lie. A test pins the behaviour.
  - **Parsing stays `Record<string, unknown>`.** An app may declare a signal as
    required and nothing can promise the browser sent it, so the assertion to
    `ContextSignals` happens once, where the plugin hands it over.
  - **`Signals` is declaration-merged** the way `ContextBag` is, and
    `ContextSignals` is `Signals & Record<string, unknown>` so undeclared keys
    still read as `unknown`.
  - **The convention is: a signal an app defines gets declared.** Every app in
    this repo does it in its own `src/bag.ts`, next to the `ContextBag` keys —
    `count` in `example`, `theme` / `browserCount` / `serverCount` / `counting`
    in the template. Adding a signal to markup and not to that file is the thing
    to catch in review; a cast at the point of use (`c.signals as Counter`) is
    the older shape and should be replaced rather than copied.
    Colocating each declaration with the file that creates it was tried and
    reverted: it reads worse, and it cannot hold across the browser/server
    boundary anyway, since `src/scripts/` is a separate TypeScript program whose
    augmentations a route cannot see.
  - **Declare them optional.** The browser decides what arrives, so
    `const { count = 0 } = c.signals` is the shape that works — declaring
    `count: number` makes that default look dead while a request without it
    still hands over `undefined`, which is how `NaN` gets into a response.
    `headAssets` is declared by the framework itself for the same reason.
- **The import map is core's, not a plugin's.** A browser allows one per
  document, so `head.ts` collects entries with `appendImport` and `app.ts`
  renders `importMap(c)` **first** — ahead of plugin markup and the head queue,
  because a map arriving after module loading has begun is ignored — and **only
  for `target === 'document'`**, since a fragment is patched into a page that
  already has one. `datastar` contributes `datastar`; `scripts` contributes
  `@erikt/framework/html`, and only when one of the assets the page actually loaded
  imports it. That last condition is not fussiness: claiming it unconditionally
  put an import map on every page and broke two tests that assert a page asking
  for nothing gets nothing.
- **`src/helpers/html-client.ts` is derived, never hand-edited.** It carries the
  stripped browser build of `helpers/html.ts` as a string, because `framework`
  cannot read its own files at runtime and this is the one module that runs on
  both sides. `packages/tests` re-derives it with `stripTypes` and compares, so
  the two cannot drift; regenerate rather than patch it.
- **`src/head.ts` is the per-request head queue, and it lives in core for a
  reason.** `useScript` and `useStyle` both `appendHead` into one insertion-
  ordered `Set`; `app.ts` splices `headMarkup(c)` into a rendered document after
  the plugins' `injectHTML`, and `defineStream` drains it with
  `takeHeadMarkup(c)`. It replaced a per-plugin `injectHTML` plus a
  `takeScriptTags` that `datastar.ts` imported from `scripts.ts`, and it exists
  because three things were true at once: a stream needs to drain
  *incrementally*, which a hook returning everything each call cannot do; two
  plugins owning one queue would each emit the other's tags; and a second
  plugin-to-plugin import was about to appear for styles. The `Set` is what
  de-duplicates a component asking twice, so no plugin needs its own filter.
  The queue is keyed by `assetId(url)` — a CSS-safe identifier derived from the
  URL, which already carries a content hash — and every tag is *rendered* with
  that id, documents included.
- **A stream is told what the page already holds; it does not ask the DOM.**
  `injectHTML` seeds a `headAssets` signal into any document that collected
  assets, Datastar returns signals on every request, and `defineStream` skips
  ids it finds there and records back whatever it does send. That is what stops
  a second request duplicating a tag.
  This was arrived at by elimination, so do not "simplify" it back:
  - `selector head:not(:has(#id))` skips correctly, but a selector matching
    nothing is `console.warn("PatchElementsNoTargetsFound")` in the vendored
    bundle — every correct skip would print a warning. Rejected for that reason
    after being built.
  - `mode outer` on `#id` with no selector dedupes when present but **fails to
    insert** when absent, which is the case that matters.
  - No single patch can express "insert if missing": `fn` in the bundle sends
    `append` to a plain DOM insert (not id-aware), and `outer`/`inner` to the
    morph. One patch carries one mode, and the two cases need different ones.
  The flush uses `write`, not `send`, or the signal patch would re-enter it.
  `injectHTML` still exists for target-aware, plugin-owned injection — the
  Datastar runtime tag — and the two are not redundant.
- **`styles` (`src/plugins/styles.ts`) is `css``` blocks, hashed and served.**
  Four decisions not to undo:
  - **The hash is FNV-1a over UTF-8 bytes, not SHA-256.** `css``` runs while a
    module is evaluated and must return a usable hash synchronously;
    `crypto.subtle` is async. It is a cache key, not a signature. Do not
    "upgrade" it to SHA-256 without making `css` async, which would break its
    use at module scope.
  - **The registry is module-level**, keyed by text *and* by hash, because a
    block is created long before any app exists. Keying by text is what makes
    identical CSS one stylesheet and what stops repeated calls at one site from
    growing the map.
  - **One route, `/styles/:hash.css`, serves everything** by registry lookup —
    verified that `URLPattern` captures the hash and rejects another extension.
    Nothing is registered as blocks are discovered, which is also why a
    stylesheet is reachable before any page has linked it: a cached page must
    not break after a restart.
  - **Interpolation is substituted, not escaped.** The text is the cache key, so
    a per-request value mints a stylesheet per request and grows the registry
    without bound. The README says to interpolate constants and use a CSS custom
    property for anything that varies. Do not add escaping to make it look like
    `html``` — it is authored content, and escaping CSS correctly is a different
    problem.
- **The starter is `pnpm create @erikt/framework`, and the scoped form matters.**
  pnpm reads an unscoped `owner/repo` as a git shorthand and puts the `create-`
  prefix on the **owner** — `pnpm create erikt/framework` goes looking for
  `github.com/create-erikt/framework`, not this package. Verified against pnpm
  10 rather than assumed; the README says so because it is the first thing
  someone will get wrong.
- **The template roots its store at `src/`, deliberately.** `nodeStore.list`
  walks recursively, and a store rooted at the project root would descend into
  `node_modules`. It does not bite in this workspace — pnpm's `node_modules`
  entries are symlinks and `readdir` does not follow them, so the walk finds 8
  files in 1ms — but a scaffolded project has a real `node_modules/.pnpm` tree
  and would. `packages/example-shop` roots at its package root and gets away
  with it for that reason only.
- **`src/adapter.ts` is the adapter contract, and it is the only copy.**
  `Adapter`, `AdapterConfig`, `CreateStore`, `DirectoryStore`, `FetchHandler`,
  `Serve`, `ServeHandle`, `ServeOptions` — both adapters import these instead of
  redeclaring them, which they used to do to avoid depending on `framework`.
  `packages/tests/framework/adapter-contract.test.ts` asserts both packages
  satisfy it, so a renamed or missing export fails `pnpm typecheck` rather than
  someone's call site. Two invariants survive the move and are worth keeping:
  `FetchHandler` stays `fetch` plus two optional hooks, so `serve` still hosts a
  bare `{ fetch }` object (each adapter has a test for that); and `serve.ts` and
  `store.ts` use `import type` only, so the sole runtime import of `framework`
  in an adapter is in `config.ts`.
  The store factory is deliberately **not** a member of `Adapter`: it is named
  for its runtime (`nodeStore`, `denoStore`) because that is what reads well at
  a call site, and conforms by satisfying `CreateStore`.
- **`src/site.ts` is the front door: `defineConfig` / `createSite` / `start`.**
  It is composition only — it calls `createApp` and registers the same plugins a
  user would by hand, so nothing here is reachable any other way. Four things
  worth keeping:
  - **`site.ts` is the portable half only.** It knows `store`, not `root`, and
    has no `start` — building a store from a directory and binding a port are
    exactly what a `Request`/`Response` runtime cannot do. Each adapter's
    `config.ts` re-exports `defineConfig` / `createSite` / `start` on top,
    adding `root`, `port` and `hostname`. That split is why a serverless config
    has no `port` on its type rather than one that does nothing, and why a user's
    config file names its runtime in a single import. An earlier version put an
    `adapter` value *inside* the config and kept adapters dependency-free; it was
    replaced because the two `defineConfig`s read better and the dependency is
    honest — verified that Deno resolves `framework` through the pnpm workspace
    symlink, so the Deno suite still runs.
  - **An adapter's `defineConfig` starts the server; `framework`'s does not.**
    The config file is the entry point (`node framework.config.ts`), so there is
    no `main.ts` anywhere. Two consequences worth knowing before editing:
    `listen: false` must keep working, because otherwise every test that calls
    `defineConfig` binds **port 3000**, the user's; and the port comes from the
    config, never from the adapter reading the environment — which is also what
    keeps `@erikt/framework-deno` from needing `--allow-env`.
  - **`fileRouter` is registered last**, after the user's `plugins`, so a route
    claimed by hand wins over a file route on the same path. Registration order
    is match priority.
  - **`not-found.ts` and `error.ts` at the store root are found by name**, by a
    `conventions` plugin, and only for whichever of `notFound` / `error` the
    config left undefined — an explicit one always wins. It is a plugin because
    `setup` may be async and `createSite` may not: importing a module is the
    store's job. Existence comes from a **listing**, not from catching a failed
    import, or a syntax error inside `not-found.ts` would be indistinguishable
    from not having one. A non-function default export is refused at startup,
    naming the file.
  - **`createSite` adds exactly one default over `createApp`**: `datastar:
    { client: true }`. A site serves its own runtime. Everything else is
    `createApp`'s defaults, passed through.
  - **`start` is the only part that needs an adapter**, because only an adapter
    can listen. `createSite` is the runtime-agnostic half and is what a Workers
    or Deno Deploy entry exports. Env reading (`PORT`) stays in the caller's
    entry file — `framework` may not touch `process`.
- **`assets` (`src/plugins/assets.ts`) serves a directory as-is**, and is the
  answer to what used to be the "should `example` serve client assets from
  disk" open question. The store supplies bytes plus `Content-Length` and
  `Last-Modified`; the plugin adds the `Content-Type` (from a MIME table keyed
  by extension), a **weak** `ETag` from size and mtime, `304` handling for
  `If-None-Match` / `If-Modified-Since`, and `206` / `416` for `Range`. All of
  that is identical on every runtime, which is why it is here and not in an
  adapter. Five things not to undo:
  - **It is middleware over a path map listed at setup, not a route per file.**
    A miss is a `Map` lookup and a fall-through — no disk read, and no pattern
    that could shadow a real route, which is what lets `base` default to `/`
    without swallowing `/`.
  - **The ETag is weak on purpose.** Hashing bytes would mean reading every file
    to answer a conditional request. Do not "strengthen" it without a cache.
  - **The body is buffered only for a range.** The plain path passes the store's
    response body straight through, so a streaming store keeps streaming.
  - **A content-type the store set wins over the table.** Note the trap when
    writing a store: `new Response('text')` sets `text/plain;charset=UTF-8` by
    itself, so a store must pass **bytes**, as `nodeStore` and `denoStore` do.
    A test double that passes a string will silently defeat the MIME table.
  - **There is no directory index.** Answering `/` with `public/index.html`
    would take a path the router almost certainly wants.
- **`scripts` (`src/plugins/scripts.ts`) serves browser code with no bundler.**
  At `setup` it lists a folder through the store, strips types, hashes the
  result and registers a GET route per file. It requires `store.read` and says
  so, by name, if it is missing.
- **Scripts are opt-in per route, not injected wholesale.** `useScript(c, …names)`
  is how a page, layout, component or stream declares a dependency; `injectHTML`
  emits a tag only for what was asked. Where the tag lands depends on what is
  rendering: a `defineRoute` with a layout puts it in the `<head>`, a
  `defineRoute` (or a layout-less page) appends it to the fragment, and a
  `defineStream` appends it to the head of the document already on screen, via a
  `datastar-patch-elements` with `selector head` and `mode append`. That last
  path goes through `src/head.ts`, not through the plugin. The flush happens
  **after** each event and once at close, not before, so an asset arrives once
  the markup it came with is in the DOM.
- **`patchPage` re-enters the app**, which is why `app.ts` puts `app.fetch` on
  the context bag under `app:fetch`. It renders the `Referer` (or a named route)
  and sends the markup as one patch with **no selector and no mode** — Datastar
  parses anything containing `</html>` with `DOMParser` and morphs it over
  `documentElement`, verified in the vendored bundle. Four things hold it
  together, none decorative:
  - **Five headers are stripped from the internal render.** `Accept-Encoding`
    above all: without it `compress` gzips the internal response and `.text()`
    returns bytes, not markup — the caveat the *Defaults* section warns about,
    reached from inside. Then `Range`, `If-None-Match` and `If-Modified-Since`
    (a 304 has no body) and `Datastar-Request` (or a route may answer with its
    fragment form).
  - **`X-Framework-Render: 1` marks the render**, and `patchPage` refuses when it
    sees it. Without that a page whose own render patches itself never
    terminates.
  - **Same-origin only, HTML only.** Both throw with the URL named rather than
    patching something useless into the document.
  - **A full-page morph re-applies `data-signals`**, so a literal default resets
    the signal. Do not try to "fix" that here — the answer is to render current
    state into the attribute, or to keep the signal `_`-prefixed and local.
- **An endpoint deliberately cannot target the head, and this was decided, not
  overlooked.** One HTTP response is one body with one target — Datastar's
  `datastar-selector`/`datastar-mode` headers describe a non-SSE response as a
  whole — so putting a fragment in `#panel` *and* a tag in `head` is two
  destinations, and two destinations need two events. The answer is
  `defineStream`, which costs one wrapper over `defineRoute`. Two things that
  look like fixes and are not: shipping a client-side runtime that hoists
  `<script>` out of fragments into the head, which would make `framework` ship
  browser JavaScript for the first time; and having `defineRoute` answer as
  SSE whenever `useScript` was called, which makes the content-type depend on
  whether a function was called mid-render. Ask before doing either. The wiring is worth understanding before changing
  it: `onRequest` puts the plugin's name → URL map on the context bag, so
  `useScript` can resolve **at the call site** and throw where the typo was
  written rather than deferring to injection time. That is one bag write per
  request and no allocation — the merge branch only allocates when a second
  `scripts` plugin is registered, and `injectHTML` filters to its own URLs so
  two plugins emit their own tags instead of both emitting everything. An
  unknown name does **not** throw: it gets a tag at an unhashed
  `${base}${name}.js`, which nothing serves, so the page renders and the browser
  reports one 404 naming the file. This used to throw and list the known names,
  on the grounds that a typo should fail where it was written — it took a whole
  page down over a deleted or misspelt asset, which is the wrong trade. Do not
  soften it further to a silent skip, which *is* how a script quietly stops
  loading: the tag has to be emitted for the 404 to be the signal. Unhashed is
  what keeps that URL from colliding with a real asset, since every served one
  carries a content hash. `useScript` needs the base to build it, so the plugin
  puts `scripts:base` on the bag next to the registry — the same thing `styles`
  does for `useStyle`. There is no "always"
  option on purpose — a layout runs for every page that asks for it, so calling
  `useScript` there is already the answer.
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
- There is **no linter or formatter**. The only CI is
  `.github/workflows/publish.yml`, which runs typecheck and the suite and then
  publishes any package whose version is not on the registry yet — see
  *Publishing*.
- `example` runs as a plain Node script. It is a Node consumer of a
  runtime-agnostic library — that asymmetry is expected.

### Publishing

- **What ships is JavaScript, and it has to be.** Node refuses to strip types
  from anything under `node_modules` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
  with no flag to turn it off. Publishing `.ts` produced a package that could not
  be imported *or* scaffolded from, and the monorepo never caught it: pnpm
  symlinks workspace packages, Node resolves the realpath, and
  `/packages/framework/src/index.ts` is not under `node_modules`. A real install
  copies the files in and the rule bites. Verify any change here by packing and
  installing the tarball, never by a workspace link.
- **`tsconfig.build.json` per publishable package** turns emit back on with
  `declaration` and `rewriteRelativeImportExtensions` — the last is what turns
  the `./app.ts` specifiers the source is written with into `./app.js`. `prepack`
  runs it, so a tarball cannot be made from stale output.
- **`publishConfig` swaps `exports` and `bin` to `dist/`** at pack time, which is
  why the on-disk manifest still points at `.ts` and the dev loop needs no build.
  Do not "simplify" this by pointing `exports` at `dist/` directly: that would
  make every test run and every `pnpm dev` depend on a build first.
- **`src/` ships alongside `dist/`.** `tsconfig.browser.json` maps
  `@erikt/framework/html` into `./src/`, and a consumer typechecking browser code
  needs that to resolve. TypeScript reads `.ts` under `node_modules` happily;
  only Node's runtime refuses to.
- **Publish with `pnpm publish`, never `npm publish`.** pnpm rewrites
  `workspace:*` to the real version; npm ships the literal string and the package
  is uninstallable. Order matters: `framework`, then the adapters, then
  `create-framework`.
- **Scoped packages need `publishConfig.access: "public"`**, or the publish is
  rejected as a private package.
- **Releases go through `.github/workflows/publish.yml`, triggered by an edit to
  any `packages/*/package.json`.** The trigger is the file; the decision is the
  version — the job asks the registry and publishes only what is missing, so
  editing a description does nothing, a re-run does nothing, and a half-failed
  run is fixed by running it again. Publishing by hand needs a second factor
  (the account is `auth-and-writes`); CI uses an automation token in
  `secrets.NPM_TOKEN`, which bypasses it.

[datastar]: https://data-star.dev


## Open questions — ask, don't guess

- **Whether `bun-adapter` or `workers-adapter` are wanted.** `@erikt/framework-deno`
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
- **TLS, HTTP/2 and WebSocket upgrade** are unimplemented in `@erikt/framework-node`.

## Verifying a change

```sh
pnpm test && pnpm typecheck
```

`pnpm dev` blocks — it is a server — and it binds the user's port 3000. Do not run
it to verify your own work; `pnpm test` covers the same paths on ephemeral ports.
If you must serve manually, use `PORT=4173 pnpm dev`.

If you changed `framework`'s public API, update `packages/example` to use it —
`framework.config.ts` for setup, or a route — so the example keeps proving the
API works.
