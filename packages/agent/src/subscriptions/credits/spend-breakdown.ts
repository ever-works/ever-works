import {
    BREAKDOWN_EVERYTHING_ELSE_KEY,
    BREAKDOWN_TOP_N,
    USAGE_METER_IDS,
    type CreditSettlementMode,
    type RunCostCreditLine,
    type RunCostMeters,
    type UsageMeterTotals,
    type UsagePreMeterResidual,
} from '@ever-works/contracts';
import type {
    RunMeterLine,
    UserMeteredGroupRow,
    UserMeterSpendRow,
} from '@src/database/repositories/plugin-usage.repository';

/**
 * AW-17 — pure folds behind the meter cards, the spend breakdowns and a run
 * receipt's meter itemisation. No I/O: `CostsSummaryService` reads the grouped
 * rows and these functions shape them, so the rules are unit-testable on
 * their own.
 */

/** One row of a ranked spend breakdown. */
export interface SpendBreakdownRow {
    /**
     * Price key (by tool) or Mission id (by Mission). NULL is the honest
     * "no value" row — "Not in a Mission". The folded tail uses
     * `BREAKDOWN_EVERYTHING_ELSE_KEY`, which can never collide with a real key.
     */
    key: string | null;
    calls: number;
    credits: number;
    costCents: number;
    /** Share of the window, 0–100 with one decimal, of credits (or of cost when no credits). */
    sharePercent: number;
}

export interface FoldedBreakdown<Row extends SpendBreakdownRow = SpendBreakdownRow> {
    totalCredits: number;
    totalCostCents: number;
    rows: Row[];
    /** How many keys the "Everything else" row folds (0 when nothing folded). */
    foldedCount: number;
}

/**
 * Rank, keep the top N real keys, fold the rest into ONE "Everything else"
 * row that is the exact remainder, and keep the NULL row (if any) last and
 * unfolded. `full` returns every key unfolded.
 */
export function foldBreakdown(
    groups: UserMeteredGroupRow[],
    options: { topN?: number; full?: boolean } = {},
): FoldedBreakdown {
    const topN = options.topN ?? BREAKDOWN_TOP_N;
    const totalCredits = groups.reduce((sum, row) => sum + row.credits, 0);
    const totalCostCents = groups.reduce((sum, row) => sum + row.costCents, 0);
    const byCredits = totalCredits > 0;
    const share = (row: { credits: number; costCents: number }) =>
        sharePercent(
            byCredits ? row.credits : row.costCents,
            byCredits ? totalCredits : totalCostCents,
        );

    const ranked = groups
        .filter((row) => row.key !== null)
        .sort(
            (a, b) =>
                b.credits - a.credits ||
                b.costCents - a.costCents ||
                String(a.key).localeCompare(String(b.key)),
        );
    const kept = options.full ? ranked : ranked.slice(0, topN);
    const folded = options.full ? [] : ranked.slice(topN);

    const rows: SpendBreakdownRow[] = kept.map((row) => ({
        key: row.key,
        calls: row.calls,
        credits: row.credits,
        costCents: row.costCents,
        sharePercent: share(row),
    }));

    if (folded.length > 0) {
        const tail = folded.reduce(
            (sum, row) => ({
                calls: sum.calls + row.calls,
                credits: sum.credits + row.credits,
                costCents: sum.costCents + row.costCents,
            }),
            { calls: 0, credits: 0, costCents: 0 },
        );
        rows.push({ key: BREAKDOWN_EVERYTHING_ELSE_KEY, ...tail, sharePercent: share(tail) });
    }

    const none = groups.filter((row) => row.key === null);
    if (none.length > 0) {
        const merged = none.reduce(
            (sum, row) => ({
                calls: sum.calls + row.calls,
                credits: sum.credits + row.credits,
                costCents: sum.costCents + row.costCents,
            }),
            { calls: 0, credits: 0, costCents: 0 },
        );
        rows.push({ key: null, ...merged, sharePercent: share(merged) });
    }

    return { totalCredits, totalCostCents, rows, foldedCount: folded.length };
}

/**
 * The three meter cards plus the pre-meter residual. Every meter is always
 * present (a meter with no rows reports `calls: 0` and `costCents: null` —
 * not measured, never a fabricated zero). Rows with no meter are NEVER added
 * to a named meter.
 */
