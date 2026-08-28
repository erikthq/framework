import { defineLayout, html } from "framework";

export const layout = defineLayout(
  (content, c) =>
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${c.get("title") ?? "framework"}</title>
          <link rel="stylesheet" href="https://esm.sh/@erikt/ui" />
          <style>
            body {
              max-width: 40rem;
              margin: 4rem auto;
              padding: 0 1rem;
            }

            pre {
              background: #f4f4f5;
              padding: 1rem;
              overflow-x: auto;
            }

            section {
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
        </body>
      </html>`,
);
