# node-adapter

Runs a `fetch` handler on Node's `node:http`, and implements `framework`'s
`FileStore` port against the filesystem. This is the only package in the repo,
besides the tests, that may import `node:*`.

It is also the reference for the two adapter ports: writing the same pair for
Deno, Bun, Workers or Vercel is documented in [ADAPTERS.md](../../ADAPTERS.md).

```ts
import { createApp } from 'framework'
import { serve } from 'node-adapter'

const app = createApp()

app.get('/', c => c.text('hello'))

const server = await serve(app, { port: 3000 })

console.log(`listening on ${server.url}`)

await server.close()
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
| `close()` | Closes the server and its open connections |

## nodeStore(dir, options?)

The filesystem implementation of `framework`'s `FileStore`. `framework` cannot
read a directory, so it defines the port and this fills it in: walk `dir`, import
a module from it, read a file out of it.

```ts
import { createApp, fileRouter } from 'framework'
import { nodeStore, serve } from 'node-adapter'

const app = createApp()
const store = nodeStore(new URL('./', import.meta.url))

app.plugin(fileRouter({ store, dir: 'routes' }))

await serve(app, { port: 3000 })
```

One store per app; each feature scopes itself with its own `dir`, so the same
store can back routes, layouts and assets.

`dir` is a `file:` URL or a path resolved against the working directory. A URL
built from `import.meta.url` is the portable form — it does not depend on where
the process was started.

| Option | Default | |
| --- | --- | --- |
| `name` | `'node'` | Identifies the store in error messages |

| Method | |
| --- | --- |
| `list({ prefix, extensions })` | Every file under `dir`, recursively, as a `/`-separated relative path. No `stat` per file, so no `size` or `modified` — those come from `read` |
| `read(path)` | A `Response` carrying the bytes, `content-length` and `last-modified`. `null` if the file is not there |
| `import(path)` | The module, imported through its `file:` URL — which is what lets a `[id].ts` filename load at all |

Both `read` and `import` refuse a path that would leave `dir`, so a traversal
attempt is an error rather than a file read.

Reads are whole-file: `read` buffers the contents rather than streaming them.
Fine for route modules and layouts, and worth revisiting when something in
`framework` serves large assets.

## Node imports

Four: `node:http` for the server, and `node:fs/promises` plus `node:path` and
`node:url` for `nodeStore`. Everything else is a web API even where a Node one
exists — which is also why `read` returns a `Response` rather than a Node stream.

Stream conversion uses the web [Streams API][streams] rather than `node:stream` —
a `ReadableStream` with a `pull` source for the request body, and `getReader()`
for the response — so the Node surface stays as small as the bridge allows.
Backpressure is preserved in both directions: `pull` only reads when the consumer
asks, and writes wait for `drain`.

[streams]: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API

## What the bridge does

- **Request:** method, URL (from the `Host` header), and all headers, preserving
  duplicates. A body is streamed in for anything other than `GET`/`HEAD`. Client
  disconnects abort `request.signal`.
- **Response:** status, headers, and a streamed body. Multiple `set-cookie`
  headers are sent as separate headers rather than joined.
- **Errors:** if the handler throws and nothing has been sent yet, the client
  gets a plain 500.

## Limits

HTTP/1.1 over plain TCP only — no TLS, no HTTP/2, no WebSocket upgrade. Add them
here if you need them; they do not belong in `framework`.
