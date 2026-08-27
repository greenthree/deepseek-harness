/** Package-owned invariant companion for the read-only ProbHub route owner. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-probhub'

/** Cordis companion plugin name. */
export const name = 'host-probhub-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** Route registration/disposal is owned by the route carrier and covered by focused tests. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
