import { createContext } from './context.ts'
import type { Context } from './context.ts'
import { compress } from './middleware/compress.ts'
import type { CompressOptions } from './middleware/compress.ts'
import { insertMarkup, withMarkup } from './page.ts'
import type { Layout } from './page.ts'
import { describePattern, detectRuntime } from './plugin.ts'
import type { InjectTarget, Plugin, RouteInfo, StartInfo } from './plugin.ts'
import { banner } from './plugins/banner.ts'
import type { BannerOptions } from './plugins/banner.ts'
import { datastar } from './plugins/datastar.ts'
import type { DatastarOptions } from './plugins/datastar.ts'
import { logger } from './plugins/logger.ts'
import type { LoggerOptions } from './plugins/logger.ts'
import { createRouter } from './router.ts'
import type { Router, RoutePattern } from './router.ts'

export type Handler = (c: Context) => Response | Promise<Response>

export type Middleware = (
  c: Context,
  next: () => Promise<Response>,
) => Response | Promise<Response>

export type ErrorHandler = (error: unknown, c: Context) => Response | Promise<Response>

export type Method =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'ALL'

export type AppOptions = {
  base?: string | URL
  banner?: boolean | BannerOptions
  compress?: boolean | CompressOptions
  datastar?: boolean | DatastarOptions
  logger?: boolean | LoggerOptions
  layout?: Layout
}

export type App = {
  routes: readonly RouteInfo[]
  plugin(plugin: Plugin): App
  start(info?: Partial<StartInfo>): Promise<StartInfo>
  stop(): Promise<void>
  on(method: Method, pattern: RoutePattern, handler: Handler): App
  get(pattern: RoutePattern, handler: Handler): App
  post(pattern: RoutePattern, handler: Handler): App
  put(pattern: RoutePattern, handler: Handler): App
  patch(pattern: RoutePattern, handler: Handler): App
  delete(pattern: RoutePattern, handler: Handler): App
  options(pattern: RoutePattern, handler: Handler): App
  head(pattern: RoutePattern, handler: Handler): App
  all(pattern: RoutePattern, handler: Handler): App
  use(middleware: Middleware): App
  use(pattern: RoutePattern, middleware: Middleware): App
  notFound(handler: Handler): App
  onError(handler: ErrorHandler): App
  fetch(request: Request): Promise<Response>
}

type RouteEntry = {
  method: Method
  handler: Handler
}

type MiddlewareEntry = {
  middleware: Middleware
}

const DEFAULT_BASE = 'http://localhost/'

function methodMatches(entry: Method, method: string): boolean {
  return entry === 'ALL' || entry === method
}

