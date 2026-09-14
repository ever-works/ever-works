import { FEED_NARRATION_PARAM_MAX_CHARS } from '@ever-works/contracts';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
    FEED_NARRATION_FALLBACK_KEY,
    FEED_NARRATORS,
    humanizeActionType,
    narrate,
    sanitizeNarrationParam,
} from './feed-narration';

const row = (
    actionType: string,
    extra: {
        status?: string;
        details?: Record<string, unknown> | null;
        metadata?: Record<string, unknown> | null;
        work?: { name?: string | null } | null;
    } = {},
) => ({
    actionType,
    status: extra.status ?? ActivityStatus.COMPLETED,
    details: extra.details ?? null,
    metadata: extra.metadata ?? null,
    work: extra.work ?? null,
});

describe('feed narration', () => {
    it('covers at least 48 action types with bespoke narration', () => {
        expect(Object.keys(FEED_NARRATORS).length).toBeGreaterThanOrEqual(48);
    });

    it('only narrates real ActivityActionType members', () => {
        const members = Object.values(ActivityActionType) as string[];
        expect(Object.keys(FEED_NARRATORS).filter((key) => !members.includes(key))).toEqual([]);
    });

    it('uses camelCase keys with no dots (message leaf names)', () => {
        for (const entry of Object.values(FEED_NARRATORS)) {
            expect(entry.key).toMatch(/^[a-z][a-zA-Z0-9]*$/);
        }
    });

    it.each(Object.entries(FEED_NARRATORS))(
        '%s narrates to its own key and always carries the actor',
        (actionType, entry) => {
            const narration = narrate(row(actionType), 'Ivy');
            expect(narration.key).toBe(entry.key);
            expect(narration.params.actor).toBe('Ivy');
        },
    );

    it('returns the fallback key with a humanised action label for an unknown action type', () => {
        const narration = narrate(row('some_brand_new_thing'), 'Wren');
        expect(narration).toEqual({
            key: FEED_NARRATION_FALLBACK_KEY,
            params: { actor: 'Wren', action: 'Some brand new thing' },
        });
        expect(String(narration.params.action)).not.toContain('_');
    });

    it('reads a declared subject and flags whether it was present', () => {
        expect(
            narrate(
                row(ActivityActionType.TASK_CREATED, { details: { title: 'Refresh listings' } }),
                'Ivy',
            ).params,
        ).toEqual({ actor: 'Ivy', subject: 'Refresh listings', hasSubject: 'yes' });

        expect(
            narrate(row(ActivityActionType.TASK_CREATED, { details: {} }), 'Ivy').params,
        ).toEqual({
            actor: 'Ivy',
            hasSubject: 'no',
        });
    });

    it('never exposes a details key that is not on the entry allow-list', () => {
        const narration = narrate(
            row(ActivityActionType.TASK_CREATED, {
                details: {
                    title: 'Weekly sweep',
                    apiKey: 'sk-live-should-never-show',
                    token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                },
                metadata: { secret: 'nope' },
            }),
            'Ivy',
        );
        const serialized = JSON.stringify(narration);
        expect(serialized).not.toContain('sk-live');
        expect(serialized).not.toContain('ghp_');
        expect(serialized).not.toContain('nope');
        expect(Object.keys(narration.params).sort()).toEqual(['actor', 'hasSubject', 'subject']);
    });

    it('does not read inherited or nested keys', () => {
        const details = Object.create({ title: 'from the prototype' }) as Record<string, unknown>;
        expect(
            narrate(row(ActivityActionType.TASK_CREATED, { details }), 'Ivy').params.hasSubject,
        ).toBe('no');
        expect(
            narrate(
                row(ActivityActionType.TASK_CREATED, { details: { title: { nested: 'x' } } }),
                'Ivy',
            ).params.hasSubject,
        ).toBe('no');
    });

    it('strips angle brackets from interpolated values', () => {
        const narration = narrate(
            row(ActivityActionType.MISSION_CREATED, {
                details: { title: '<script>alert(1)</script>Launch' },
            }),
            '<b>Ivy</b>',
        );
        expect(narration.params.subject).toBe('scriptalert(1)/scriptLaunch');
        expect(narration.params.actor).toBe('bIvy/b');
    });

    it('redacts a credential-shaped value that sits in an allowed field', () => {
        const narration = narrate(
            row(ActivityActionType.TASK_CREATED, {
                details: { title: 'Rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789 today' },
            }),
            'Ivy',
        );
        expect(String(narration.params.subject)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    });

    it('truncates a long value to 120 characters plus an ellipsis', () => {
        const narration = narrate(
            row(ActivityActionType.TASK_CREATED, { details: { title: 'x'.repeat(200) } }),
            'Ivy',
        );
        const subject = String(narration.params.subject);
        expect(subject.endsWith('…')).toBe(true);
        expect(Array.from(subject)).toHaveLength(FEED_NARRATION_PARAM_MAX_CHARS + 1);
    });

    it('emits a select-safe token for choice params and `unknown` for anything else', () => {
        expect(
            narrate(
                row(ActivityActionType.TASK_TRANSITIONED, { details: { to: 'in_review' } }),
                'Ivy',
            ).params.to,
        ).toBe('in_review');
        expect(
            narrate(
                row(ActivityActionType.TASK_TRANSITIONED, {
                    details: { to: 'Done} other {pwned' },
                }),
                'Ivy',
            ).params.to,
        ).toBe('unknown');
        expect(narrate(row(ActivityActionType.TASK_TRANSITIONED), 'Ivy').params.to).toBe('unknown');
        expect(
            narrate(
                row(ActivityActionType.DEPLOYMENT, { status: ActivityStatus.IN_PROGRESS }),
                'Ivy',
            ).params.status,
        ).toBe('in_progress');
    });

    it('emits counts as integers and flags missing or invalid ones', () => {
        expect(
            narrate(row(ActivityActionType.IDEA_GENERATED, { details: { count: 3 } }), 'Ivy')
                .params,
        ).toEqual({ actor: 'Ivy', count: 3, hasCount: 'yes' });
        expect(
            narrate(row(ActivityActionType.IDEA_GENERATED, { details: { count: -1 } }), 'Ivy')
                .params,
        ).toEqual({ actor: 'Ivy', hasCount: 'no' });
        expect(
            narrate(row(ActivityActionType.IDEA_GENERATED, { details: { count: '3' } }), 'Ivy')
                .params,
        ).toEqual({ actor: 'Ivy', hasCount: 'no' });
    });

    it('reads the Work name from the joined record, not from details', () => {
        const narration = narrate(
            row(ActivityActionType.GENERATION, {
                work: { name: 'Analytics tools' },
                details: { workName: 'spoofed' },
            }),
            null,
        );
        expect(narration.params).toMatchObject({
            actor: '',
            work: 'Analytics tools',
            hasWork: 'yes',
            status: 'completed',
        });
    });

    it('renders a PR number as text, so it is never locale-grouped', () => {
        expect(
            narrate(row(ActivityActionType.TASK_MERGED, { details: { prNumber: 1234 } }), 'Ivy')
                .params.prNumber,
        ).toBe('1234');
    });

    describe('sanitizeNarrationParam', () => {
        it('returns an empty string for non-text values', () => {
            expect(sanitizeNarrationParam(undefined)).toBe('');
            expect(sanitizeNarrationParam(null)).toBe('');
            expect(sanitizeNarrationParam({})).toBe('');
            expect(sanitizeNarrationParam(Number.NaN)).toBe('');
        });

        it('collapses newlines and extra whitespace into one line', () => {
            expect(sanitizeNarrationParam('  a\n\nb\t c  ')).toBe('a b c');
        });
    });

    it('humanizes dotted and underscored tokens', () => {
        expect(humanizeActionType('website.item_submitted')).toBe('Website item submitted');
        expect(humanizeActionType('')).toBe('');
    });
});
