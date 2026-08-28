import type { Handler } from '../app.ts'
import type { Context } from '../context.ts'
import { html } from '../helpers/html.ts'
import type { Plugin } from '../plugin.ts'
import { DATASTAR_CLIENT, DATASTAR_VERSION } from './datastar-client.ts'
import { takeScriptTags } from './scripts.ts'

export type Signals = Record<string, unknown>

export type PatchMode =
  | 'outer'
  | 'inner'
  | 'replace'
  | 'prepend'
  | 'append'
  | 'before'
  | 'after'
  | 'remove'

export type PatchElementsOptions = {
  selector?: string
  mode?: PatchMode
  namespace?: 'svg' | 'mathml'
  useViewTransition?: boolean
  viewTransitionSelector?: string
}

export type PatchSignalsOptions = {
  onlyIfMissing?: boolean
}

export type DatastarStream = {
  readonly closed: boolean
  patchElements(elements: string, options?: PatchElementsOptions): void
  patchSignals(signals: unknown, options?: PatchSignalsOptions): void
  removeElements(selector: string): void
  event(name: string, lines: readonly string[]): void
  close(): void
}

export type StreamRender = (stream: DatastarStream, c: Context) => void | Promise<void>

export type DatastarOptions = {
  param?: string
  client?: boolean
}

const PATCH_ELEMENTS = 'datastar-patch-elements'
const PATCH_SIGNALS = 'datastar-patch-signals'

const SIGNALS = 'datastar:signals'

const DEFAULT_PARAM = 'datastar'

const CLIENT_URL = `/datastar-${DATASTAR_VERSION}.js`

const CLIENT_HEADERS = {
  'content-type': 'text/javascript; charset=utf-8',
  // The version is in the path, so a given URL never changes what it serves.
  'cache-control': 'public, max-age=31536000, immutable',
}

const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json\b/i

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  // no-transform is what keeps compress off this response. That middleware
  // peeks up to its threshold before deciding, which would hold the first
  // events of a long-lived stream back until enough bytes had accumulated.
  'cache-control': 'no-cache, no-transform',
}

function dataLines(key: string, value: string): string[] {
  return String(value)
    .trim()
    .split(/\r?\n/)
    .map(line => `${key} ${line}`)
}

function frame(name: string, lines: readonly string[]): string {
  return `event: ${name}\n${lines.map(line => `data: ${line}\n`).join('')}\n`
}

export function defineStream(render: StreamRender): Handler {
  return c => {
    let open = true
    let controller: ReadableStreamDefaultController<string> | null = null

    function write(name: string, lines: readonly string[]): void {
      if (!open || controller === null) return

      controller.enqueue(frame(name, lines))
    }

    // A page puts a useScript tag in the layout's head; a stream has no
    // document to render, so it appends the tag to the head of the one already
    // on screen. Flushed after the event rather than before it, so a script
    // lands once the markup it came with is in the DOM.
    function flush(): void {
      for (const tag of takeScriptTags(c)) {
        write(PATCH_ELEMENTS, ['selector head', 'mode append', ...dataLines('elements', tag)])
      }
    }

    function send(name: string, lines: readonly string[]): void {
      write(name, lines)
      flush()
    }

    const stream: DatastarStream = {
      get closed() {
        return !open
      },

      patchElements(elements, options = {}) {
        const lines: string[] = []

        if (options.selector !== undefined) lines.push(`selector ${options.selector}`)
        if (options.mode !== undefined) lines.push(`mode ${options.mode}`)
        if (options.namespace !== undefined) lines.push(`namespace ${options.namespace}`)
        if (options.useViewTransition === true) lines.push('useViewTransition true')
        if (options.viewTransitionSelector !== undefined) {
          lines.push(`viewTransitionSelector ${options.viewTransitionSelector}`)
        }

        send(PATCH_ELEMENTS, [...lines, ...dataLines('elements', elements)])
      },

      patchSignals(signals, options = {}) {
        const lines = options.onlyIfMissing === true ? ['onlyIfMissing true'] : []
        const encoded = JSON.stringify(signals)

        send(PATCH_SIGNALS, [
          ...lines,
          ...dataLines('signals', encoded === undefined ? 'null' : encoded),
        ])
      },

      removeElements(selector) {
        send(PATCH_ELEMENTS, [`selector ${selector}`, 'mode remove'])
      },

      event(name, lines) {
        send(name, lines)
      },

      close() {
        if (!open) return

        // Last chance for a stream that asked for a script and sent nothing.
        flush()

        open = false
        controller?.close()
      },
    }

    const source = new ReadableStream<string>({
      start(active) {
        controller = active

        // The status line is already on the wire by the time render runs, so a
        // throw can no longer become a 500 — erroring the stream is all that is
        // left. Report failures to the client by patching, the Datastar way.
        void (async () => {
          try {
            await render(stream, c)
            stream.close()
          } catch (error) {
            open = false
            active.error(error)
          }
        })()
      },

      cancel() {
        open = false
      },
    })

    // A dropped connection has to stop a render that loops on `closed`, and
    // cancel() is not guaranteed to run before its next iteration.
    c.req.signal.addEventListener('abort', () => {
      open = false
    }, { once: true })

    return c.body(source.pipeThrough(new TextEncoderStream()), { headers: SSE_HEADERS })
  }
}

function parseSignals(raw: string | null): Signals {
  if (raw === null || raw === '') return {}

  try {
    const value: unknown = JSON.parse(raw)

    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Signals)
      : {}
  } catch {
    // This hook runs on every request, including ones that were never meant for
    // Datastar, so unreadable input means "no signals" rather than a 500.
    return {}
  }
}

async function requestSignals(c: Context, param: string): Promise<Signals> {
  const method = c.req.method.toUpperCase()

  if (method === 'GET' || method === 'HEAD') return parseSignals(c.url.searchParams.get(param))

  if (c.req.body === null) return {}
  if (!JSON_TYPE.test(c.req.headers.get('content-type') ?? '')) return {}

  try {
    // Cloned so the handler still gets the body it was sent.
    return parseSignals(await c.req.clone().text())
  } catch {
    return {}
  }
}

export function readSignals<T extends Signals = Signals>(c: Context): T {
  return (c.get(SIGNALS) as T | undefined) ?? ({} as T)
}

export function datastar(options: DatastarOptions = {}): Plugin {
  const param = options.param ?? DEFAULT_PARAM
  const client = options.client ?? false

  return {
    name: 'datastar',

    setup(app) {
      if (!client) return

      app.get(CLIENT_URL, c => c.body(DATASTAR_CLIENT, { headers: CLIENT_HEADERS }))
    },

    // Documents only. The runtime is a page-wide concern, and a fragment is
    // patched into a page that is already running it.
    injectHTML(_c, target) {
      if (!client || target === 'fragment') return

      return { head: String(html`<script type="module" src="${CLIENT_URL}"></script>`) }
    },

    async onRequest(c) {
      c.set(SIGNALS, await requestSignals(c, param))
    },
  }
}
