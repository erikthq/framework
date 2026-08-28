export type ResponseOptions = number | ResponseInit

// Derived from the lib in scope rather than naming BodyInit, which DOM and
// @types/node do not both declare.
export type ResponseBody = ConstructorParameters<typeof Response>[0]

// The per-request bag's keys, as an interface so an app can name its own and
// get them back typed:
//
//   declare module 'framework' {
//     interface ContextBag {
//       user: { id: number }
//     }
//   }
//
// The keys the framework's own plugins use are declared here rather than in
// each plugin, so the whole set is reviewable in one place and nothing collides
// with an app's key by accident.
export interface ContextBag {
  'logger:started': number
  'datastar:signals': Record<string, unknown>
  'scripts:registry': ReadonlyMap<string, string>
  'scripts:used': Set<string>
  'scripts:taken': number
}

// The `string & {}` half keeps an unknown key working. Written as an
// intersection rather than plain `string` because a union with `string` widens
// to `string` and the editor stops offering the keys above — which is the whole
// point of the interface.
export type ContextKey = keyof ContextBag | (string & {})

export type ContextValue<K> = K extends keyof ContextBag ? ContextBag[K] : unknown

export type Context = {
  req: Request
  url: URL
  params: Record<string, string | undefined>
  header(name: string, value: string): void
  status(code: number): void
  set<K extends ContextKey>(key: K, value: ContextValue<K>): void
  get<K extends ContextKey>(key: K): ContextValue<K> | undefined
  body(body: ResponseBody, options?: ResponseOptions): Response
  text(body: string, options?: ResponseOptions): Response
  json(value: unknown, options?: ResponseOptions): Response
  html(body: string, options?: ResponseOptions): Response
  redirect(location: string | URL, status?: number): Response
}

export function createContext(
  req: Request,
  url: URL,
  params: Record<string, string | undefined>,
): Context {
  const pending = new Headers()
  const store = new Map<string, unknown>()
  let pendingStatus: number | undefined

  function build(
    body: ResponseBody,
    options: ResponseOptions | undefined,
    defaultType?: string,
  ): Response {
    const headers = new Headers(pending)
    let status = pendingStatus ?? 200
    let statusText: string | undefined

    if (typeof options === 'number') {
      status = options
    } else if (options !== undefined) {
      if (options.status !== undefined) status = options.status
      if (options.statusText !== undefined) statusText = options.statusText

      for (const [name, value] of new Headers(options.headers)) headers.set(name, value)
    }

    // Must be set before constructing: Response defaults a string body's
    // content-type to text/plain, so patching it afterwards is too late.
    if (defaultType !== undefined && !headers.has('content-type')) {
      headers.set('content-type', defaultType)
    }

    return new Response(
      body,
      statusText === undefined ? { status, headers } : { status, statusText, headers },
    )
  }

  return {
    req,
    url,
    params,

    header(name, value) {
      pending.set(name, value)
    },

    status(code) {
      pendingStatus = code
    },

    set<K extends ContextKey>(key: K, value: ContextValue<K>) {
      store.set(key, value)
    },

    get<K extends ContextKey>(key: K) {
      return store.get(key) as ContextValue<K> | undefined
    },

    body(body, options) {
      return build(body, options)
    },

    text(body, options) {
      return build(body, options, 'text/plain; charset=utf-8')
    },

    json(value, options) {
      return build(JSON.stringify(value), options, 'application/json; charset=utf-8')
    },

    html(body, options) {
      return build(body, options, 'text/html; charset=utf-8')
    },

    redirect(location, status = 302) {
      const response = build(null, status)

      response.headers.set('location', String(location))

      return response
    },
  }
}
