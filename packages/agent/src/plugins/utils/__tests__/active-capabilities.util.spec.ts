import {
    addActiveCapability,
    getActiveCapabilities,
    hasActiveCapability,
    removeActiveCapability,
} from '../active-capabilities.util';

describe('getActiveCapabilities', () => {
    it('returns the underlying array values for a populated record', () => {
        expect(getActiveCapabilities({ activeCapabilities: ['search', 'screenshot'] })).toEqual([
            'search',
            'screenshot',
        ]);
    });

    it('preserves insertion order when there are no duplicates', () => {
        expect(getActiveCapabilities({ activeCapabilities: ['c', 'a', 'b'] })).toEqual([
            'c',
            'a',
            'b',
        ]);
    });

    it('deduplicates via Set semantics — first occurrence wins', () => {
        // `new Set(arr)` keeps the FIRST occurrence and discards subsequent duplicates;
        // pinned because a future swap to `[...new Set([].concat(arr).reverse())]`
        // (or any other dedup strategy) would silently change the order.
        expect(
            getActiveCapabilities({ activeCapabilities: ['search', 'screenshot', 'search'] }),
        ).toEqual(['search', 'screenshot']);
    });

    it('strips falsy entries via `.filter(Boolean)` BEFORE the dedup pass', () => {
        // `.filter(Boolean)` removes empty strings, null, undefined, 0 — pinned so a
        // future "preserve empty capability" change has to be deliberate.
        const record = {
            activeCapabilities: ['search', '', 'screenshot', null as unknown as string],
        };
        expect(getActiveCapabilities(record)).toEqual(['search', 'screenshot']);
    });

    it('treats undefined activeCapabilities as an empty array', () => {
        expect(
            getActiveCapabilities({ activeCapabilities: undefined as unknown as string[] }),
        ).toEqual([]);
    });

    it('treats null activeCapabilities as an empty array via `?? []`', () => {
        expect(getActiveCapabilities({ activeCapabilities: null as unknown as string[] })).toEqual(
            [],
        );
    });

    it('returns an empty array for null record input', () => {
        expect(getActiveCapabilities(null)).toEqual([]);
    });

    it('returns an empty array for undefined record input', () => {
        expect(getActiveCapabilities(undefined)).toEqual([]);
    });

    it('returns an empty array when called with no argument', () => {
        expect(getActiveCapabilities()).toEqual([]);
    });

    it('returns a NEW array (not the underlying record reference)', () => {
        // `Array.from(new Set(...))` always materialises a fresh array — pinned so the
        // caller cannot mutate the entity's `activeCapabilities` field by mutating the
        // returned value.
        const record = { activeCapabilities: ['a', 'b'] };
        const out = getActiveCapabilities(record);
        expect(out).not.toBe(record.activeCapabilities);
    });
});

describe('hasActiveCapability', () => {
    it('returns true when the capability is present', () => {
        expect(
            hasActiveCapability({ activeCapabilities: ['search', 'screenshot'] }, 'search'),
        ).toBe(true);
    });

    it('returns false when the capability is missing', () => {
        expect(hasActiveCapability({ activeCapabilities: ['search'] }, 'screenshot')).toBe(false);
    });

    it('is case-sensitive', () => {
        expect(hasActiveCapability({ activeCapabilities: ['search'] }, 'SEARCH')).toBe(false);
    });

    it('returns false when activeCapabilities is empty', () => {
        expect(hasActiveCapability({ activeCapabilities: [] }, 'search')).toBe(false);
    });

    it('returns false for null record (never-throws guarantee)', () => {
        expect(hasActiveCapability(null, 'search')).toBe(false);
    });

    it('treats falsy entries as absent (does not match `""`)', () => {
        expect(hasActiveCapability({ activeCapabilities: ['', 'search'] }, '')).toBe(false);
    });
});

describe('addActiveCapability', () => {
    it('appends a new capability', () => {
        expect(addActiveCapability({ activeCapabilities: ['search'] }, 'screenshot')).toEqual([
            'search',
            'screenshot',
        ]);
    });

    it('is idempotent — adding an already-present capability does not duplicate', () => {
        expect(addActiveCapability({ activeCapabilities: ['search'] }, 'search')).toEqual([
            'search',
        ]);
    });

    it('starts from an empty array when activeCapabilities is empty', () => {
        expect(addActiveCapability({ activeCapabilities: [] }, 'search')).toEqual(['search']);
    });

    it('strips falsy entries from the existing array before appending', () => {
        // `getActiveCapabilities` is called first — the `.filter(Boolean)` cleanup runs
        // BEFORE the new entry is added, so a stale empty string in the entity is
        // silently cleaned up on every add.
        expect(
            addActiveCapability(
                { activeCapabilities: ['search', '', null as unknown as string] },
                'screenshot',
            ),
        ).toEqual(['search', 'screenshot']);
    });

    it('returns a NEW array (does not mutate the input record)', () => {
        const record = { activeCapabilities: ['search'] };
        const out = addActiveCapability(record, 'screenshot');
        expect(out).not.toBe(record.activeCapabilities);
        expect(record.activeCapabilities).toEqual(['search']);
    });

    it('preserves insertion order — appended at the end', () => {
        expect(addActiveCapability({ activeCapabilities: ['c', 'a', 'b'] }, 'd')).toEqual([
            'c',
            'a',
            'b',
            'd',
        ]);
    });
});

describe('removeActiveCapability', () => {
    it('removes the named capability', () => {
        expect(
            removeActiveCapability({ activeCapabilities: ['search', 'screenshot'] }, 'search'),
        ).toEqual(['screenshot']);
    });

    it('is idempotent — removing a missing capability returns the cleaned list', () => {
        expect(removeActiveCapability({ activeCapabilities: ['search'] }, 'screenshot')).toEqual([
            'search',
        ]);
    });

    it('returns an empty array when removing the only entry', () => {
        expect(removeActiveCapability({ activeCapabilities: ['search'] }, 'search')).toEqual([]);
    });

    it('removes ALL occurrences via the dedup pass', () => {
        // `getActiveCapabilities` dedups before filtering — duplicates in the entity become
        // a single entry, then the filter strips it. Pinned so a "remove only first
        // occurrence" refactor would break loudly.
        expect(
            removeActiveCapability(
                { activeCapabilities: ['search', 'screenshot', 'search'] },
                'search',
            ),
        ).toEqual(['screenshot']);
    });

    it('is case-sensitive', () => {
        expect(removeActiveCapability({ activeCapabilities: ['search'] }, 'SEARCH')).toEqual([
            'search',
        ]);
    });

    it('strips falsy entries during the cleanup pass', () => {
        expect(
            removeActiveCapability(
                { activeCapabilities: ['search', '', null as unknown as string] },
                'something-else',
            ),
        ).toEqual(['search']);
    });

    it('returns a NEW array (does not mutate the input)', () => {
        const record = { activeCapabilities: ['search', 'screenshot'] };
        const out = removeActiveCapability(record, 'search');
        expect(out).not.toBe(record.activeCapabilities);
        expect(record.activeCapabilities).toEqual(['search', 'screenshot']);
    });
});
