export type {
  App,
  AppOptions,
  ErrorHandler,
  Handler,
  Method,
  Middleware,
} from "./app.ts";
export { createApp } from "./app.ts";

export type {
  Context,
  ContextBag,
  ContextKey,
  ContextValue,
  ResponseBody,
  ResponseOptions,
} from "./context.ts";

export type {
  DatastarOptions,
  DatastarStream,
  PatchElementsOptions,
  PatchMode,
  PatchSignalsOptions,
  Signals,
  StreamRender,
} from "./plugins/datastar.ts";
export { datastar, defineStream, readSignals } from "./plugins/datastar.ts";

export { DATASTAR_CLIENT, DATASTAR_VERSION } from "./plugins/datastar-client.ts";

export type { FileRouterOptions, RouteModule } from "./file-router.ts";
export { fileRouter, patternFromFilePath } from "./file-router.ts";

export type {
  FileEntry,
  FileRead,
  FileStore,
  GenerateStoreOptions,
  ListOptions,
  StaticEntry,
  StaticFiles,
  StaticStoreOptions,
} from "./file-store.ts";
export {
  generateStore,
  listFiles,
  MODULE_EXTENSIONS,
  staticStore,
  withRead,
} from "./file-store.ts";

export type {
  CompressionFormat,
  CompressOptions,
} from "./middleware/compress.ts";
export { compress } from "./middleware/compress.ts";

export type { EndpointRender, Layout, PageRender } from "./page.ts";
export { defineEndpoint, defineLayout, definePage } from "./page.ts";

export type { HtmlInjection, InjectTarget, Plugin, RouteInfo, StartInfo } from "./plugin.ts";

export type { BannerOptions } from "./plugins/banner.ts";
export { banner } from "./plugins/banner.ts";

export type { LoggerOptions } from "./plugins/logger.ts";
export { logger } from "./plugins/logger.ts";

export type { ScriptAsset, ScriptsOptions } from "./plugins/scripts.ts";
export { scripts, useScript } from "./plugins/scripts.ts";

export type {
  Route,
  RouteManifest,
  RouteMatch,
  RoutePattern,
  Router,
  RouterOptions,
} from "./router.ts";
export { createRouter } from "./router.ts";

export { html } from "./helpers/html.ts";

export type { StripTypesOptions } from "./helpers/strip-types.ts";
export { stripTypes, StripTypesError } from "./helpers/strip-types.ts";
