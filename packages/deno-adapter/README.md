# deno-adapter

Runs a `fetch` handler on [`Deno.serve`][serve], and implements `framework`'s
`FileStore` port against Deno's filesystem. Along with `node-adapter` and
`packages/tests`, this is one of the few places in the repo that may reach for a
runtime-specific API.

It is the second worked example of the two adapter ports; the procedure for
writing another is in [ADAPTERS.md](../../ADAPTERS.md).

```ts
import { createApp } from 'framework'
import { serve } from 'deno-adapter'

const app = createApp()

app.get('/', c => c.text('hello'))

const server = await serve(app, { port: 3000 })

console.log(`listening on ${server.url}`)

await server.close()
```

```sh
deno run --allow-net main.ts
```

## serve(handler, options?)

`handler` is anything with a `fetch(request): Response | Promise<Response>`
method — this framework's app, or any other WinterTC-style handler. The adapter
does not depend on `framework`.

| Option | Default | |
| --- | --- | --- |
| `port` | `3000` | `0` binds an ephemeral port; read the real one from the handle |
| `hostname` | `'localhost'` | |

Resolves once the server is listening, with a handle:

| | |
| --- | --- |
| `url` | e.g. `http://localhost:3000` |
| `hostname`, `port` | The bound address — `port` is resolved, not the requested `0` |
| `close()` | Shuts the server down, including idle keep-alive connections |

There is no request/response bridge here, because there is nothing to bridge:
`Deno.serve` hands the handler a `Request` and takes its `Response`, so the URL,
duplicate headers, streamed bodies in both directions, `set-cookie` splitting and
client-disconnect aborts are all Deno's own doing. What the adapter adds is the
handle, the `start` / `stop` calls, and the 500.

Two `Deno.serve` options are supplied rather than left to their defaults, and
both are deliberate: `onListen` because Deno otherwise announces the port on
stdout, and `onError` because Deno otherwise prints the stack trace. A throwing
handler gets the client a plain `500`, and nothing about the error.

`hostname` is reported back as it was given. Deno resolves `localhost` to `::1`
and reports *that* on `server.addr`, which would make for a surprising banner.

## denoStore(dir, options?)

The filesystem implementation of `framework`'s `FileStore`: walk `dir`, import a
module from it, read a file out of it.

```ts
import { createApp, fileRouter } from 'framework'
import { denoStore, serve } from 'deno-adapter'

const app = createApp()
const store = denoStore(new URL('./', import.meta.url))

app.plugin(fileRouter({ store, dir: 'routes' }))

await serve(app, { port: 3000 })
```

```sh
deno run --allow-net --allow-read main.ts
```

One store per app; each feature scopes itself with its own `dir`, so the same
store can back routes, layouts and assets.

`dir` is a `file:` URL or a path resolved against `Deno.cwd()`. A URL built from
`import.meta.url` is the portable form — it does not depend on where the process
was started, and it is the only form that needs no read permission on the working
directory.

| Option | Default | |
| --- | --- | --- |
| `name` | `'deno'` | Identifies the store in error messages |

| Method | |
| --- | --- |
| `list({ prefix, extensions })` | Every file under `dir`, recursively, as a `/`-separated relative path. No `stat` per file, so no `size` or `modified` — those come from `read` |
| `read(path)` | A `Response` **streaming** the file, with `content-length` and `last-modified`. `null` if the file is not there |
| `import(path)` | The module, imported through its `file:` URL — which is what lets a `[id].ts` filename load at all |

Both `read` and `import` refuse a path that would leave `dir`, so a traversal
attempt is an error rather than a file read.

Unlike `nodeStore`, `read` does not buffer: the body is `Deno.open`'s
`readable`, so a large asset is streamed to the client. The handle closes when
the stream is read to the end or cancelled — a `Response` that is never consumed
holds it open until collection. Neither store sets `content-type`; there is no
MIME table in the repo yet.

## Deno APIs used

`Deno.serve` for the server. `Deno.readDir`, `Deno.open`, `Deno.cwd` and
`Deno.errors.NotFound` for the store. That is the whole runtime-specific surface,
and there are **no `node:*` imports** — Deno supports them, but a web API exists
for everything else the adapter does.

Two consequences of the zero-dependency rule are worth knowing:

- **`Deno` is declared locally**, in the two modules that use it, rather than
  pulled in as a types package. `@types/deno` is unofficial and stale, and the
  repo forbids the dependency either way. The declarations cover only what is
  used, so `deno check src/index.ts` — which typechecks against Deno's own
  definitions — is the honest verification, and it passes.
- **Paths become `file:` URLs by hand**, because `node:url`'s `pathToFileURL` is
  out. `escapePath` percent-encodes only the characters the URL parser would
  otherwise act on — `\` becomes a separator, `?` and `#` truncate the path, and
  tab, newline and carriage return are dropped outright. A drive letter's `:`
  survives, which a general-purpose encoder would not have left alone.

## Permissions

| | |
| --- | --- |
| `serve` | `--allow-net` |
| `denoStore` | `--allow-read` — including the dynamic `import()` behind `store.import`, which is a runtime read |

Narrow them if you like: `--allow-net=localhost:3000` and
`--allow-read=./src` are enough for the example above.

## Limits

Plain-TCP HTTP/1.1, as `Deno.serve` provides it. TLS — and so the HTTP/2 that
Deno negotiates over it — and WebSocket upgrade are **not exposed** here, though
Deno supports all three. Add them to this package if you need them; they do not
belong in `framework`.

## Tests

In `packages/tests/deno-adapter/`, running the same conformance suite as
`node-adapter`. The harness is still `node --test`: the Node test spawns a real
Deno process — `server.ts` and `bare.ts` for the HTTP suite, `report.ts` for the
store — and asserts over the wire and over the JSON it prints. Tests skip
themselves where `deno` is not on `PATH`.

[serve]: https://docs.deno.com/api/deno/~/Deno.serve
