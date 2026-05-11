import {
    LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE,
    supportsWorkSourceSync,
} from '../source-sync-support';

describe('LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE', () => {
    it('is the verbatim user-facing copy referenced from the works-config sync surface', () => {
        // Pinned literal — surfaced in the API to explain why a linked work cannot be synced.
        // A silent rename would change the user-visible error string with no compiler error.
        expect(LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE).toBe(
            'Linked works use existing repositories directly and cannot be synced from an import source.',
        );
    });

    it('is a non-empty string', () => {
        expect(typeof LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE).toBe('string');
        expect(LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE.length).toBeGreaterThan(0);
    });
});

describe('supportsWorkSourceSync', () => {
    it('returns true for the three documented syncable source types', () => {
        // Pinned literally — these are the ImportSourceType values the works-config
        // sync flow knows how to project back to the source repository.
        expect(supportsWorkSourceSync('data_repo')).toBe(true);
        expect(supportsWorkSourceSync('awesome_readme')).toBe(true);
        expect(supportsWorkSourceSync('works_config')).toBe(true);
    });

    it('returns false for known non-syncable ImportSourceType values', () => {
        // These are valid ImportSourceType values that the registry intentionally excludes —
        // they map to one-shot imports that have no upstream source to re-pull from.
        expect(supportsWorkSourceSync('linked' as never)).toBe(false);
        expect(supportsWorkSourceSync('linked_repo' as never)).toBe(false);
        expect(supportsWorkSourceSync('git_template' as never)).toBe(false);
    });

    it('returns false for unknown source types passed in via the wider type', () => {
        expect(supportsWorkSourceSync('unknown' as never)).toBe(false);
        expect(supportsWorkSourceSync('' as never)).toBe(false);
    });

    it('returns false for null input via the explicit guard', () => {
        // The function signature uses `?: ImportSourceType | null` — the `!!sourceType` short-circuit
        // converts both null and undefined to false BEFORE the Set lookup, so a future swap
        // to `Set.has(null)` (which would return false anyway) is not a behaviour change.
        expect(supportsWorkSourceSync(null)).toBe(false);
    });

    it('returns false for undefined input via the explicit guard', () => {
        expect(supportsWorkSourceSync(undefined)).toBe(false);
    });

    it('returns false when called with no argument (default undefined)', () => {
        expect(supportsWorkSourceSync()).toBe(false);
    });

    it('returns a boolean (not the underlying Set lookup result, not the source type itself)', () => {
        // The `!!sourceType && SYNCABLE.has(sourceType)` shape returns a boolean — pinned so
        // a future `return SYNCABLE.has(sourceType)` rewrite (which would return undefined for
        // null/undefined input) is a deliberate change.
        expect(typeof supportsWorkSourceSync('data_repo')).toBe('boolean');
        expect(typeof supportsWorkSourceSync(null)).toBe('boolean');
    });

    it('is case-sensitive — uppercase variants are NOT recognised', () => {
        // The Set is keyed on the canonical lowercase ImportSourceType literals;
        // any caller passing the wrong case is rejected.
        expect(supportsWorkSourceSync('DATA_REPO' as never)).toBe(false);
        expect(supportsWorkSourceSync('Data_Repo' as never)).toBe(false);
    });
});
