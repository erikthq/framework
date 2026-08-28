import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRouter } from 'framework'

test('matches a registered literal url', () => {
  const router = createRouter([{ name: 'about', pattern: 'https://example.com/about' }])

  assert.equal(router.match('https://example.com/about')?.route.name, 'about')
  assert.equal(router.match('https://other.com/about'), null)
})

test('extracts named params from a pattern', () => {
  const router = createRouter([{ pattern: '/users/:id/posts/:slug' }])

  assert.deepEqual(router.match('/users/42/posts/hello')?.params, {
    id: '42',
    slug: 'hello',
  })
})

test('captures wildcards by index', () => {
  const router = createRouter([{ pattern: '/assets/*' }])

  assert.equal(router.match('/assets/img/logo.svg')?.params['0'], 'img/logo.svg')
})

test('returns null when nothing matches', () => {
  const router = createRouter([{ pattern: '/users/:id' }])

  assert.equal(router.match('/orders/1'), null)
})

test('the first matching route in the manifest wins', () => {
  const router = createRouter([
    { name: 'me', pattern: '/users/me' },
    { name: 'user', pattern: '/users/:id' },
  ])

  assert.equal(router.match('/users/me')?.route.name, 'me')
  assert.equal(router.match('/users/7')?.route.name, 'user')
})

test('matchAll returns every match in manifest order', () => {
  const router = createRouter([
    { name: 'user', pattern: '/users/:id' },
    { name: 'catchall', pattern: '/*' },
  ])

  assert.deepEqual(
    router.matchAll('/users/3').map(match => match.route.name),
    ['user', 'catchall'],
  )
})

test('test reports whether any route matches', () => {
  const router = createRouter([{ pattern: '/users/:id' }])

  assert.equal(router.test('/users/1'), true)
  assert.equal(router.test('/nope'), false)
})

test('carries the registered data payload through to the match', () => {
  const router = createRouter([{ pattern: '/users/:id', data: { page: 'user' } }])

  assert.deepEqual(router.match('/users/1')?.route.data, { page: 'user' })
})

test('a pathname pattern matches regardless of host', () => {
  const router = createRouter([{ pattern: '/users/:id' }])

  assert.equal(router.match('https://anywhere.example/users/1')?.params.id, '1')
})

test('accepts a Request', () => {
  const router = createRouter([{ name: 'user', pattern: '/users/:id' }])
  const match = router.match(new Request('https://example.com/users/9'))

  assert.equal(match?.route.name, 'user')
  assert.equal(match?.params.id, '9')
})

test('accepts a URL', () => {
  const router = createRouter([{ pattern: '/users/:id' }])

  assert.equal(router.match(new URL('https://example.com/users/5'))?.params.id, '5')
})

test('resolves relative input against the configured base', () => {
  const router = createRouter([{ pattern: 'https://api.example.com/v1/:resource' }], {
    base: 'https://api.example.com/v1/',
  })

  assert.equal(router.match('users')?.params.resource, 'users')
})

test('matches url components other than the pathname', () => {
  const router = createRouter([
    { name: 'tenant', pattern: { hostname: ':tenant.example.com', pathname: '/dashboard' } },
  ])

  assert.equal(router.match('https://acme.example.com/dashboard')?.params.tenant, 'acme')
  assert.equal(router.match('https://acme.other.com/dashboard'), null)
})

test('ignoreCase makes matching case-insensitive', () => {
  const manifest = [{ pattern: '/About' }]

  assert.equal(createRouter(manifest).match('/about'), null)
  assert.notEqual(createRouter(manifest, { ignoreCase: true }).match('/about'), null)
})

test('exposes the raw per-component result', () => {
  const router = createRouter([{ pattern: '/users/:id' }])

  assert.equal(router.match('/users/1')?.result.pathname.groups.id, '1')
})

test('exposes the resolved url on the match', () => {
  const router = createRouter([{ pattern: '/users/:id' }])

  assert.equal(router.match('/users/1')?.url.href, 'http://localhost/users/1')
})

test('looks up a registered route by name', () => {
  const router = createRouter([{ name: 'user', pattern: '/users/:id' }])

  assert.equal(router.route('user')?.pattern, '/users/:id')
  assert.equal(router.route('missing'), undefined)
})

test('exposes the manifest it was built from', () => {
  const router = createRouter([{ name: 'user', pattern: '/users/:id' }])

  assert.deepEqual(router.routes, [{ name: 'user', pattern: '/users/:id' }])
})

test('rejects a manifest with duplicate route names', () => {
  assert.throws(
    () => createRouter([{ name: 'user', pattern: '/a' }, { name: 'user', pattern: '/b' }]),
    /Duplicate route name "user"/,
  )
})

test('rejects an invalid pattern when the router is built', () => {
  assert.throws(() => createRouter([{ name: 'broken', pattern: '/users/:' }]), {
    name: 'TypeError',
    message: /Invalid pattern for route "broken"/,
  })
})
