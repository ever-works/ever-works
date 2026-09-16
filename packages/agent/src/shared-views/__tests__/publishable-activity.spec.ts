import { ActivityActionType } from '../../entities/activity-log.types';
import { FEED_NARRATORS } from '../../activity-log/feed-narration';
import {
    NEVER_PUBLISH_ACTIVITY_ACTIONS,
    PUBLISHABLE_ACTIVITY_ACTIONS,
    isActivityPublishable,
} from '../publishable-activity';

describe('shared view activity classification', () => {
    const members = Object.values(ActivityActionType) as string[];

    it('classifies every ActivityActionType member exactly once', () => {
        for (const member of members) {
            const published = PUBLISHABLE_ACTIVITY_ACTIONS.includes(member);
            const never = NEVER_PUBLISH_ACTIVITY_ACTIONS.includes(member);
            expect({ member, classified: published !== never }).toEqual({
                member,
                classified: true,
            });
        }
    });

    it('publishes only real activity kinds', () => {
        const unknown = PUBLISHABLE_ACTIVITY_ACTIONS.filter((action) => !members.includes(action));
        expect(unknown).toEqual([]);
    });

    it('publishes only kinds whose narration reads nothing beyond a title or a status token', () => {
        // A narration param sourced from a path, a repository, a Work name or
        // an amount would put that on the published page. The kinds on the
        // allowlist may read `title` and a `to` status choice — nothing else.
        const allowedSources = new Set(['details:title', 'details:to']);
        for (const action of PUBLISHABLE_ACTIVITY_ACTIONS) {
            const narrator = FEED_NARRATORS[action];
            for (const spec of Object.values(narrator?.params ?? {})) {
                const source =
                    spec.source.from === 'details' || spec.source.from === 'metadata'
                        ? `${spec.source.from}:${spec.source.key}`
                        : spec.source.from;
                expect({ action, source, allowed: allowedSources.has(source) }).toEqual({
                    action,
                    source,
                    allowed: true,
                });
            }
        }
    });

    it.each([
        ActivityActionType.TASK_COMMENTED,
        ActivityActionType.TASK_MERGED,
        ActivityActionType.AGENT_RUN_FAILED,
        ActivityActionType.AGENT_BUDGET_EXCEEDED,
        ActivityActionType.KB_DOCUMENT_CREATED,
        ActivityActionType.GIT_PUSHED,
        ActivityActionType.MISSION_CREATED,
        ActivityActionType.INBOX_ITEM_CREATED,
        ActivityActionType.MEMBER_INVITED,
        ActivityActionType.SHARED_VIEW_ENABLED,
        ActivityActionType.SHARED_VIEW_REGENERATED,
    ])('never publishes %s', (action) => {
        expect(isActivityPublishable(action)).toBe(false);
        expect(NEVER_PUBLISH_ACTIVITY_ACTIONS).toContain(action);
    });

    it('fails closed for a kind nobody has classified', () => {
        expect(isActivityPublishable('a_kind_added_tomorrow')).toBe(false);
    });
});
