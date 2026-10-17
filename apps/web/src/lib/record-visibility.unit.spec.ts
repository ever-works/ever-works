import { describe, expect, it } from 'vitest';
import {
    currentChoice,
    parseRecordTab,
    recordTabHref,
    RECORD_TABS,
    withRecordTab,
} from './record-visibility';

/** Record visibility (EW-P1-3) — the list tabs' URL rules and the control's choice. */
describe('record visibility (web)', () => {
    it('lists Mine | Shared with me | Organization, Mine first', () => {
        expect(RECORD_TABS).toEqual(['mine', 'shared', 'organization']);
    });

    it('parseRecordTab reads ?tab=, unknown or missing = mine', () => {
        expect(parseRecordTab('shared')).toBe('shared');
        expect(parseRecordTab(['organization', 'mine'])).toBe('organization');
        expect(parseRecordTab('everything')).toBe('mine');
        expect(parseRecordTab(undefined)).toBe('mine');
        expect(parseRecordTab(null)).toBe('mine');
    });

    it('recordTabHref keeps every filter, resets paging, and Mine keeps the plain URL', () => {
        const current = new URLSearchParams('status=todo&offset=50&view=board');
        expect(recordTabHref('/tasks', current, 'shared')).toBe(
            '/tasks?status=todo&view=board&tab=shared',
        );
        expect(recordTabHref('/tasks', new URLSearchParams('tab=shared&status=todo'), 'mine')).toBe(
            '/tasks?status=todo',
        );
        expect(recordTabHref('/goals', new URLSearchParams(), 'mine')).toBe('/goals');
    });

    it('withRecordTab keeps the tab on server-built hrefs', () => {
        expect(withRecordTab('/goals?status=active', 'organization')).toBe(
            '/goals?status=active&tab=organization',
        );
        expect(withRecordTab('/goals', 'shared')).toBe('/goals?tab=shared');
        expect(withRecordTab('/goals?offset=24', 'mine')).toBe('/goals?offset=24');
    });

    it('the control shows Automatic until somebody picked a value', () => {
        expect(currentChoice({ visibility: 'team', visibilityExplicit: false })).toBe('automatic');
        expect(currentChoice({ visibility: 'private', visibilityExplicit: true })).toBe('private');
    });
});
