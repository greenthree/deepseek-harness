/** Safe Schema v1 source targets for the downstream workbench editor. */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** Files that the workbench may expose as editable UTF-8 text. */
export type SourceTargetKind = 'statement' | 'config' | 'code' | 'sample-input' | 'secret-input'

/** A validated, workspace-relative source target. */
export interface SourceTarget {
  readonly kind: SourceTargetKind
  readonly name?: string
}

/** Metadata for one source file exposed by the workbench target picker. */
export interface SourceTargetDescriptor extends SourceTarget {
  readonly target: string
  readonly bytes: number
}

const TARGET_KINDS: readonly SourceTargetKind[] = ['statement', 'config', 'code', 'sample-input', 'secret-input']
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const REVISION = /^[a-f0-9]{64}$/
const MAX_SOURCE_TARGETS = 512

/** Parse the compact query/body representation without accepting paths. */
export function parseSourceTarget(value: unknown): SourceTarget | undefined {
  if (typeof value !== 'string') return undefined
  if (value === 'statement' || value === 'config') return { kind: value }
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return undefined
  const kind = value.slice(0, separator)
  const name = value.slice(separator + 1)
  if (!TARGET_KINDS.includes(kind as SourceTargetKind) || kind === 'statement' || kind === 'config') return undefined
  if (!FILE_NAME.test(name) || name === '.' || name === '..') return undefined
  if (name.toLowerCase().endsWith('.ans')) return undefined
  return { kind: kind as Exclude<SourceTargetKind, 'statement' | 'config'>, name }
}

/** Render a target back to its stable, non-absolute wire form. */
export function sourceTargetId(target: SourceTarget): string {
  return target.name === undefined ? target.kind : `${target.kind}:${target.name}`
}

/** Validate a source revision marker before comparing it. */
export function isSourceRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION.test(value)
}

/** SHA-256 of the exact bytes on disk; newline normalization is never applied. */
export function sourceRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Resolve one target and prove it remains inside the canonical workspace. */
export async function resolveSourcePath(workspace: string, problemId: string, target: SourceTarget): Promise<string> {
  const problemRoot = join(workspace, problemId)
  await assertDirectory(problemRoot)
  let relativePath: string
  if (target.kind === 'statement') relativePath = 'problem.md'
  else if (target.kind === 'config') relativePath = 'probhub.yaml'
  else {
    const name = target.name
    if (name === undefined) throw new Error('source target name is required')
    relativePath = target.kind === 'code'
      ? join('code', name)
      : join(target.kind === 'sample-input' ? 'data/sample' : 'data/secret', name)
  }
  const candidate = join(problemRoot, relativePath)
  const parent = dirname(candidate)
  await assertDirectory(parent)
  const [canonicalWorkspace, canonicalPath] = await Promise.all([realpath(workspace), realpath(candidate)])
  const within = relative(canonicalWorkspace, canonicalPath)
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${requireSeparator(canonicalWorkspace)}`)) {
    throw new Error('source path escapes the canonical workspace')
  }
  const info = await lstat(candidate)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('source target is not a regular file')
  if (!(await stat(canonicalPath)).isFile()) throw new Error('source target is not a regular file')
  return canonicalPath
}

/**
 * List the existing UTF-8 source files that the workbench may edit.
 *
 * Directory entries are never treated as files, symlinks are ignored, and
 * invalid or oversized text is omitted. The fixed statement/config files are
 * required by Schema v1 and therefore fail closed when unavailable.
 */
export async function listSourceTargets(
  workspace: string,
  problemId: string,
  maxBytes: number,
): Promise<readonly SourceTargetDescriptor[]> {
  const targets: SourceTargetDescriptor[] = []
  for (const target of [{ kind: 'statement' }, { kind: 'config' }] as const) {
    const path = await resolveSourcePath(workspace, problemId, target)
    const file = await readSource(path, maxBytes)
    targets.push({ ...target, target: sourceTargetId(target), bytes: file.bytes })
  }
  for (const [kind, directory] of [
    ['code', join('code')] as const,
    ['sample-input', join('data', 'sample')] as const,
    ['secret-input', join('data', 'secret')] as const,
  ]) {
    const directoryPath = join(workspace, problemId, directory)
    let entries
    try {
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch (error) {
      if (isMissingPath(error)) continue
      throw error
    }
    const names = entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink() && FILE_NAME.test(entry.name) && !entry.name.toLowerCase().endsWith('.ans'))
      .map(entry => entry.name)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    for (const name of names) {
      const target: SourceTarget = { kind, name }
      try {
        const path = await resolveSourcePath(workspace, problemId, target)
        const file = await readSource(path, maxBytes)
        targets.push({ ...target, target: sourceTargetId(target), bytes: file.bytes })
      } catch {
        // Generated binaries, symlink races, and files that disappear while
        // listing are not editable targets; the remaining list stays stable.
      }
      if (targets.length > MAX_SOURCE_TARGETS) throw new Error('workbench source target limit exceeded')
    }
  }
  return targets
}

function isMissingPath(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('source target parent is not a regular directory')
}

function requireSeparator(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** Read one source file as strict UTF-8 and return its byte revision. */
export async function readSource(path: string, maxBytes: number): Promise<{ content: string; revision: string; bytes: number }> {
  const bytes = await readFile(path)
  if (bytes.byteLength > maxBytes) throw new Error('source file exceeds the workbench size limit')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('source target is not valid UTF-8')
  }
  return { content, revision: sourceRevision(bytes), bytes: bytes.byteLength }
}

/** Atomically replace one existing source file on the same volume. */
export async function writeSource(path: string, content: string, maxBytes: number): Promise<{ revision: string; bytes: number }> {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > maxBytes) throw new Error('source content exceeds the workbench size limit')
  const current = await stat(path)
  const temp = join(dirname(path), `.dsh-source-${randomBytes(12).toString('hex')}.tmp`)
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: current.mode & 0o777 })
    await chmod(temp, current.mode & 0o777)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { revision: sourceRevision(bytes), bytes: bytes.byteLength }
}

/** Determine which Core-facing identities a source edit invalidates. */
export function sourceImpact(target: SourceTarget): {
  readonly source: boolean
  readonly data: boolean
  readonly formalArtifacts: boolean
} {
  return {
    source: target.kind !== 'sample-input' && target.kind !== 'secret-input',
    data: target.kind === 'sample-input' || target.kind === 'secret-input',
    formalArtifacts: true,
  }
}
