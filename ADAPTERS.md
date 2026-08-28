# Writing an adapter

`framework` targets the [WinterTC Minimum Common API][mca], so it runs unchanged
on Node, Deno, Bun, Cloudflare Workers and in browsers. What it cannot do is bind
a port or read a file — neither is in that API. An **adapter** supplies those.

`packages/node-adapter` and `packages/deno-adapter` are the worked examples. Read
one alongside this document; both are small enough to read in full. Node is the
one to copy if your runtime needs a request/response bridge, Deno if it hands you
a `Request` already.

## What an adapter is

Two ports, and you implement whichever ones your runtime needs:

| Port | Shape | Needed when |
| --- | --- | --- |
| **`serve`** | `(handler, { port, hostname }) => Promise<ServeHandle>` | The runtime hosts a server you start yourself — Node, Deno, Bun |
| **`FileStore`** | `{ name, list, read?, import? }` | Anything reads files — `fileRouter` today, layouts and assets later |

Workers-style runtimes need **no `serve` at all**: `export default app` is already
the entry shape they expect, because `app.fetch` is the whole server. If your
runtime is one of those, you are only writing a store.

### Rule 1 — an adapter does not depend on `framework`

`packages/node-adapter` has no dependency on `framework`, and yours should not
either. TypeScript is structural, so you declare the port's shape locally and any
`framework` app will accept it:

```ts
export type FileStoreLike = {
  name: string
  list(options?: ListOptionsLike): Promise<readonly FileEntryLike[]>
  read(path: string): Promise<Response | null>
  import(path: string): Promise<unknown>
}
```

Two reasons. An adapter's `serve` should host *any* WinterTC handler, not just
this one — `node-adapter` is tested against a bare `{ fetch }` object. And the
dependency graph stays one-way: `framework` defines ports, adapters fill them,
nothing points back.

### Rule 2 — prefer the web API even where the runtime's own is allowed

Inside an adapter, `node:*` (or `Deno.*`, or `Bun.*`) is permitted — that is the
point of the package. It is still not the default. `node-adapter` converts
streams with `new ReadableStream({ pull })` and `getReader()` rather than
importing `node:stream`, and `FileStore.read` returns a `Response` rather than a
runtime-specific file handle. Keep the runtime-specific surface as small as the
job allows, and say in your README exactly which imports you used.

## Scaffolding the package

```
packages/<runtime>-adapter/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts        # re-export barrel, nothing else
    serve.ts        # if the runtime hosts a server
    store.ts        # if the runtime reads files
```

`pnpm-workspace.yaml` already globs `packages/*`, so `pnpm install` picks it up
with no configuration.

```json
{
  "name": "bun-adapter",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "exports": { ".": "./src/index.ts" },
  "files": ["src"],
  "scripts": { "typecheck": "pnpm dlx --package=typescript tsc" },
  "devDependencies": { "@types/node": "^26.4.0" }
}
```

Types only, never a runtime dependency — the zero-dependency rule covers the
whole repo. Swap `@types/node` for whatever your runtime publishes
(`@cloudflare/workers-types`, `@types/bun`); if it publishes nothing usable,
drop `devDependencies` entirely, declare the globals you use yourself and say so
in the README. That is what `deno-adapter` does — `@types/deno` is unofficial and
stale — and it costs about ten lines of `declare const`, split across the two
modules that need them. Note that a `declare const` shadows the real global, so
tsc cannot catch drift from it; a runtime test is what proves the declaration
right.

`tsconfig.json` is `packages/node-adapter/tsconfig.json` with `types` changed —
or, with no types package at all, `"types": []` plus the `DOM` lib for the web
types, which is `packages/deno-adapter/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "types": ["node"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

**Do not touch the root `tsconfig.json`.** It covers `packages/framework/src`
only, with `"types": []`, and that is what forbids Node from the portable
package. `pnpm typecheck` runs it and then `pnpm -r typecheck`, so your package's
own config is picked up automatically by its `typecheck` script.

Finally, add a row to the table at the top of `AGENTS.md`, so the next reader
knows the package exists.

## Port A — `serve`

```ts
export type FetchHandler = {
  fetch(request: Request): Response | Promise<Response>
  start?(info: { url?: string; hostname?: string; port?: number }): unknown
  stop?(): unknown
}

