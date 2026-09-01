import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-probhub bundle', () => {
  it('declares a profile bundle and mounts the ProbHub rows', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string; name?: string; inject?: string[] }[] }[])
      .flatMap(patch => patch.insert ?? [])
    expect(rows).toEqual([
      { id: 'probhub', name: '@greenthree/dsh-host-probhub', inject: ['webServer'] },
      { id: 'probhub-tools', name: '@greenthree/dsh-host-probhub/tools' },
    ])
  })
})
