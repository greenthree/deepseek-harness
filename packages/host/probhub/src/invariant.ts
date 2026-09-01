/** Package-owned invariant companion for the read-only ProbHub route owner. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@greenthree/dsh-host-probhub'

/** Cordis companion plugin name. */
export const name = 'host-probhub-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Route registration/disposal is owned by the route carrier and covered by
 * focused tests. No runtime invariant: this companion only reserves the
 * package-owned invariant seat so the host bridge can be composed uniformly.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