export type ServeHandle = {
  url: string        // 'http://localhost:3000'
  hostname: string
  port: number       // resolved — never the requested 0
  close(): Promise<void>
}

export function serve(handler: FetchHandler, options?: ServeOptions): Promise<ServeHandle>
```

Resolve **once the server is listening**, not before, and reject if binding
fails. Defaults are `port: 3000` and `hostname: 'localhost'`.

Three things about the handler are easy to miss:

- **Call `handler.start({ url, hostname, port })`** once you know the bound port.
  That is what gives the startup banner a URL to print. Do not await it —
  `app.fetch` awaits its own startup internally, so a request that arrives in
  that window still waits for plugin setup rather than racing it.
- **Call `handler.stop()` from `close()`**, before tearing the server down.
- **Both are optional.** A bare `{ fetch }` object must work.

### What the bridge has to get right

| | |
| --- | --- |
| **URL** | Reconstruct the absolute URL. Over HTTP/1.1 that means the `Host` header, with the bound address as the fallback |
| **Method and headers** | All of them, **preserving duplicates** — append, never set |
| **Request body** | Streamed for anything other than `GET`/`HEAD`, with backpressure. Do not buffer |
| **Abort** | A client disconnect aborts `request.signal` |
| **Response status and headers** | Verbatim, and **multiple `set-cookie` headers stay separate** — `Headers.getSetCookie()` |
| **Response body** | Streamed, honouring backpressure. `null` body means no body |
| **Errors** | If the handler throws and nothing has been sent, reply `500` yourself. Never leak the error to the client |
| **`port: 0`** | Bind an ephemeral port and report the real one on the handle |

The last one is not optional: every test in this repo binds `port: 0`, because
port 3000 belongs to the user.

## Port B — `FileStore`

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

### Decide your capabilities honestly

`list` is required. `read` and `import` are optional, and **omitting one is a
supported answer** — a feature that needs a missing method fails at `start()`
naming your store, which is far better than a method that pretends.

| Your runtime | `list` | `import` | `read` |
| --- | --- | --- | --- |
| Real filesystem at boot (Node, Deno, Bun, Vercel Node functions) | walk the directory | dynamic import by path | the filesystem |
| No filesystem (Workers, Vercel Edge, browsers) | **not implementable at runtime** — bake it, see below | a static import map | the platform's asset binding |

### The path contract

Every store must agree on these, or stores are not interchangeable:

- paths are **relative** to the store root, `/`-separated on every platform, with
  no leading `/` and no `.` or `..` segment
- **NFC-normalized.** macOS reports `café.ts` decomposed; without normalizing,
  one file is two routes depending on where the store runs
- case is preserved and significant
- the order you return is meaningless — consumers sort

`framework`'s `listFiles` enforces all of this and throws naming your store if
you break it, so a violation shows up on the first test rather than in
production. Derive relative paths through a URL rather than string-slicing native
paths, which is how `node-adapter` gets `/` separators on Windows for free.

### What a store must not do

- **Do not filter.** No skipping dotfiles, no hiding `_private.ts`, no extension
  guesses of your own. Which files are routes is `fileRouter`'s business; which
  are layouts will be the layout feature's. `ListOptions` is a *hint* you may
  honour for speed — `listFiles` re-applies both filters regardless, so the
  cheapest correct store ignores it and returns everything.
- **Do not sort.** The consumer does, deterministically.
- **Do not `stat` every file** just to fill in `size` and `modified`. They are
  optional. `nodeStore` leaves them out of `list` and sets them from `read`.

### `read` returns a `Response`

Not bytes, not a stream, not a file handle. Every runtime's asset story is
already fetch-shaped, so this is usually the shortest implementation available —
and it carries content-type, `ETag` and `Last-Modified` along with the body.

`null` means **absent**; the consumer picks the status. Anything else — a
permission error, a corrupt archive — throws.

Refuse a path that would escape the store root, in `read` **and** `import`.
`listFiles` validates what comes *out* of a store; nothing validates what a
caller passes *in*, so that check is yours:

```ts
if (path === '' || path.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(path)) {
  throw new TypeError(`Refusing to resolve ${JSON.stringify(path)} outside the store`)
}
```

### When the runtime cannot enumerate

Workers, Vercel Edge and browsers have nothing to walk, and their bundlers need
every import to be statically visible. So the listing is produced at deploy time
by a runtime that *does* have a filesystem, and `framework` ships the pure half
of that:

```ts
// scripts/bake.ts — run with Node, Deno or Bun before deploying
import { generateStore } from 'framework'
import { nodeStore } from 'node-adapter'
import { writeFile } from 'node:fs/promises'

