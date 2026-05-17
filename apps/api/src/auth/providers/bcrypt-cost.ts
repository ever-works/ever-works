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

export function passwordNeedsRehash(
    hash: string,
    targetCost: number = getBcryptCost(),
): boolean {
    const current = parseBcryptCost(hash);
    if (current === null) return false;
    return current < targetCost;
}