export function createApp(options: AppOptions = {}): App {
  const base = options.base ?? DEFAULT_BASE
  const { layout } = options
  const routes: { pattern: RoutePattern; data: RouteEntry }[] = []
  const middlewares: { pattern: RoutePattern; data: MiddlewareEntry }[] = []

  const plugins: Plugin[] = []
  let starting: Promise<StartInfo> | null = null

  let routeRouter: Router<RouteEntry> | null = null
  let middlewareRouter: Router<MiddlewareEntry> | null = null

  let handleNotFound: Handler = c => c.text('404 Not Found', 404)
  let handleError: ErrorHandler = () => new Response('500 Internal Server Error', { status: 500 })

  function routeInfo(): RouteInfo[] {
    return routes.map(route => ({
      method: route.data.method,
      pattern: describePattern(route.pattern),
    }))
  }

  // Only ever reached through withLayout, so a route that serves no layout
  // never pays for the loop and never has its response rewritten.
  async function injectHTML(html: string, c: Context, target: InjectTarget): Promise<string> {
    let head = ''
    let body = ''

    for (const plugin of plugins) {
      const injection = await plugin.injectHTML?.(c, target)

      if (injection === undefined) continue

      head += injection.head ?? ''
      body += injection.body ?? ''
    }

    return insertMarkup(html, head, body)
  }

  function start(info: Partial<StartInfo> = {}): Promise<StartInfo> {
    starting ??= (async () => {
      for (const plugin of plugins) await plugin.setup?.(app)

      const resolved: StartInfo = {
        runtime: info.runtime ?? detectRuntime(),
        routes: routeInfo(),
        plugins: plugins.map(plugin => plugin.name),
        startedAt: info.startedAt ?? Date.now(),
        ...(info.url === undefined ? {} : { url: info.url }),
        ...(info.hostname === undefined ? {} : { hostname: info.hostname }),
        ...(info.port === undefined ? {} : { port: info.port }),
      }

      for (const plugin of plugins) await plugin.onStart?.(resolved)

      return resolved
    })()

    return starting
  }

  const app: App = {
    get routes() {
      return routeInfo()
    },

    plugin(plugin) {
      plugins.push(plugin)

      return app
    },

    start,

    async stop() {
      for (const plugin of plugins) await plugin.onStop?.()

      starting = null
    },

    on(method, pattern, handler) {
      routes.push({ pattern, data: { method, handler: withMarkup(handler, layout, injectHTML) } })
      routeRouter = null

      return app
    },

    get(pattern, handler) {
      return app.on('GET', pattern, handler)
    },
    post(pattern, handler) {
      return app.on('POST', pattern, handler)
    },
    put(pattern, handler) {
      return app.on('PUT', pattern, handler)
    },
    patch(pattern, handler) {
      return app.on('PATCH', pattern, handler)
    },
    delete(pattern, handler) {
      return app.on('DELETE', pattern, handler)
    },
    options(pattern, handler) {
      return app.on('OPTIONS', pattern, handler)
    },
    head(pattern, handler) {
      return app.on('HEAD', pattern, handler)
    },
    all(pattern, handler) {
      return app.on('ALL', pattern, handler)
    },

    use(patternOrMiddleware: RoutePattern | Middleware, maybeMiddleware?: Middleware) {
      const isBare = typeof patternOrMiddleware === 'function'
      const pattern = isBare ? '/*' : patternOrMiddleware
      const middleware = isBare ? patternOrMiddleware : maybeMiddleware

      if (middleware === undefined) throw new TypeError('use() requires a middleware function')

      middlewares.push({ pattern, data: { middleware } })
      middlewareRouter = null

      return app
    },

    notFound(handler) {
      handleNotFound = withMarkup(handler, layout, injectHTML)

      return app
    },

    onError(handler) {
      handleError = handler

      return app
    },

    async fetch(request) {
      // Guarantees no request is served before plugin setup and onStart finish,
      // however late the caller gets around to calling start().
      await start()

      const url = new URL(request.url, base)

      // Compiled once and reused; registering a route invalidates the cache.
      routeRouter ??= createRouter(routes, { base })
      middlewareRouter ??= createRouter(middlewares, { base })

      const pathMatches = routeRouter.matchAll(url)
      const method = request.method.toUpperCase()

      let matched = pathMatches.find(match => methodMatches(match.route.data.method, method))

      // A HEAD with no HEAD route falls back to GET, minus the body.
      const headFallback = matched === undefined && method === 'HEAD'
      if (headFallback) {
        matched = pathMatches.find(match => methodMatches(match.route.data.method, 'GET'))
      }

      const c = createContext(request, url, matched?.params ?? {})

      const chain = middlewareRouter.matchAll(url).map(match => match.route.data.middleware)

      async function terminal(): Promise<Response> {
        if (matched === undefined) {
          if (pathMatches.length === 0) return handleNotFound(c)

          const allowed = [...new Set(pathMatches.map(match => match.route.data.method))]
            .filter(entry => entry !== 'ALL')
            .join(', ')

          return c.text('405 Method Not Allowed', {
            status: 405,
            headers: allowed === '' ? {} : { allow: allowed },
          })
        }

        return matched.route.data.handler(c)
      }

      async function dispatch(index: number): Promise<Response> {
        const middleware = chain[index]

        if (middleware === undefined) return terminal()

        return middleware(c, () => dispatch(index + 1))
      }

      try {
        for (const plugin of plugins) {
          const short = await plugin.onRequest?.(c)

          if (short instanceof Response) return short
        }

        let response = await dispatch(0)

        for (const plugin of plugins) {
          const replaced = await plugin.onResponse?.(c, response)

          if (replaced instanceof Response) response = replaced
        }

        if (!headFallback) return response

        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch (error) {
        for (const plugin of plugins) await plugin.onError?.(error, c)

        return handleError(error, c)
      }
    },
  }

  // Registered before the caller can add anything, which keeps compress the
  // outermost middleware so it sees the final response.
  if (options.compress !== false) {
    const settings = options.compress === undefined || options.compress === true ? {} : options.compress

    app.use(compress(settings))
  }

  // First plugin registered, for the same reason: onRequest and onResponse run
  // in registration order, so this is the pair that brackets every other.
  if (options.logger !== false) {
    const settings = options.logger === undefined || options.logger === true ? {} : options.logger

    app.plugin(logger(settings))
  }

  // Before any plugin the caller adds, so their onRequest hooks already see
  // the signals it parsed.
  if (options.datastar !== false) {
    const settings =
      options.datastar === undefined || options.datastar === true ? {} : options.datastar

    app.plugin(datastar(settings))
  }

  if (options.banner !== false) {
    const settings = options.banner === undefined || options.banner === true ? {} : options.banner

    app.plugin(banner(settings))
  }

  return app
}
