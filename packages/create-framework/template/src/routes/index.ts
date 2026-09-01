import { css, defineRoute, html, useLayout, useStyle } from '@erikt/framework'

import { layout } from '../layout.ts'

const styles = css`
  section {
    margin: 20vh auto;
    width: fit-content;
  }
`

export default defineRoute((c) => {
  c.set('title', 'my-app')

  useLayout(c, layout)

  useStyle(c, styles)

  return html`
    <section class="prose">
      <hgroup>
        <h1>@erikt/framework</h1>

        <p>Edit <code>src/routes/index.ts</code> to change this page.</p>
      </hgroup>
    </section>
  `
})
