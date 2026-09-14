import { FEED_KINDS } from '@ever-works/contracts';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
    FEED_KIND_RULES,
    buildFeedKindSets,
    feedKindRuleFor,
    normalizeFeedKinds,
    resolveFeedKind,
} from './feed-kind';

describe('feed kind map', () => {
    const allActionTypes = Object.values(ActivityActionType) as string[];

    it('holds an explicit decision for every ActivityActionType member', () => {
        // A new enum member must be placed in a bucket on purpose. If this
        // fails, add the member to FEED_KIND_RULES in feed-kind.ts.
        const unmapped = allActionTypes.filter((actionType) => !(actionType in FEED_KIND_RULES));
        expect(unmapped).toEqual([]);
    });

    it('does not carry rules for action types that no longer exist', () => {
        const stale = Object.keys(FEED_KIND_RULES).filter((key) => !allActionTypes.includes(key));
        expect(stale).toEqual([]);
    });

    it.each(allActionTypes)(
        '%s resolves to exactly one of the five kinds for every status',
        (actionType) => {
            for (const status of Object.values(ActivityStatus)) {
                expect(FEED_KINDS).toContain(resolveFeedKind(actionType, status));
            }
        },
    );

    it('classifies every failure / refusal / tripped-limit member as a problem', () => {
        const failureShaped = allActionTypes.filter((actionType) =>
            /_(failed|refused|tripped|exceeded|capped|violation)$/.test(actionType),
        );
        expect(failureShaped.length).toBeGreaterThan(5);
        for (const actionType of failureShaped) {
            expect(resolveFeedKind(actionType, ActivityStatus.COMPLETED)).toBe('problem');
        }
    });

    it('lets a failed or cancelled status override the cluster rule (problem is evaluated first)', () => {
        expect(
            resolveFeedKind(ActivityActionType.INBOX_ITEM_CREATED, ActivityStatus.COMPLETED),
        ).toBe('decision');
        expect(resolveFeedKind(ActivityActionType.INBOX_ITEM_CREATED, ActivityStatus.FAILED)).toBe(
            'problem',
        );
        expect(resolveFeedKind(ActivityActionType.SETTINGS_UPDATED, ActivityStatus.CANCELLED)).toBe(
            'problem',
        );
        expect(resolveFeedKind(ActivityActionType.KB_DOCUMENT_CREATED, ActivityStatus.FAILED)).toBe(
            'problem',
        );
    });

    it('maps the representative member of each cluster', () => {
        expect(resolveFeedKind(ActivityActionType.TASK_CREATED, 'completed')).toBe('work');
        expect(resolveFeedKind(ActivityActionType.AGENT_RUN_COMPLETED, 'completed')).toBe('work');
        expect(resolveFeedKind(ActivityActionType.INBOX_ITEM_ANSWERED, 'completed')).toBe(
            'decision',
        );
        expect(resolveFeedKind(ActivityActionType.GIT_MERGED, 'completed')).toBe('delivery');
        expect(resolveFeedKind(ActivityActionType.PLUGIN_ENABLED, 'completed')).toBe('system');
        expect(resolveFeedKind(ActivityActionType.AGENT_RUN_FAILED, 'completed')).toBe('problem');
    });

    it('treats a running generation or deployment as work and a finished one as a delivery', () => {
        expect(resolveFeedKind(ActivityActionType.GENERATION, ActivityStatus.IN_PROGRESS)).toBe(
            'work',
        );
        expect(resolveFeedKind(ActivityActionType.DEPLOYMENT, ActivityStatus.PENDING)).toBe('work');
        expect(resolveFeedKind(ActivityActionType.DEPLOYMENT, ActivityStatus.COMPLETED)).toBe(
            'delivery',
        );
        expect(resolveFeedKind(ActivityActionType.GENERATION, ActivityStatus.FAILED)).toBe(
            'problem',
        );
    });

    it('falls back to the suffix rule, then to work, for an action type with no decision', () => {
        expect(feedKindRuleFor('some_future_sync_failed')).toBe('problem');
        expect(feedKindRuleFor('some_future_thing_happened')).toBe('work');
        expect(resolveFeedKind('some_future_thing_happened', null)).toBe('work');
    });

    describe('buildFeedKindSets', () => {
        it('partitions the mapped action types with no overlap', () => {
            const sets = buildFeedKindSets();
            const buckets = [
                sets.problemActionTypes,
                sets.decisionActionTypes,
                sets.systemActionTypes,
                sets.deliveryActionTypes,
                sets.deliveryWhenCompletedActionTypes,
            ];
            const seen = new Set<string>();
            for (const bucket of buckets) {
                for (const actionType of bucket) {
                    expect(seen.has(actionType)).toBe(false);
                    seen.add(actionType);
                }
            }
            expect(sets.problemStatuses).toEqual(['failed', 'cancelled']);
            expect(sets.decisionActionTypes).toEqual(
                expect.arrayContaining(['inbox_item_created', 'inbox_item_answered']),
            );
            expect(sets.deliveryWhenCompletedActionTypes).toEqual(
                expect.arrayContaining(['generation', 'deployment']),
            );
        });

        it('agrees with resolveFeedKind for every mapped action type', () => {
            const sets = buildFeedKindSets();
            for (const actionType of allActionTypes) {
                const kind = resolveFeedKind(actionType, ActivityStatus.COMPLETED);
                if (sets.problemActionTypes.includes(actionType)) expect(kind).toBe('problem');
                else if (sets.decisionActionTypes.includes(actionType))
                    expect(kind).toBe('decision');
                else if (sets.systemActionTypes.includes(actionType)) expect(kind).toBe('system');
                else if (
                    sets.deliveryActionTypes.includes(actionType) ||
                    sets.deliveryWhenCompletedActionTypes.includes(actionType)
                )
                    expect(kind).toBe('delivery');
                else expect(kind).toBe('work');
            }
        });
    });

    describe('normalizeFeedKinds', () => {
        it('returns no predicate for an empty or complete selection', () => {
            expect(normalizeFeedKinds(undefined, false)).toBeUndefined();
            expect(normalizeFeedKinds([], false)).toBeUndefined();
            expect(normalizeFeedKinds([...FEED_KINDS], false)).toBeUndefined();
        });

        it('keeps a partial selection in canonical order and drops unknown values', () => {
            expect(normalizeFeedKinds(['system', 'work', 'bogus'], false)).toEqual([
                'work',
                'system',
            ]);
        });

        it('makes "only what failed" the problem kind, overriding the chips', () => {
            expect(normalizeFeedKinds(undefined, true)).toEqual(['problem']);
            expect(normalizeFeedKinds(['work', 'decision'], true)).toEqual(['problem']);
        });
    });
});
