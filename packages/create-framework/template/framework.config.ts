import { defineConfig } from '@erikt/framework-node'

export default defineConfig({
  title: 'my-app',
  root: new URL('./src/', import.meta.url),
  port: Number(process.env.PORT ?? 3000),
})
  