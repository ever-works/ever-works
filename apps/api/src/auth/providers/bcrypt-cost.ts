/**
 * L-07 — bcrypt cost helpers, factored out of `auth-runtime.instance.ts`
 * so callers that don't want to drag in `better-auth` (e.g.
 * `auth-provider.service.ts` test-mode where Better Auth is mocked) can
 * import these without pulling the ESM-only `better-auth/plugins` module.
 *
 * Modern guidance is 12+; we default to 12. Floor at 10 so an accidental
 * misconfiguration can't downgrade the production fleet. Operators can
 * raise this (e.g. 13/14) once they've measured the CPU budget on their
 * hardware. Tunable via `BCRYPT_COST` env.
 */

export const MIN_BCRYPT_COST = 10;
export const DEFAULT_BCRYPT_COST = 12;

/**
 * Resolve the active bcrypt cost factor.
 *
 * - Floors the value at {@link MIN_BCRYPT_COST} (10) so a typo in
 *   `BCRYPT_COST` can never downgrade production.
 * - **No upper bound enforced here.** bcrypt's spec ceiling is 31
 *   (5-bit cost field); the underlying library throws when asked to
 *   hash above that. Even values in the 14-16 range can take many
 *   seconds per hash on modest CPUs — raise cautiously and measure
 *   p95 sign-in latency before rolling out.
 * - Non-numeric / NaN `BCRYPT_COST` falls back to
 *   {@link DEFAULT_BCRYPT_COST}.
 */
export function getBcryptCost(): number {
    const raw = Number(process.env.BCRYPT_COST);
    if (!Number.isFinite(raw)) return DEFAULT_BCRYPT_COST;
    const cost = Math.floor(raw);
    if (cost < MIN_BCRYPT_COST) return MIN_BCRYPT_COST;
    return cost;
}

/**
 * L-07 (rehash-on-login): extract the cost factor from a bcrypt hash so
 * we can decide whether to re-hash transparently on next successful login.
 * bcrypt hashes are `$<algo>$<cost>$<salt+hash>` with a fixed-width 2-digit
 * cost. We tolerate every algo prefix bcrypt produces (`$2a$`, `$2b$`,
 * `$2y$`) since they're all the same underlying construction; rehash is
 * triggered purely by cost.
 *
 * Returns `null` when the hash isn't a recognisable bcrypt string (e.g. a
 * legacy non-bcrypt hash) — `passwordNeedsRehash` treats that as "don't
 * touch it" rather than panicking, since the verify() call already
 * succeeded.
 */
export function parseBcryptCost(hash: string): number | null {
    const m = /^\$2[aby]\$(\d{2})\$/.exec(hash);
    if (!m) return null;
    const cost = Number(m[1]);
    if (!Number.isFinite(cost)) return null;
    return cost;
}

/**
 * Should a password hash be re-hashed at the next successful login?
 *
 * Returns `true` only when the stored hash is bcrypt AND its cost
 * factor is below the configured target. Two consequences worth
 * keeping in mind:
 *
 *   - **Legacy (non-bcrypt) hashes are immortal under this policy.**
 *     `parseBcryptCost` returns `null` for them and we return
 *     `false`, so they're never rotated. If migrating away from
 *     a legacy scheme, drive that from a separate flag, not this
 *     function.
 *   - **Cost upgrades roll out lazily.** A user who hasn't signed in
 *     since the cost was raised still has the old hash; rotation
 *     happens at THEIR next login, not at config-change time. Plan
 *     months — not days — for a fleet-wide cost upgrade to fully
 *     propagate.
 */
export function passwordNeedsRehash(hash: string, targetCost: number = getBcryptCost()): boolean {
    const current = parseBcryptCost(hash);
    if (current === null) return false;
    return current < targetCost;
}
