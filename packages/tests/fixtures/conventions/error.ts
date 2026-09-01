import { defineErrorPage, html } from '@erikt/framework'

export default defineErrorPage(error => html`<p>${(error as Error).message}</p>`)
