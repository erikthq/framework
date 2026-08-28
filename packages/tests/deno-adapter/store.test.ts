import { test, before } from 'node:test'
import assert from 'node:assert/strict'

import { denoInstalled, runDenoReport } from './deno.ts'

type Report = {
  name: string
  all: string[]
  narrowed: string[]
  fromStringPath: string[]
  bracketedImport: string
  read: { text: string; length: string; modified: string | null }
  missing: null
  refusals: Record<string, string | null>
  responses: Record<string, unknown>
  routes: { method: string; pattern: string }[]
  baked: {
    routes: { method: string; pattern: string }[]
    user: unknown
    catchAll: string
    capabilities: string[]
  }
}

const skip = denoInstalled ? false : 'deno is not installed'

let report: Report

before(async () => {
  if (denoInstalled) report = (await runDenoReport('report.ts')) as Report
})

const visible = (paths: readonly string[]) =>
  paths.filter(path => !path.split('/').some(part => part.startsWith('.'))).sort()

test('lists every file as a path relative to the directory', { skip }, () => {
  assert.deepEqual(visible(report.all), [
    'layouts/main.html',
    'public/hello.txt',
    'routes/_lib/shared.ts',
    'routes/about.ts',
    'routes/index.ts',
    'routes/notes.md',
    'routes/notes/[...rest].ts',
    'routes/users/[id].ts',
    'routes/users/me.ts',
  ])
})

test('the listing can be narrowed by prefix and extension', { skip }, () => {
  assert.deepEqual(visible(report.narrowed), [
    'routes/_lib/shared.ts',
    'routes/about.ts',
    'routes/index.ts',
    'routes/notes/[...rest].ts',
    'routes/users/[id].ts',
    'routes/users/me.ts',
  ])
})

test('a directory given as a path works as well as a url', { skip }, () => {
  assert.deepEqual(report.fromStringPath, ['public/hello.txt'])
})

test('a module with a bracketed filename imports', { skip }, () => {
  assert.equal(report.bracketedImport, 'function')
})

test('reading a file returns its bytes with its metadata', { skip }, () => {
  assert.equal(report.read.text, 'hello from the store\n')
  assert.equal(report.read.length, '21')
  assert.notEqual(report.read.modified, null)
})

test('reading a file that is not there returns null', { skip }, () => {
  assert.equal(report.missing, null)
})

test('reading refuses to leave the directory', { skip }, () => {
  assert.match(report.refusals.readRelative ?? '', /outside the store/)
  assert.match(report.refusals.readAbsolute ?? '', /outside the store/)
  assert.match(report.refusals.importRelative ?? '', /outside the store/)
})

test('an app serves the routes it finds on disk', { skip }, () => {
  assert.deepEqual(report.responses, {
    root: 'home',
    about: 'about',
    user: { id: '7' },
    me: { id: 'me' },
    created: 201,
    catchAll: 'PUT a/b',
    underscored: 404,
    markdown: 404,
  })
})

test('the routes found on disk are reported in a stable order', { skip }, () => {
  assert.deepEqual(report.routes, [
    { method: 'GET', pattern: '/' },
    { method: 'GET', pattern: '/about' },
    { method: 'GET', pattern: '/users/me' },
    { method: 'GET', pattern: '/users/:id' },
    { method: 'POST', pattern: '/users/:id' },
    { method: 'ALL', pattern: '/notes{/:rest}*' },
  ])
})

test('a store generated from a listing serves the same routes', { skip }, () => {
  assert.deepEqual(report.baked.capabilities, ['read', 'import'])
  assert.deepEqual(report.baked.routes, report.routes)
  assert.deepEqual(report.baked.user, { id: '7' })
  assert.equal(report.baked.catchAll, 'PUT a/b')
})

test('the store names itself for error messages', { skip }, () => {
  assert.equal(report.name, 'deno')
})
