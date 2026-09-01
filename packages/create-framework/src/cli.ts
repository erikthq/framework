#!/usr/bin/env node
import { scaffold } from './index.ts'

const target = process.argv[2] ?? '.'

try {
  const { directory, name } = await scaffold(target)

  console.log(`Created ${name} in ${directory}`)
  console.log('')
  console.log('  pnpm install')
  console.log('  pnpm dev')
} catch (error) {
  process.exitCode = 1

  console.error(error instanceof Error ? error.message : String(error))
}
