/**
 * Settings → Usage & Credits tab vocabulary.
 *
 * Its own file rather than a constant inside the page: the tab bar (a
 * server component), the page's `?tab=` parsing and the unit spec all
 * need it, and `costs.shared.ts` is about the costs WIRE format, not the
 * page's navigation.
 */

export const USAGE_TAB_OVERVIEW = 'overview';
export const USAGE_TAB_COSTS = 'costs';

export const USAGE_TABS = [USAGE_TAB_OVERVIEW, USAGE_TAB_COSTS] as const;
export type UsageTab = (typeof USAGE_TABS)[number];

/**
 * Normalize an untrusted `?tab=` value. Falls back to Overview rather
 * than throwing or 404ing, so a stale or hand-edited link still renders
 * the page it names in spirit.
 */
export function parseUsageTab(value: unknown): UsageTab {
    if (Array.isArray(value)) {
        return parseUsageTab(value[0]);
    }
    return typeof value === 'string' && (USAGE_TABS as readonly string[]).includes(value)
        ? (value as UsageTab)
        : USAGE_TAB_OVERVIEW;
}
