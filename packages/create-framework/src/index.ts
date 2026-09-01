import { cp, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ScaffoldOptions = {
  // What `workspace:*` becomes in the generated package.json. Inside this repo
  // the template depends on its siblings; a generated project cannot.
  version?: string
}

export type Scaffolded = {
  directory: string
  name: string
  files: readonly string[]
}

const TEMPLATE = new URL('../template/', import.meta.url)

const DEFAULT_VERSION = 'latest'

// npm strips a .gitignore out of a published tarball, so the template carries
// it under a name that survives and it is renamed on the way out.
const GITIGNORE = 'gitignore'

const SKIP = new Set(['node_modules', '.DS_Store'])

// What may already be sitting in the target without it counting as occupied: a
// git checkout, and the noise macOS and pnpm leave behind.
const ALLOWED = new Set(['.git', '.DS_Store', 'node_modules'])

function projectName(directory: string): string {
  const base = basename(directory)

  // npm names are lowercase and cannot lead with a dot or underscore.
  const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._]+/, '')

  return cleaned === '' ? 'framework-app' : cleaned
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue

    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`

    if (entry.isDirectory()) found.push(...(await listFiles(join(directory, entry.name), path)))
    else found.push(path)
  }

  return found.sort()
}

export async function scaffold(
  target: string,
  options: ScaffoldOptions = {},
): Promise<Scaffolded> {
  const directory = resolve(target)
  const name = projectName(directory)
  const version = options.version ?? DEFAULT_VERSION

  // Checked here rather than left to cp's errorOnExist, which rejects the
  // destination *directory* — so an empty directory that already exists would
  // fail, and `mkdir my-app && cd my-app && create .` is how people do this.
  // What we actually refuse is a directory with something in it to overwrite.
  const present = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []

    throw error
  })

  const occupied = present.filter(entry => !ALLOWED.has(entry))

  if (occupied.length > 0) {
    throw new Error(
      `${directory} is not empty — it has ${occupied
        .slice(0, 3)
        .map(entry => JSON.stringify(entry))
        .join(', ')}${occupied.length > 3 ? ` and ${occupied.length - 3} more` : ''}`,
    )
  }

  await cp(fileURLToPath(TEMPLATE), directory, {
    recursive: true,
    force: false,
    filter: source => !SKIP.has(basename(source)),
  })

  const gitignore = join(directory, GITIGNORE)

  await rename(gitignore, join(directory, `.${GITIGNORE}`))

  const manifest = join(directory, 'package.json')
  const contents = JSON.parse(await readFile(manifest, 'utf8')) as {
    name: string
    dependencies?: Record<string, string>
  }

  contents.name = name

  for (const [dependency, range] of Object.entries(contents.dependencies ?? {})) {
    if (range.startsWith('workspace:')) contents.dependencies![dependency] = version
  }

  await writeFile(manifest, `${JSON.stringify(contents, null, 2)}\n`)

  return { directory, name, files: await listFiles(directory) }
}
