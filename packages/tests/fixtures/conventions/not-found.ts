import { defineLayout, defineRoute, html, useLayout } from '@erikt/framework'

const wrap = defineLayout(content => html`<main>${content}</main>`)

export default defineRoute(c => {
  c.status(404)
  useLayout(c, wrap)

  return html`<p>found by convention</p>`
})
