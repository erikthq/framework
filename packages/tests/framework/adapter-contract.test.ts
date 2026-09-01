import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Adapter, CreateStore } from '@erikt/framework'
import * as denoAdapter from '@erikt/framework-deno'
import * as nodeAdapter from '@erikt/framework-node'

// The real check is at compile time: a missing export, a renamed one or a
// changed signature fails `pnpm typecheck` here rather than at someone's call
// site. The runtime half below only guards against the types drifting from what
// is actually exported.
const node: Adapter = nodeAdapter
const deno: Adapter = denoAdapter

const nodeCreateStore: CreateStore = nodeAdapter.nodeStore
const denoCreateStore: CreateStore = denoAdapter.denoStore

const PARTS = ['serve', 'defineConfig', 'createSite', 'start'] as const

test('every adapter exports the whole contract', () => {
  for (const [name, adapter] of [
    ['node', node],
    ['deno', deno],
  ] as const) {
    for (const part of PARTS) {
      assert.equal(typeof adapter[part], 'function', `${name}-adapter is missing ${part}`)
    }
  }
})

test('every adapter exports a store factory', () => {
  assert.equal(typeof nodeCreateStore, 'function')
  assert.equal(typeof denoCreateStore, 'function')
})
