import { describe, expect, it } from 'vitest';
import type { MergePolicyChainEntry } from '@ever-works/contracts';
import {
    clearField,
    describeFieldOrigin,
    formatBranchList,
    isOverridden,
    isResolvedMergePolicy,
    parseBranchList,
    resolveFieldOrigins,
    setField,
    summarizePolicy,
    toggleMergeMethod,
} from './merge-policy';

/**
 * Merge-policy matrix (Wave 3, D4) — the settings UI's pure half.
 *
 * The one thing these specs exist to protect is the difference between
 * "inherit" and "explicitly false". A stored policy is a PARTIAL: an
 * absent key means the next scope up decides, a `false` means this scope
 * forbids it. Conflating them would make the settings card actively
 * misleading, so `clearField` deleting rather than falsifying is pinned
 * here.
 */
describe('resolveFieldOrigins', () => {
    const chain: MergePolicyChainEntry[] = [
        { scope: 'default', id: null, fields: ['requireGreenGate', 'protectedBranches'] },
        { scope: 'tenant', id: 'tenant-1', fields: ['requireHumanApproval'] },
        { scope: 'organization', id: 'org-1', fields: ['allowedMergeMethods'] },
        { scope: 'work', id: 'work-1', fields: ['allowAgentMerge'] },
    ];

    it('maps every field to the scope that actually owns it', () => {
        const origins = resolveFieldOrigins(chain, 'work');
        expect(origins.allowAgentMerge.source).toBe('work');
        expect(origins.allowedMergeMethods.source).toBe('organization');
        expect(origins.requireHumanApproval.source).toBe('tenant');
        expect(origins.requireGreenGate.source).toBe('default');
        expect(origins.protectedBranches.source).toBe('default');
    });

    it('marks only the card’s own scope as owned-here', () => {
        const origins = resolveFieldOrigins(chain, 'work');
        expect(origins.allowAgentMerge.ownedHere).toBe(true);
        expect(origins.allowedMergeMethods.ownedHere).toBe(false);
        expect(origins.requireHumanApproval.ownedHere).toBe(false);
    });

    it('re-renders the SAME chain differently for a different scope', () => {
        const asOrg = resolveFieldOrigins(chain, 'organization');
        expect(asOrg.allowedMergeMethods.ownedHere).toBe(true);
        expect(asOrg.allowAgentMerge.ownedHere).toBe(false);
    });

    it('carries the owning row id through, so a link can be rendered', () => {
        const origins = resolveFieldOrigins(chain, 'agent');
        expect(origins.allowAgentMerge.id).toBe('work-1');
        expect(origins.requireGreenGate.id).toBeNull();
    });

    it('degrades to the platform default on an empty/absent chain', () => {
        // `MergePolicyService.resolve` returns `chain: []` when a lookup
        // fails — the card must still render something honest.
        const origins = resolveFieldOrigins([], 'work');
        expect(origins.allowAgentMerge).toEqual({ source: 'default', ownedHere: false, id: null });
        expect(resolveFieldOrigins(undefined, 'work').requireGreenGate.source).toBe('default');
    });

    it('ignores chain entries naming fields the UI does not render', () => {
        const origins = resolveFieldOrigins(
            [{ scope: 'work', id: 'work-1', fields: ['somethingNew'] as never }],
            'work',
        );
        expect(origins.allowAgentMerge.source).toBe('default');
    });
});

describe('describeFieldOrigin', () => {
    it('says "Set here" only for the card’s own scope', () => {
        expect(describeFieldOrigin({ source: 'work', ownedHere: true, id: 'w' })).toBe('Set here');
    });

    it('names the ancestor it was inherited from', () => {
        expect(describeFieldOrigin({ source: 'organization', ownedHere: false, id: 'o' })).toBe(
            'Inherited from organization',
        );
        expect(describeFieldOrigin({ source: 'tenant', ownedHere: false, id: 't' })).toBe(
            'Inherited from tenant',
        );
    });

    it('names the platform default rather than calling it inheritance', () => {
        expect(describeFieldOrigin({ source: 'default', ownedHere: false, id: null })).toBe(
            'Platform default',
        );
    });
});

