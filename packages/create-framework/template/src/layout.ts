import { css, defineLayout, html, useStyle } from '@erikt/framework'

import { SchemeSwitch } from './components/SchemeSwitch.ts'

const styles = css`
  :root {
    --ui-primary: light-dark(#111, #fefefe);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;

    .logo {
      width: 2rem;
      height: 2rem;
    }
  }
`

export const layout = defineLayout((content, c) => {
  useStyle(c, styles)

  return html`<!doctype html>
    <html lang="en" data-style:color-scheme="$theme">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${c.get('title') ?? 'my-app'}</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="stylesheet" href="https://esm.sh/@erikt/ui" />
      </head>
      <body>
        <header>
          <svg
            class="logo"
            width="512"
            height="512"
            viewBox="0 0 512 512"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect
              x="0.000105796"
              y="4.47605e-05"
              width="512"
              height="512"
              rx="80"
              fill="black"
            />
            <path
              d="M260.215 378.287C257.518 378.287 256.169 376.932 256.169 374.22L256.169 332.09C256.169 330.029 256.709 328.403 257.787 327.21L281.74 303.135C283.034 301.942 283.682 300.207 283.682 297.93L283.682 138.354C283.682 135.643 285.031 134.287 287.728 134.287L347.123 134.287C349.82 134.287 351.169 135.643 351.169 138.354L351.169 336.97C351.169 337.946 351.061 338.868 350.845 339.735C350.63 340.494 350.09 341.308 349.227 342.175L315.726 375.847C314.108 377.474 312.489 378.287 310.871 378.287L260.215 378.287Z"
              fill="white"
            />
            <path
              d="M252.08 134.287C254.806 134.287 256.169 135.643 256.169 138.354L256.169 180.485C256.169 182.545 255.624 184.172 254.534 185.364L230.329 209.439C229.021 210.632 228.367 212.367 228.367 214.645L228.367 374.22C228.367 376.932 227.004 378.287 224.278 378.287L164.258 378.287C161.532 378.287 160.169 376.932 160.169 374.22L160.169 175.605C160.169 174.629 160.278 173.707 160.496 172.839C160.714 172.08 161.259 171.267 162.132 170.399L195.985 136.727C197.621 135.1 199.256 134.287 200.891 134.287L252.08 134.287Z"
              fill="white"
            />
          </svg>

          ${SchemeSwitch(c)}
        </header>

        ${content}
      </body>
    </html>`
})
