import { describe, expect, it } from 'vitest';
import {
    parseUsageTab,
    USAGE_TAB_COSTS,
    USAGE_TAB_OVERVIEW,
    USAGE_TABS,
} from './usage-tabs.shared';

describe('parseUsageTab', () => {
    it('accepts the two known tabs', () => {
        expect(parseUsageTab('overview')).toBe(USAGE_TAB_OVERVIEW);
        expect(parseUsageTab('costs')).toBe(USAGE_TAB_COSTS);
    });

    it('falls back to Overview for anything else — a bad ?tab= never 404s', () => {
        for (const bad of [undefined, null, '', 'Costs', 'billing', 42, {}]) {
            expect(parseUsageTab(bad)).toBe(USAGE_TAB_OVERVIEW);
        }
    });

    it('takes the first value of a repeated query parameter', () => {
        expect(parseUsageTab(['costs', 'overview'])).toBe(USAGE_TAB_COSTS);
    });

    it('keeps Overview first so it stays the default arm', () => {
        expect(USAGE_TABS[0]).toBe(USAGE_TAB_OVERVIEW);
    });
});
