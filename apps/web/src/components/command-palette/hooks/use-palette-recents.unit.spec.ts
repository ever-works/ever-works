import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
    PALETTE_RECENTS_MAX,
    PALETTE_RECENTS_MAX_AGE_MS,
    readRecents,
    usePaletteRecents,
    withRecent,
    type PaletteRecentEntry,
} from './use-palette-recents';

function target(sourceId: string) {
    return {
        kind: 'mission' as const,
        sourceId,
        title: `Mission ${sourceId}`,
        subtitle: null,
        statusLabel: 'active',
        destination: `/missions/${sourceId}`,
    };
}

describe('palette Recent list', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        try {
            window.localStorage.clear();
        } catch {
            // ignore
        }
    });

    it('moves a repeat open to the top instead of duplicating it', () => {
        let list: PaletteRecentEntry[] = [];
        list = withRecent(list, target('a'), 1);
        list = withRecent(list, target('b'), 2);
        list = withRecent(list, target('a'), 3);
        expect(list.map((entry) => entry.sourceId)).toEqual(['a', 'b']);
        expect(list[0].openedAt).toBe(3);
    });

    it('keeps at most twelve entries', () => {
        let list: PaletteRecentEntry[] = [];
        for (let index = 0; index < 20; index += 1)
            list = withRecent(list, target(`m${index}`), index);
        expect(list).toHaveLength(PALETTE_RECENTS_MAX);
        expect(list[0].sourceId).toBe('m19');
    });

    it('drops entries older than 90 days and malformed entries on read', () => {
        const now = 10 * PALETTE_RECENTS_MAX_AGE_MS;
        window.localStorage.setItem(
            'ever-works:command-palette:recents:v1:scope',
            JSON.stringify([
                { ...withRecent([], target('fresh'), now - 1000)[0] },
                { ...withRecent([], target('old'), now - PALETTE_RECENTS_MAX_AGE_MS - 1)[0] },
                { key: 'x', kind: 'mission', title: 'no destination' },
                {
                    ...withRecent([], target('offsite'), now)[0],
                    destination: 'https://elsewhere.example',
                },
                {
                    ...withRecent([], target('protocolRelative'), now)[0],
                    destination: '//elsewhere.example/missions/1',
                },
                {
                    ...withRecent([], target('backslash'), now)[0],
                    destination: '/\\elsewhere.example',
                },
            ]),
        );
        expect(readRecents('scope', now).map((entry) => entry.sourceId)).toEqual(['fresh']);
    });

    it('keeps separate lists per workspace scope', () => {
        const { result: acme } = renderHook(() => usePaletteRecents('user:org:acme'));
        act(() => acme.current.record(target('a')));
        const { result: globex } = renderHook(() => usePaletteRecents('user:org:globex'));
        expect(globex.current.recents).toEqual([]);
        expect(acme.current.recents.map((entry) => entry.sourceId)).toEqual(['a']);
    });

    it('never throws into render when storage access throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const { result } = renderHook(() => usePaletteRecents('user:personal'));
        expect(result.current.recents).toEqual([]);
        expect(() => act(() => result.current.record(target('a')))).not.toThrow();
        expect(result.current.recents.map((entry) => entry.sourceId)).toEqual(['a']);
        expect(() => act(() => result.current.remove('mission:a'))).not.toThrow();
    });
});
