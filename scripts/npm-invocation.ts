import { dirname, resolve } from 'node:path'

/** Resolve a shell-free invocation for npm from a package script or release step.
 * @param args - Arguments to pass to npm.
 * @param platform - Host platform; defaults to the current Node platform.
 * @returns A command and argument array suitable for `spawn` or `spawnSync`.
 */
export function npmInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const cli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    return { command: process.execPath, args: [cli, ...args] }
  }
  return { command: 'npm', args: [...args] }
}
