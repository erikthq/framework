import { createApp, fileRouter, scripts } from "framework";
import { nodeStore, serve } from "node-adapter";

import { layout } from "./layout.ts";

// banner, compress, datastar and logger are all on by default; this only
// renames the banner. The request log and its x-response-time header are the
// logger plugin, and datastar is what puts the browser's signals on the
// context for readSignals(). `layout` wraps every definePage route in the
// document shell.
const app = createApp({
  banner: { title: "framework-2" },
  // Serves the vendored Datastar runtime and puts its tag in every page's
  // head — no CDN in the critical path.
  datastar: { client: true },
  layout,
});

// One store for the whole src tree; each feature scopes itself with `dir`.
const store = nodeStore(new URL("./", import.meta.url));

// Browser code in src/scripts: types stripped, content-hashed, served, and
// its <script> tag injected into the layout's <head> on every page.
app.plugin(scripts({ store, dir: "scripts" }));

app.plugin(fileRouter({ store, dir: "routes" }));

app.onError((error, c) => c.json({ error: (error as Error).message }, 500));

const port = Number(process.env.PORT ?? 3000);

await serve(app, { port });
