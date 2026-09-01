import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { npmInvocation } from './npm-invocation.ts'

describe('npm invocation', () => {
  it('runs npm directly on POSIX hosts', () => {
    expect(npmInvocation(['view', 'pkg@1.0.0'], 'linux')).toEqual({
      command: 'npm',
      args: ['view', 'pkg@1.0.0'],
    })
  })

  it('runs the bundled npm CLI through Node on Windows', () => {
    expect(npmInvocation(['publish', 'package.tgz'], 'win32')).toEqual({
      command: process.execPath,
      args: [
        resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        'publish',
        'package.tgz',
      ],
    })
  })
})
