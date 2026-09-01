# my-app

```sh
pnpm install
pnpm dev
```

| Where                 | What                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| `framework.config.ts` | The whole setup. It is also the entry point — `pnpm dev` runs this file           |
| `src/routes/`         | One file per route. `index.ts` is `/`                                             |
| `src/public/`         | Served as-is from `/`                                                             |
| `src/scripts/`        | Browser code, type-stripped and served. `theme.ts` remembers the dark-mode switch |
| `src/layout.ts`       | The document a page asks for with `useLayout(c, layout)`                          |
| `src/components/`     | Fragments a page or layout calls. They can ask for their own scripts and styles   |
| `src/bag.ts`          | Types for `c.set` / `c.get` keys                                                  |

Add `src/not-found.ts` and `src/error.ts` and they are picked up by name.
