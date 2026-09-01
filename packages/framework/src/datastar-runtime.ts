// Types for the Datastar browser runtime, for code that imports it directly:
//
//   import { mergePatch } from 'datastar'
//
// The bare specifier resolves at runtime through the import map the `datastar`
// plugin injects, and at build time through `paths` in tsconfig.browser.json.
// Everything here is ambient — none of it runs on the server.
//
// Datastar documents its data-* attributes and its SSE events, not this. The
// declarations below describe the sixteen values its browser bundle exports,
// read from the v1.0.3 source; treat a version bump as a place to re-check
// them. Reach for a data-on: expression or a server-sent patch first — the
// backend driving state is the point of the library.
//
// Repo note: this is a `.ts` of `export declare`, not a `.d.ts`, because this
// repo ships no declaration files. An editor consumes it identically.

export type SignalValues = Record<string, unknown>

// An entry per dotted path — the flat form of the same data.
export type SignalPaths = [string, unknown][]

export type MergePatchOptions = {
  // Leaves a signal that already has a value alone.
  ifMissing?: boolean
}

export type SignalFilterOptions = {
  include?: RegExp | string
  exclude?: RegExp | string
}

// Reading and writing are the same function: call it bare to read, with a value
// to write. Writing answers whether anything actually changed.
export type Signal<T> = {
  (): T
  (value: T): boolean
}

export type Computed<T> = () => T

// Calling it stops the effect.
export type Effect = () => void

// --- the signal store ---------------------------------------------------

// Every signal on the page, live. Prefer the functions below to reaching in.
export declare const root: SignalValues

export declare function getPath<T = unknown>(path: string): T | undefined

// Merges into the store, batched. A null or undefined value removes that
// signal, unless ifMissing is set. The same rule datastar-patch-signals follows.
export declare function mergePatch(patch: SignalValues, options?: MergePatchOptions): void

export declare function mergePaths(paths: SignalPaths, options?: MergePatchOptions): void

// A plain snapshot of the store, narrowed by path. Defaults to everything.
export declare function filtered(
  options?: SignalFilterOptions,
  from?: SignalValues,
): SignalValues

// --- reactivity ---------------------------------------------------------

export declare function signal<T>(initialValue?: T): Signal<T>

export declare function computed<T>(getter: (previousValue?: T) => T): Computed<T>

export declare function effect(run: () => void): Effect

// Coalesce several writes into one notification. Nest freely; only the
// outermost endBatch flushes.
export declare function beginBatch(): void
export declare function endBatch(): void

// Read without subscribing, for use inside an effect or a computed.
export declare function startPeeking(): void
export declare function stopPeeking(): void

// --- extending the runtime ----------------------------------------------

export type DatastarElement = HTMLElement | SVGElement | MathMLElement

export type PluginError = (name: string, context?: Record<string, unknown>) => void

export type ActionContext = {
  el: DatastarElement
  evt?: Event
  error: PluginError
  cleanups: Map<string, () => void>
}

export type ActionPlugin<T = unknown> = {
  name: string
  apply: (context: ActionContext, ...args: never[]) => T
}

export type WatcherContext = {
  error: PluginError
}

export type WatcherArgs = Record<string, string | Element | DocumentFragment | undefined>

export type WatcherPlugin = {
  name: string
  apply: (context: WatcherContext, args: WatcherArgs) => void
}

// Datastar types this far more precisely: which of key/value/rx a plugin gets
// is derived from its own `requirement`, through conditional types that change
// between versions. Kept loose here rather than mirroring machinery that would
// go stale — an attribute plugin is the deepest part of the API and the least
// likely thing to want from an app.
export type AttributeContext = {
  el: DatastarElement
  rawKey: string
  key?: string
  value?: string
  rx?: (...args: never[]) => unknown
  mods: Map<string, Set<string>>
  evt?: Event
  error: PluginError
  loadedPluginNames: {
    actions: ReadonlySet<string>
    attributes: ReadonlySet<string>
  }
}

export type AttributePlugin = {
  name: string
  apply: (context: AttributeContext) => void | (() => void)
  requirement?: string | Record<string, string>
  returnsValue?: boolean
  argNames?: string[]
}

// Registered by name. Registering over an existing name replaces it.
export declare function action<T>(plugin: ActionPlugin<T>): void
export declare function attribute(plugin: AttributePlugin): void
export declare function watcher(plugin: WatcherPlugin): void

// Every registered action, keyed by name. Read-only.
export declare const actions: Readonly<
  Record<string, ((context: ActionContext, ...args: never[]) => unknown) | undefined>
>
