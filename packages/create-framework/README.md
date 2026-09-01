# @erikt/create-framework

The starter. One command, one directory, a site that runs.

```sh
pnpm create @erikt/framework my-site
cd my-site
pnpm install
pnpm dev
```

**Use the scoped form.** `pnpm create @erikt/framework` resolves to this package
on npm. `pnpm create erikt/framework` does *not* — pnpm reads an unscoped
`owner/repo` as a git shorthand and applies the `create-` prefix to the **owner**,
looking for `github.com/create-erikt/framework`.

## What you get

```
framework.config.ts      the whole setup, and the entry point
src/layout.ts            the document a page asks for with useLayout
src/bag.ts               types for c.set / c.get keys
src/routes/index.ts      GET /
src/public/favicon.svg   served as-is from /
```

Routes, static files, `css``` blocks and the Datastar runtime are wired by
default, so the config only names the directory to read and the port. Add `src/not-found.ts` or `src/error.ts` and they are found by name; add
`src/scripts/` and its TypeScript is stripped, hashed and served.

## Working on the template

`template/` is a workspace package, so it runs here without being scaffolded
first:

```sh
pnpm --filter framework-template dev
```

Its dependencies are `workspace:*` so that works; `scaffold()` rewrites them to
a published range on the way out. That rewrite is the only difference between
what runs here and what a user gets.

`scaffold(target, { version })` is exported if you want to drive it yourself.
