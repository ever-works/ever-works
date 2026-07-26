import {
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_EXTERNAL_REF_KINDS,
    INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
} from '@ever-works/contracts';
import {
    describeExternalRefConflicts,
    findExternalRefConflicts,
    isWorkExternalRefKind,
    normalizeExternalRefValue,
    validateWorkExternalRefs,
    WorkExternalRefsValidationError,
    type ExternalRefClaimant,
} from './work-external-refs';

describe('work external refs — write-path validation', () => {
    it('accepts a well-formed claim map and preserves the caller casing', () => {
        const refs = validateWorkExternalRefs({
            'chat-channel': ['C0123456789'],
            'tracker-team': ['ENG'],
        });

        expect(refs).toEqual({ 'chat-channel': ['C0123456789'], 'tracker-team': ['ENG'] });
    });

    it('returns null for null/undefined and for a map whose kinds are all empty (clear the column)', () => {
        expect(validateWorkExternalRefs(null)).toBeNull();
        expect(validateWorkExternalRefs(undefined)).toBeNull();
        expect(validateWorkExternalRefs({})).toBeNull();
        expect(validateWorkExternalRefs({ 'chat-channel': [] })).toBeNull();
    });

    it('rejects an unknown ref kind by name and lists the allowed kinds', () => {
        expect(() => validateWorkExternalRefs({ repo: ['acme/site'] })).toThrow(
            WorkExternalRefsValidationError,
        );
        try {
            validateWorkExternalRefs({ 'slack-thread': ['x'] });
            throw new Error('expected a validation error');
        } catch (error) {
            expect((error as Error).message).toContain('slack-thread');
            for (const kind of WORK_EXTERNAL_REF_KINDS) {
                expect((error as Error).message).toContain(kind);
            }
        }
    });

    it('rejects a non-object payload and a non-array kind value', () => {
        expect(() => validateWorkExternalRefs(['C1'])).toThrow(WorkExternalRefsValidationError);
        expect(() => validateWorkExternalRefs('C1')).toThrow(WorkExternalRefsValidationError);
        expect(() => validateWorkExternalRefs({ 'chat-channel': 'C1' })).toThrow(
            /must be an array/,
        );
    });

    it('rejects empty, non-string and oversized identifiers', () => {
        expect(() => validateWorkExternalRefs({ 'chat-channel': ['   '] })).toThrow(
            /must not be empty/,
        );
        expect(() => validateWorkExternalRefs({ 'chat-channel': [42] })).toThrow(/must be strings/);
        const tooLong = 'c'.repeat(INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS + 1);
        expect(() => validateWorkExternalRefs({ meeting: [tooLong] })).toThrow(
            new RegExp(`${INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS} characters`),
        );
    });

    it(`rejects more than ${WORK_EXTERNAL_REFS_MAX_PER_KIND} identifiers under one kind`, () => {
        const overCap = Array.from(
            { length: WORK_EXTERNAL_REFS_MAX_PER_KIND + 1 },
            (_, i) => `C${i}`,
        );
        expect(() => validateWorkExternalRefs({ 'chat-channel': overCap })).toThrow(
            new RegExp(`at most ${WORK_EXTERNAL_REFS_MAX_PER_KIND}`),
        );

        // Exactly at the cap is fine.
        const atCap = overCap.slice(0, WORK_EXTERNAL_REFS_MAX_PER_KIND);
        expect(validateWorkExternalRefs({ 'chat-channel': atCap })).toEqual({
            'chat-channel': atCap,
        });
    });

    it('dedupes case-insensitively within one kind instead of rejecting the resubmit', () => {
        const refs = validateWorkExternalRefs({ 'chat-channel': [' C123 ', 'c123', 'C999'] });
        expect(refs).toEqual({ 'chat-channel': ['C123', 'C999'] });
    });

    it('normalizes and guards kinds the same way the ingest resolver does', () => {
        expect(normalizeExternalRefValue(' C123 ')).toBe('c123');
        expect(isWorkExternalRefKind('chat-channel')).toBe(true);
        // `repo` is deliberately NOT a claimable kind — repo hints resolve
        // through the repositories a Work already declares.
        expect(isWorkExternalRefKind('repo')).toBe(false);
        expect(isWorkExternalRefKind(7)).toBe(false);
    });
});

describe('work external refs — duplicate-claim scan', () => {
    const siblings: ExternalRefClaimant[] = [
        { id: 'work-self', name: 'This Work', externalRefs: { 'chat-channel': ['C-SELF'] } },
        { id: 'work-other', name: 'Other Work', externalRefs: { 'chat-channel': ['c-taken'] } },
        { id: 'work-empty', name: 'Empty Work', externalRefs: null },
    ];

    it('flags an identifier already claimed by another Work of the same owner', () => {
        const conflicts = findExternalRefConflicts(
            { 'chat-channel': ['C-TAKEN'] },
            siblings,
            'work-self',
        );

        expect(conflicts).toEqual([
            {
                kind: 'chat-channel',
                externalId: 'C-TAKEN',
                workId: 'work-other',
                workName: 'Other Work',
            },
        ]);
        expect(describeExternalRefConflicts(conflicts)).toContain('Other Work');
        expect(describeExternalRefConflicts(conflicts)).toContain('C-TAKEN');
    });

    it('ignores the Work being edited (re-saving your own claims is not a conflict)', () => {
        expect(
            findExternalRefConflicts({ 'chat-channel': ['C-SELF'] }, siblings, 'work-self'),
        ).toEqual([]);
    });

    it('does not cross ref kinds — the same string under a different kind is free', () => {
        expect(
            findExternalRefConflicts({ 'tracker-team': ['c-taken'] }, siblings, 'work-self'),
        ).toEqual([]);
    });

    it('returns nothing for a cleared claim map or a sibling set with no claims', () => {
        expect(findExternalRefConflicts(null, siblings, 'work-self')).toEqual([]);
        expect(
            findExternalRefConflicts({ 'chat-channel': ['C-NEW'] }, [siblings[2]], 'work-self'),
        ).toEqual([]);
    });

    it('bounds the scan of a hand-edited over-cap sibling row', () => {
        const bloated: ExternalRefClaimant = {
            id: 'work-bloated',
            name: 'Bloated',
            externalRefs: {
                'chat-channel': [
                    ...Array.from({ length: WORK_EXTERNAL_REFS_MAX_PER_KIND }, (_, i) => `C${i}`),
                    'C-BEYOND-CAP',
                ],
            },
        };

        // Inside the cap → seen.
        expect(
            findExternalRefConflicts({ 'chat-channel': ['C0'] }, [bloated], 'work-self'),
        ).toHaveLength(1);
        // Past the cap → not scanned (same bound the resolver applies).
        expect(
            findExternalRefConflicts({ 'chat-channel': ['C-BEYOND-CAP'] }, [bloated], 'work-self'),
        ).toEqual([]);
    });
});
