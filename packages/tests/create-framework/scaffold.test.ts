import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scaffold } from '@erikt/create-framework'

const into = async (name: string) => join(await mkdtemp(join(tmpdir(), 'framework-')), name)

type Manifest = { name: string; dependencies: Record<string, string> }

const manifest = async (directory: string): Promise<Manifest> =>
  JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest

test('it writes a project that has everything a site needs', async () => {
  const target = await into('my-site')

  try {
    const { files } = await scaffold(target)

    assert.deepEqual(files, [
      '.gitignore',
      'README.md',
      'framework.config.ts',
      'package.json',
      'src/bag.ts',
      'src/components/SchemeSwitch.ts',
      'src/layout.ts',
      'src/public/favicon.svg',
      'src/routes/index.ts',
      'src/scripts/theme.ts',
      'src/scripts/tsconfig.json',
      'tsconfig.json',
    ])
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('it scaffolds into a directory that already exists', async () => {
  // `mkdir my-app && cd my-app && pnpm create @erikt/framework` — the target is
  // there already, and empty. cp's own errorOnExist rejects that, so scaffold
  // decides for itself what counts as occupied.
  const target = await into('my-site')

  try {
    await mkdir(target, { recursive: true })

    const { files } = await scaffold(target)

    assert.ok(files.includes('framework.config.ts'))
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('a git checkout in the target is not in the way', async () => {
  const target = await into('my-site')

  try {
    await mkdir(join(target, '.git'), { recursive: true })

    const { files } = await scaffold(target)

    assert.ok(files.includes('framework.config.ts'))
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('a directory with something in it is refused, naming what', async () => {
  const target = await into('my-site')

  try {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'notes.md'), '# mine\n')

    await assert.rejects(() => scaffold(target), /is not empty — it has "notes\.md"/)

    // Nothing was written over it.
    assert.deepEqual(await readdir(target), ['notes.md'])
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('the project is named after the directory it was put in', async () => {
  const target = await into('My Shop')

  try {
    const { name } = await scaffold(target)

    // npm names are lowercase and have no spaces.
    assert.equal(name, 'my-shop')
    assert.equal((await manifest(target)).name, 'my-shop')
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('workspace ranges are rewritten, since a generated project has no workspace', async () => {
  const target = await into('site')

  try {
    await scaffold(target, { version: '^1.2.3' })

    assert.deepEqual((await manifest(target)).dependencies, {
      '@erikt/framework': '^1.2.3',
      '@erikt/framework-node': '^1.2.3',
    })
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('the ignore file arrives with its dot back on', async () => {
  const target = await into('site')

  try {
    await scaffold(target)

    const entries = await readdir(target)

    assert.ok(entries.includes('.gitignore'))
    assert.ok(!entries.includes('gitignore'))
    assert.match(await readFile(join(target, '.gitignore'), 'utf8'), /node_modules/)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('node_modules is never copied out of the template', async () => {
  const target = await into('site')

  try {
    const { files } = await scaffold(target)

    assert.ok(!files.some(file => file.includes('node_modules')))
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('it refuses to write over a project that is already there', async () => {
  const target = await into('site')

  try {
    await scaffold(target)

    await assert.rejects(() => scaffold(target))
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('the generated config points at src, not the project root', async () => {
  const target = await into('site')

  try {
    await scaffold(target)

    const config = await readFile(join(target, 'framework.config.ts'), 'utf8')

    // Rooting at the project root would walk node_modules on every start.
    assert.match(config, /root: new URL\(['"]\.\/src\/['"], import\.meta\.url\)/)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})

test('the theme switch ships wired up, not as a stub', async () => {
  const target = await into('site')

  try {
    await scaffold(target)

    const layout = await readFile(join(target, 'src/layout.ts'), 'utf8')
    const component = await readFile(join(target, 'src/components/SchemeSwitch.ts'), 'utf8')
    const theme = await readFile(join(target, 'src/scripts/theme.ts'), 'utf8')

    // erikt/ui reads color-scheme; Datastar drives it from the signal.
    assert.match(layout, /esm\.sh\/@?erikt\/ui/)
    assert.match(layout, /data-style:color-scheme=/)

    // A toggle group: one radio per scheme, all bound to the same signal.
    assert.match(component, /<fieldset role="group"/)

    // The signal holds the CSS value itself, so color-scheme needs no mapping.
    for (const value of ['light dark', 'light', 'dark']) {
      assert.match(component, new RegExp(`value="${value}" data-bind:theme`))
    }

    assert.match(layout, /data-style:color-scheme="\$theme"/)

    // The component asks for its own script rather than the layout doing it.
    assert.match(component, /useScript\(c, ['"]theme['"]\)/)

    // The script resolves the runtime through the injected import map.
    assert.match(theme, /from ['"]datastar['"]/)
  } finally {
    await rm(target, { recursive: true, force: true })
  }
})
