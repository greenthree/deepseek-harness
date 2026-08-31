/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkProbhubVersions,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('standalone ProbHub release constraints', () => {
  const host: WorkspaceManifest = {
    dir: 'packages/host/probhub',
    manifest: { name: '@deepseek-ai/dsh-host-probhub', version: '1.2.3' },
  }
  const bundle: WorkspaceManifest = {
    dir: 'packages/bundle/probhub',
    manifest: { name: '@deepseek-ai/dsh-probhub', version: '1.2.3' },
  }

  it('accepts the paired independent version line', () => {
    expect(checkProbhubVersions([host, bundle])).toEqual([])
  })

  it('rejects missing, mismatched, and invalid versions', () => {
    expect(checkProbhubVersions([host])).toEqual([
      'probhub release family must contain exactly 2 packages',
    ])
    expect(checkProbhubVersions([host, { ...bundle, manifest: { ...bundle.manifest, version: '2.0.0' } }])).toEqual([
      'probhub release members must share one version: packages/host/probhub: 1.2.3, packages/bundle/probhub: 2.0.0',
    ])
    expect(checkProbhubVersions([host, { ...bundle, manifest: { ...bundle.manifest, version: 'latest' } }])).toEqual([
      'probhub release members must declare valid semver versions',
      'probhub release members must share one version: packages/host/probhub: 1.2.3, packages/bundle/probhub: latest',
    ])
    expect(checkProbhubVersions([{ ...host, dir: 'packages/other/probhub' }, bundle])).toEqual([
      '@deepseek-ai/dsh-host-probhub: probhub release member must live at packages/host/probhub, got packages/other/probhub',
    ])
  })
})
