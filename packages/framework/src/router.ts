export type RoutePattern = string | URLPatternInit

// Declared locally because TypeScript's DOM lib and @types/node expose
// different subsets of the URLPattern types, and this file must typecheck under
// both. Only URLPattern and URLPatternInit are safe to reference.
type PatternOptions = {
  ignoreCase?: boolean
}

export type Route<T = undefined> = {
  pattern: RoutePattern
  name?: string
} & (undefined extends T ? { data?: T } : { data: T })

export type RouteManifest<T = undefined> = readonly Route<T>[]

export type RouteMatch<T = undefined> = {
  route: Route<T>
  params: Record<string, string | undefined>
  result: URLPatternResult
  url: URL
}

export type RouterOptions = {
  base?: string | URL
  ignoreCase?: boolean
}

export type Router<T = undefined> = {
  routes: RouteManifest<T>
  match(input: string | URL | Request): RouteMatch<T> | null
  matchAll(input: string | URL | Request): RouteMatch<T>[]
  test(input: string | URL | Request): boolean
  route(name: string): Route<T> | undefined
}

const DEFAULT_BASE = 'http://localhost/'

// Ordered so pathname wins a name collision.
const COMPONENTS = [
  'protocol',
  'username',
  'password',
  'hostname',
  'port',
  'search',
  'hash',
  'pathname',
] as const

function compile(pattern: RoutePattern, options: PatternOptions | undefined): URLPattern {
  // A relative pattern string would need a baseURL, which would pin protocol
  // and host. Compiling it as a lone pathname component keeps it agnostic.
  const input: string | URLPatternInit =
    typeof pattern === 'string' && !pattern.includes('://') ? { pathname: pattern } : pattern

  return options === undefined ? new URLPattern(input) : new URLPattern(input, options)
}

function describe(route: Route<unknown>, index: number): string {
  if (route.name !== undefined) return JSON.stringify(route.name)
  if (typeof route.pattern === 'string') return JSON.stringify(route.pattern)

  return `at index ${index}`
}

function toURL(input: string | URL | Request, base: string | URL): URL {
  if (typeof input === 'string') return new URL(input, base)
  if (input instanceof URL) return input

  return new URL(input.url, base)
}

function collectParams(
  pattern: URLPattern,
  result: URLPatternResult,
): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {}

  for (const component of COMPONENTS) {
    // Components the manifest left unspecified compile to '*' and capture a
    // meaningless index group. Only the pathname is always meant.
    if (component !== 'pathname' && pattern[component] === '*') continue

    const groups = result[component].groups

    for (const key of Object.keys(groups)) {
      params[key] = groups[key]
    }
  }

  return params
}

export function createRouter<T = undefined>(
  manifest: RouteManifest<T>,
  options: RouterOptions = {},
): Router<T> {
  const base = options.base ?? DEFAULT_BASE
  const patternOptions: PatternOptions | undefined =
    options.ignoreCase === undefined ? undefined : { ignoreCase: options.ignoreCase }
  const routes = [...manifest]
  const names = new Set<string>()

  const compiled = routes.map((route, index) => {
    if (route.name !== undefined) {
      if (names.has(route.name)) {
        throw new Error(`Duplicate route name ${JSON.stringify(route.name)} in manifest`)
      }

      names.add(route.name)
    }

    try {
      return compile(route.pattern, patternOptions)
    } catch (cause) {
      throw new TypeError(`Invalid pattern for route ${describe(route, index)}`, { cause })
    }
  })

  function* matches(url: URL): Generator<RouteMatch<T>> {
    for (const [index, pattern] of compiled.entries()) {
      const route = routes[index]
      if (route === undefined) continue

      const result = pattern.exec(url)
      if (result === null) continue

      yield { route, params: collectParams(pattern, result), result, url }
    }
  }

  return {
    routes,

    match(input) {
      for (const match of matches(toURL(input, base))) return match

      return null
    },

    matchAll(input) {
      return [...matches(toURL(input, base))]
    },

    test(input) {
      const url = toURL(input, base)

      return compiled.some(pattern => pattern.test(url))
    },

    route(name) {
      return routes.find(route => route.name === name)
    },
  }
}
