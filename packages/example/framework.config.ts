import { defineConfig } from '@erikt/framework-node'

// Two runtime-specific things live in this file: the import above, and reading
// the environment below. Everything else is portable — swap
// "@erikt/framework-node" for "@erikt/framework-deno" and the rest is unchanged.
export default defineConfig({
  title: 'framework-2',
  root: new URL('./src/', import.meta.url),

  // The config is where the environment lands. Nothing else reads it.
  port: Number(process.env.PORT ?? 3000),
})
