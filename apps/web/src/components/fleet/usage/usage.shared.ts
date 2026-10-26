import {
    formatFleetUsageCents,
    formatFleetUsageTokens,
    totalFleetUsageTokens,
    type FleetSessionUsage,
    type FleetUsageScanState,
    type FleetUsageTokens,
} from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20, plan §8) — the pure half of every usage
 * surface: what the session chip says, the receipt line's figures, the
 * computer Overview line's state and the scan age. No React, no I/O; the
 * components translate the keys these return.
 */

/** `$0.42` (or `<$0.01`); null for "nothing priced" — never `$0.00` for an unknown model (FR-8). */
export function usageMoney(cents: number | null | undefined): string | null {
    return formatFleetUsageCents(cents ?? null);
}

/** `61 k` — one token class, compact. */
export function usageTokens(value: number): string {
    return formatFleetUsageTokens(value);
}

/** Cache read plus cache write — the receipt's one "cache" figure (spec §5.4). */
export function usageCacheTokens(tokens: FleetUsageTokens): number {
    return tokens.cacheRead + tokens.cacheWrite;
}

export function usageTotalTokens(tokens: FleetUsageTokens): number {
    return totalFleetUsageTokens(tokens);
}

/** What the session card's cost chip shows (spec FR-10, §5.3), or null when the session has no usage yet. */
export type SessionCostChipModel =
    | { kind: 'cost'; cost: string }
    | { kind: 'tokensOnly'; model: string | null; tokens: string };

export function sessionCostChipModel(input: {
    costCents?: number | null;
    tokens?: FleetSessionUsage | null;
}): SessionCostChipModel | null {
    const cost = usageMoney(input.costCents);
    if (cost) return { kind: 'cost', cost };
    const usage = input.tokens;
    if (!usage) return null;
    const models = Object.keys(usage.byModel);
    if (models.length === 0) return null;
    let total = 0;
    for (const model of models) {
        const line = usage.byModel[model];
        total += line.in + line.out + line.cacheRead + line.cacheWrite;
    }
    return {
        kind: 'tokensOnly',
        // The model is named when there is exactly one (spec §5.3: "tokens only with the model named").
        model: models.length === 1 ? models[0] : null,
        tokens: usageTokens(total),
    };
}

/** `4 min`, `2 h`, `2 d` since `iso` — the "last scan" age; null when there is none. */
export function usageAge(iso: string | null | undefined, now: number): string | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 1) return '<1 min';
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

/** The computer Overview line's state (spec §5.5, FR-14, U1, U2, U3). */
export type ComputerUsageLineState =
    | { kind: 'off' }
    | { kind: 'unsupported' }
    | {
          kind: 'on';
          cost: string | null;
          age: string | null;
          online: boolean;
          /** "catching up · N % scanned" while the first scans drain a backlog (U11). */
          scannedPct: number | null;
      };

export function computerUsageLineState(
    scan: FleetUsageScanState | null | undefined,
    costCents: number | null,
    now: number,
): ComputerUsageLineState {
    if (!scan || scan.state === 'unsupported') return { kind: 'unsupported' };
    if (scan.state === 'off') return { kind: 'off' };
    const backlog = scan.backlogPct;
    return {
        kind: 'on',
        cost: usageMoney(costCents),
        age: usageAge(scan.lastScanAt, now),
        online: scan.online,
        scannedPct: typeof backlog === 'number' && backlog > 0 ? Math.max(0, Math.min(99, 100 - Math.round(backlog))) : null,
    };
}
