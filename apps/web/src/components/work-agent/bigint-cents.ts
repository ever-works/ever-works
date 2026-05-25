// Phase 4 PR EE — small helpers for the Account-wide budget
// section. The API exposes `accountWideMonthlyCapCents` as a
// JSON-serialized bigint string (NULL = no cap) because Phase 0
// PR 0.6 chose `bigint` on the DB side — power-user monthly caps
// can exceed JS's safe-integer ceiling once enough zeros stack
// up. The MoneyField primitive (PR K) wants a `number` of cents
// though, so we narrow here at the boundary.
//
// Strategy: cast through `Number(...)` for display. If the stored
// cap exceeds Number.MAX_SAFE_INTEGER we lose precision — but
// for a monthly cap measured in CENTS that's ~$90 quadrillion,
// well past any realistic user budget. We still null-coerce in
// case the API returns "" or garbage from a future migration.
//
// On the write side we stringify back so the API contract stays
// honest about the bigint storage type.

const MAX_SAFE_CAP_CENTS = Number.MAX_SAFE_INTEGER;

/** Default display value for the monthly cap input when no
 *  override is set (cents = $50/mo). Display-only — the actual
 *  default lives server-side; this just gives the input a sane
 *  starting position when the user opts in to set a cap. */
export const DEFAULT_ACCOUNT_MONTHLY_CAP_CENTS = 5000;

export function parseCapCents(stringified: string | null | undefined): number | null {
    if (stringified === null || stringified === undefined) return null;
    const trimmed = String(stringified).trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(n, MAX_SAFE_CAP_CENTS);
}

export function formatCapCents(cents: number): string {
    const safe = Math.max(0, Math.min(Math.floor(cents), MAX_SAFE_CAP_CENTS));
    return String(safe);
}
