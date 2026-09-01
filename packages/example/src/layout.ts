import { defineLayout, html } from "@erikt/framework";

export const layout = defineLayout(
  (content, c) =>
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${c.get("title") ?? "framework"}</title>
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="stylesheet" href="https://esm.sh/@erikt/ui" />
          <style>
            body {
              max-width: 40rem;
              margin: 4rem auto;
              padding: 0 1rem;
              container-type: inline-size;
            }

            pre {
              background: #f4f4f5;
              padding: 1rem;
              overflow-x: auto;
            }

            section + section {
              border-top: 1px solid #d4d4d8;
              margin-top: 2rem;
            }

            @media (prefers-color-scheme: dark) {
              pre {
                background: #27272a;
              }
            }
          </style>
        </head>
        <body>
          ${content}

          <footer>
            <p>
              Server-rendered at
              <time>${new Date().toISOString().slice(11, 19)}</time> —
              <button data-on:click="@get('/api/refresh')">
                Refresh this page
              </button>
            </p>
          </footer>
        </body>
      </html>`,
);