export function foldMeterTotals(rows: UserMeterSpendRow[]): {
    meters: UsageMeterTotals[];
    preMeterResidual: UsagePreMeterResidual | null;
} {
    const meters = USAGE_METER_IDS.map((meter): UsageMeterTotals => {
        const mine = rows.filter((row) => row.meter === meter);
        const calls = mine.reduce((sum, row) => sum + row.calls, 0);
        return {
            meter,
            calls,
            costCents: calls > 0 ? mine.reduce((sum, row) => sum + row.costCents, 0) : null,
            credits: mine.reduce((sum, row) => sum + row.credits, 0),
            cachedCalls: sumCalls(mine.filter((row) => row.outcome === 'cached')),
            failedCalls: sumCalls(mine.filter((row) => row.outcome === 'failed')),
            unconfirmedCalls: sumCalls(mine.filter((row) => row.payer === 'unconfirmed')),
        };
    });

    const known = new Set<string>(USAGE_METER_IDS);
    const residualRows = rows.filter((row) => row.meter === null || !known.has(row.meter));
    const residualCalls = sumCalls(residualRows);
    return {
        meters,
        preMeterResidual:
            residualCalls > 0
                ? {
                      calls: residualCalls,
                      costCents: residualRows.reduce((sum, row) => sum + row.costCents, 0),
                  }
                : null,
    };
}

/**
 * A run's meter itemisation from its grouped rows. Null when the run has no
 * retained rows. `settlementMode`, when given, is echoed so a receipt can say
 * whether the credits figures were debited or are list-price figures.
 */
export function foldRunMeters(
    lines: RunMeterLine[],
    settlementMode?: CreditSettlementMode,
): RunCostMeters | null {
    if (lines.length === 0) {
        return null;
    }

    const model = { calls: 0, costCents: 0 };
    const addon = { calls: 0 };
    let preMeterCalls = 0;
    const versions = new Set<number>();
    const creditLines = new Map<string, RunCostCreditLine>();

    for (const line of lines) {
        if (line.priceVersion !== null) {
            versions.add(line.priceVersion);
        }
        switch (line.meter) {
            case 'model':
                model.calls += line.calls;
                model.costCents += line.costCents;
                break;
            case 'addon':
                addon.calls += line.calls;
                break;
            case 'credits': {
                const priceKey = line.priceKey ?? `${line.capability}.call`;
                const current = creditLines.get(priceKey) ?? {
                    priceKey,
                    capability: line.capability,
                    calls: 0,
                    chargedCalls: 0,
                    cachedCalls: 0,
                    failedCalls: 0,
                    unconfirmedCalls: 0,
                    credits: 0,
                    costCents: 0,
                };
                current.calls += line.calls;
                if (line.outcome === 'cached') {
                    current.cachedCalls += line.calls;
                } else if (line.outcome === 'failed') {
                    current.failedCalls += line.calls;
                } else {
                    current.chargedCalls += line.calls;
                }
                if (line.payer === 'unconfirmed' || line.payer === null) {
                    current.unconfirmedCalls += line.calls;
                }
                current.credits += line.creditsCharged;
                current.costCents += line.costCents;
                creditLines.set(priceKey, current);
                break;
            }
            default:
                preMeterCalls += line.calls;
        }
    }

    const sortedLines = Array.from(creditLines.values()).sort(
        (a, b) =>
            b.credits - a.credits || b.calls - a.calls || a.priceKey.localeCompare(b.priceKey),
    );
    const meters: RunCostMeters = {
        model,
        credits: {
            calls: sortedLines.reduce((sum, line) => sum + line.calls, 0),
            credits: sortedLines.reduce((sum, line) => sum + line.credits, 0),
            lines: sortedLines,
        },
        addon,
        priceVersions: Array.from(versions).sort((a, b) => a - b),
        preMeterCalls,
    };
    if (settlementMode) {
        meters.settlementMode = settlementMode;
    }
    return meters;
}

function sumCalls(rows: Array<{ calls: number }>): number {
    return rows.reduce((sum, row) => sum + row.calls, 0);
}

/** Share with one decimal; a zero total is 0, never NaN. */
function sharePercent(part: number, total: number): number {
    if (total <= 0) {
        return 0;
    }
    return Math.round((part / total) * 1000) / 10;
}