const entries = await nodeStore('src').list({ prefix: 'routes/' })

await writeFile('src/generated-store.ts', generateStore(entries, { base: './' }))
```

The generated file is a `staticStore` with a static import map — sorted, and
without timestamps, so it is stable enough to commit. Your adapter's job is only
to graft the platform's bytes onto it with `withRead`. There may be nothing left
to write.

## Cookbook

**These are sketches, not tested code**, with one exception: the Deno pair below
grew into `packages/deno-adapter`, so read that instead of retyping this. Bun is
still not installed here, and nothing under *Bun*, *Cloudflare Workers* or
*Vercel* has been run — the conformance checklist in the next section is how you
find out whether yours works.

### Deno

Shipped as `packages/deno-adapter`. What the real thing added to this sketch, all
of it found by running the checklist: `Deno.serve` also wants `onError`, or it
prints the stack trace for a throwing handler; `server.addr.hostname` is `::1`
when you asked for `localhost`, so the handle has to report back the hostname it
was *given*; and `Deno.serve` throws synchronously on a port conflict, which an
`async` function turns into the rejection the port contract asks for.

```ts
export function serve(handler: FetchHandler, options: ServeOptions = {}): Promise<ServeHandle> {
  const hostname = options.hostname ?? 'localhost'
  const server = Deno.serve(
    { port: options.port ?? 3000, hostname, onListen: () => {} },
    request => handler.fetch(request),
  )
  const port = server.addr.port
  const url = `http://${hostname}:${port}`

  void handler.start?.({ url, hostname, port })

  return Promise.resolve({
    url,
    hostname,
    port,
    async close() {
      await handler.stop?.()
      await server.shutdown()
    },
  })
}
```

`Deno.serve` hands you a `Request` and takes a `Response`, so there is no bridge
to write — most of the work is the handle. The store walks with `Deno.readDir`
and, unlike `nodeStore`, can stream:

```ts
async read(path: string) {
  try {
    const file = await Deno.open(new URL(path, root))
    const info = await file.stat()

    return new Response(file.readable, {
      headers: { 'content-length': String(info.size) },
    })
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null

    throw error
  }
}
```

### Bun

```ts
const server = Bun.serve({ port, hostname, fetch: request => handler.fetch(request) })
// server.port, server.hostname, server.stop(true)
```

`Bun.file(path)` is a `Blob` with `size` and `lastModified`, and
`new Response(Bun.file(path))` already sets `content-type` from the extension —
so `read` is close to one line. `new Bun.Glob('**/*').scan({ cwd })` gives
`/`-separated relative paths, which is exactly the contract.

### Cloudflare Workers

No `serve`. One wrinkle worth knowing before you start: **`env` does not exist at
module scope**, so a store that reads through the assets binding has to be bound
on the first request.

```ts
import { createApp, fileRouter, withRead } from 'framework'
import { store as baked } from './generated-store.ts'

type Assets = { fetch(request: Request): Promise<Response> }

let assets: Assets | undefined

const store = withRead(baked, async path => {
  const response = await assets?.fetch(new Request(`https://assets/${path}`))

  return response === undefined || response.status === 404 ? null : response
})

const app = createApp({ banner: false }).plugin(fileRouter({ store, dir: 'routes' }))

