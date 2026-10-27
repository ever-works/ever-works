import { FLEET_USAGE_PERIODS, isFleetUsagePeriodDays, type FleetUsagePeriodDays, type FleetUsageView } from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20 P2, spec §5.1, §5.2, §5.6) — the pure half
 * of the hub's Usage tab: the period from the URL and the keyboard, which
 * state the tab is in, and the notes under the totals. No React.
 */

export const USAGE_TAB_DEFAULT_DAYS: FleetUsagePeriodDays = 7;

/** `?days=` (or nothing) → one of the four periods. */
export function usagePeriodFrom(raw: string | null | undefined): FleetUsagePeriodDays {
    const days = Number(raw);
    return isFleetUsagePeriodDays(days) ? days : USAGE_TAB_DEFAULT_DAYS;
}

/** Keys `1 · 2 · 3 · 4` switch periods (spec §5.6); anything else is not ours. */
export function usagePeriodForKey(key: string): FleetUsagePeriodDays | null {
    const index = ['1', '2', '3', '4'].indexOf(key);
    return index >= 0 ? FLEET_USAGE_PERIODS[index] : null;
}

/** The i18n key of a period's label: `periods.today`, `periods.d7`, … */
export function usagePeriodKey(days: FleetUsagePeriodDays): 'today' | 'd7' | 'd30' | 'd90' {
    return days === 1 ? 'today' : days === 7 ? 'd7' : days === 30 ? 'd30' : 'd90';
}

/** Which body the tab shows (spec §5.2). */
export type UsageTabState = 'empty' | 'ready';

/** Empty = no computer is reporting usage (every one has the scan off or is too old). */
export function usageTabState(view: FleetUsageView): UsageTabState {
    return view.byNode.some((line) => line.scan.state === 'on') ? 'ready' : 'empty';
}

/** What the totals leave out for this viewer (FR-17, U10), as i18n keys with their values. */
export function usageExclusionNotes(view: FleetUsageView): Array<{ key: 'excludedNodes' | 'otherHidden'; values?: Record<string, number> }> {
    const notes: Array<{ key: 'excludedNodes' | 'otherHidden'; values?: Record<string, number> }> = [];
    if (view.excluded.nodes > 0) notes.push({ key: 'excludedNodes', values: { count: view.excluded.nodes } });
    if (view.excluded.otherHidden) notes.push({ key: 'otherHidden' });
    return notes;
}

/** The price-list line (spec U8): "priced at model list prices v1" (+ "v2 in effect since …" when older versions were used). */
export function usagePriceListLine(view: FleetUsageView): { key: 'priceList' | 'priceListMixed'; values: Record<string, string> } {
    const used = view.priceList.versionsUsed;
    const older = used.filter((version) => version !== view.priceList.version);
    if (older.length === 0) return { key: 'priceList', values: { version: String(view.priceList.version) } };
    return {
        key: 'priceListMixed',
        values: {
            versions: older.map((version) => `v${version}`).join(', '),
            version: String(view.priceList.version),
            since: view.priceList.effectiveFrom,
        },
    };
}
