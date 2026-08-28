import type { App } from './app.ts'
import type { Context } from './context.ts'
import type { RoutePattern } from './router.ts'

export type RouteInfo = {
  method: string
  pattern: string
  name?: string
}

export type StartInfo = {
  runtime: string
  url?: string
  hostname?: string
  port?: number
  routes: readonly RouteInfo[]
  plugins: readonly string[]
  startedAt: number
}

export type HtmlInjection = {
  head?: string
  body?: string
}

// A page wrapped in a layout is a whole document; an endpoint, a layout-less
// page and anything else rendering markup is a fragment. A plugin injecting a
// page-wide concern — a runtime, a stylesheet — wants the first and not the
// second, which it cannot tell from the context alone.
export type InjectTarget = 'document' | 'fragment'

export type Plugin = {
  name: string
  setup?(app: App): void | Promise<void>
  onStart?(info: StartInfo): void | Promise<void>
  injectHTML?(
    c: Context,
    target: InjectTarget,
  ): HtmlInjection | void | Promise<HtmlInjection | void>
  onRequest?(c: Context): void | Response | Promise<void | Response>
  onResponse?(c: Context, response: Response): void | Response | Promise<void | Response>
  onError?(error: unknown, c: Context): void | Promise<void>
  onStop?(): void | Promise<void>
}

export function describePattern(pattern: RoutePattern): string {
  if (typeof pattern === 'string') return pattern

  const parts = [
    pattern.protocol,
    pattern.hostname,
    pattern.port,
    pattern.pathname,
    pattern.search,
    pattern.hash,
  ].filter(part => part !== undefined)

  return parts.length === 0 ? '*' : parts.join(' ')
}

export function detectRuntime(): string {
  // navigator.userAgent is the only runtime identifier in the Minimum Common
  // API. Node reports "Node.js/24", Deno "Deno/2.x", Bun "Bun/1.x".
  const agent = globalThis.navigator?.userAgent

  return agent === undefined || agent === '' ? 'unknown' : agent
}