export default {
  fetch(request: Request, env: { ASSETS: Assets }) {
    assets ??= env.ASSETS

    return app.fetch(request)
  },
}
```

`banner: false` because there is no startup to announce and no TTY to announce it
to. Note also that `ctx.waitUntil` has nowhere to go in the plugin hooks today —
see *Open questions* in `AGENTS.md`.

### Vercel

Two runtimes, two answers. **Node functions** have a filesystem, so `nodeStore`
works as-is — but the bundler traces only static references, so files nothing
imports get dropped from the deployment. Either declare them
(`functions: { '…': { includeFiles: 'routes/**' } }`) or bake the store, which
sidesteps the problem entirely. **Edge functions** have no filesystem: bake it,
like Workers.

## Testing your adapter

All tests for the whole repo live in `packages/tests`, one directory per package
under test — so yours go in `packages/tests/<runtime>-adapter/`. Import through
the package name, never a relative path into `src/`, and assert on observable
behavior only.

**A caveat you will hit immediately:** the harness is `node --test`, so a Node
process is what runs the tests, and a `serve` that only exists inside another
runtime cannot be imported into it. Running `deno test` or `bun test` from this
repo would mean a second harness, which the testing rules currently forbid —
**ask before adding one** rather than quietly introducing it.

`packages/tests/deno-adapter/` shows the way around it that needs no permission:
the Node test **spawns the other runtime as a subprocess** and asserts from
outside. `server.ts` and `bare.ts` start the adapter's `serve` on `port: 0` and
print `url=…`; the Node test reads that line and runs the whole HTTP suite
against the real server with `fetch` — and, for the framing, a raw socket.
`report.ts` exercises the store and prints one JSON object; the Node test
`JSON.parse`s it and asserts on the pieces, so every assertion still lives in
`node:test`. The three helper scripts are named so `node --test` does not try to
run them, and every test carries
`{ skip: denoInstalled ? false : 'deno is not installed' }` so the suite still
passes on a machine without the runtime.

Copy these behaviours from `packages/tests/node-adapter/`; they are the
conformance suite in all but name.

`serve.test.ts`:

| | |
| --- | --- |
| serves a response over http | binds an ephemeral port and reports it |
| passes path params through | passes the query string through |
| forwards request headers | reads a request body |
| forwards response status and headers | sends multiple set-cookie headers separately |
| streams a streamed response body | serves the 404 from the app |
| a redirect reaches the client | follows a redirect to the new location |
| a HEAD request returns headers without a body | a throwing handler becomes a 500 |
| serves any fetch handler, not just this framework | close stops accepting connections |
| reads a streamed request body | handles a large response body without truncating |
| compressed responses survive the http bridge | the bytes on the wire are gzip when the client asks for it |

`store.test.ts`:

| | |
| --- | --- |
| lists every file as a path relative to the directory | the listing can be narrowed by prefix and extension |
| a directory given as a path works as well as a url | a module with a bracketed filename imports |
| reading a file returns its bytes with its metadata | reading a file that is not there returns null |
| reading refuses to leave the directory | an app serves the routes it finds on disk |
| the routes found on disk are reported in a stable order | a store generated from a listing serves the same routes |

That last one is the one that proves portability: list with your store, run the
entries through `generateStore`, import the result, and assert the baked app's
`routes` deep-equal the live one's.

Then:

```sh
pnpm test && pnpm typecheck
```

## Pitfalls, all of them already paid for once

- **Bracketed filenames.** `[id].ts` only imports through a percent-encoded file
  URL on Node — `pathToFileURL` handles it, hand-built strings may not.
- **Directory order is meaningless.** It varies by filesystem and platform. Never
  let route priority depend on it; `framework` sorts, and your store must not.
- **Decomposed unicode.** See the path contract. It bites only on macOS, which is
  to say it bites in development and not in CI.
- **`Host` is how you learn the URL** over HTTP/1.1. Fall back to the bound
  address, never to a hardcoded origin.
- **A compressed `Response` does not decode on `.text()`.** Only real HTTP
  clients decompress, which is why unit tests pass `{ compress: false }` and the
  bridge tests use `fetch` against a real server.
- **`.d.ts` files and dotfiles are not the store's problem.** Return them; the
  consumer filters.
- **Do not polyfill `URLPattern`.** It is in the Minimum Common API and a
  polyfill would be a dependency. If your runtime lacks it, that runtime is out
  of scope for now — say so in the README.

[mca]: https://min-common-api.proposal.wintertc.org