describe('clearField / setField / isOverridden', () => {
    it('reset-to-inherit DELETES the key — it never writes false', () => {
        const next = clearField(
            { allowAgentMerge: true, requireGreenGate: false },
            'requireGreenGate',
        );
        expect(next).toEqual({ allowAgentMerge: true });
        expect(next && 'requireGreenGate' in next).toBe(false);
    });

    it('clearing the last field collapses the override to null (stored as NULL)', () => {
        expect(clearField({ allowAgentMerge: true }, 'allowAgentMerge')).toBeNull();
        expect(clearField(null, 'allowAgentMerge')).toBeNull();
    });

    it('setField touches exactly one key and leaves the rest inheriting', () => {
        expect(setField(null, 'allowAgentMerge', true)).toEqual({ allowAgentMerge: true });
        expect(setField({ requireGreenGate: false }, 'allowAgentMerge', true)).toEqual({
            requireGreenGate: false,
            allowAgentMerge: true,
        });
    });

    it('an explicit false IS an override — not the same as inheriting', () => {
        const override = setField(null, 'allowAgentMerge', false);
        expect(isOverridden(override, 'allowAgentMerge')).toBe(true);
        expect(isOverridden(null, 'allowAgentMerge')).toBe(false);
        expect(isOverridden({ requireGreenGate: true }, 'allowAgentMerge')).toBe(false);
    });
});

describe('toggleMergeMethod', () => {
    it('adds and removes in a stable, documented order', () => {
        expect(toggleMergeMethod(['squash'], 'merge', true)).toEqual(['merge', 'squash']);
        expect(toggleMergeMethod(['merge', 'squash'], 'squash', false)).toEqual(['merge']);
    });

    it('preserves an EMPTY list — it means "refuse every merge", not "unset"', () => {
        expect(toggleMergeMethod(['squash'], 'squash', false)).toEqual([]);
    });

    it('is idempotent', () => {
        expect(toggleMergeMethod(['squash'], 'squash', true)).toEqual(['squash']);
    });
});

describe('parseBranchList / formatBranchList', () => {
    it('splits on newlines and commas, trimming and de-duplicating case-insensitively', () => {
        expect(parseBranchList(' main \n Main\ndevelop, stage\n\n')).toEqual([
            'main',
            'develop',
            'stage',
        ]);
    });

    it('caps at the API’s 50 × 255 limits', () => {
        const many = Array.from({ length: 60 }, (_, i) => `branch-${i}`).join('\n');
        expect(parseBranchList(many)).toHaveLength(50);
        expect(parseBranchList('x'.repeat(400))[0]).toHaveLength(255);
    });

    it('round-trips through the textarea', () => {
        expect(parseBranchList(formatBranchList(['main', 'develop']))).toEqual(['main', 'develop']);
        expect(formatBranchList(undefined)).toBe('');
    });
});

describe('summarizePolicy', () => {
    const base = {
        allowAgentMerge: false,
        requireGreenGate: true,
        requireHumanApproval: true,
        allowedMergeMethods: ['squash'] as const,
        protectedBranches: ['main'],
    };

    it('states the conservative default plainly', () => {
        expect(summarizePolicy({ ...base, allowedMergeMethods: ['squash'] })).toContain(
            'may not merge them',
        );
    });

    it('names the conditions when agent merges are on', () => {
        const summary = summarizePolicy({
            ...base,
            allowAgentMerge: true,
            allowedMergeMethods: ['squash'],
        });
        expect(summary).toContain('squash');
        expect(summary).toContain('quality gate is green');
        expect(summary).toContain('human has approved');
    });

    it('does not pretend a merge is possible with no allowed method', () => {
        expect(
            summarizePolicy({
                ...base,
                allowAgentMerge: true,
                requireGreenGate: false,
                requireHumanApproval: false,
                allowedMergeMethods: [],
            }),
        ).toContain('no method');
    });
});

describe('isResolvedMergePolicy', () => {
    it('accepts a well-formed resolution', () => {
        expect(
            isResolvedMergePolicy({
                policy: {
                    allowAgentMerge: false,
                    requireGreenGate: true,
                    requireHumanApproval: true,
                    allowedMergeMethods: ['squash'],
                    protectedBranches: ['main'],
                },
                source: 'default',
                chain: [],
            }),
        ).toBe(true);
    });

    it('rejects anything the card would then crash on', () => {
        expect(isResolvedMergePolicy(null)).toBe(false);
        expect(isResolvedMergePolicy({})).toBe(false);
        expect(isResolvedMergePolicy({ policy: { allowAgentMerge: 'yes' } })).toBe(false);
        expect(isResolvedMergePolicy({ error: 'Unauthorized' })).toBe(false);
    });
});
