/** Package membership shared by the standalone ProbHub release and constraints. */

/** Canonical directories of the two packages in the ProbHub release family. */
export const PROBHUB_PACKAGE_DIRECTORIES: ReadonlyMap<string, string> = new Map([
  ['@greenthree/dsh-host-probhub', 'packages/host/probhub'],
  ['@greenthree/dsh-probhub', 'packages/bundle/probhub'],
] as const)

/** Canonical package names in the standalone ProbHub release family. */
export const PROBHUB_PACKAGE_NAMES: ReadonlySet<string> = new Set(PROBHUB_PACKAGE_DIRECTORIES.keys())
