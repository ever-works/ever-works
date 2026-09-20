import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { FeedEntryDto } from '@ever-works/contracts';

import messages from '../../../messages/en.json';
import { FeedRow } from './FeedRow';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const NOW = new Date('2026-09-13T12:00:00.000Z');

/**
 * Rendered with the REAL `next-intl` provider and the REAL English catalogue,
 * not an echo-the-key mock: a narration message with a broken select or a
 * missing parameter must fail here, not on a user's screen.
 */
function renderRow(entry: Partial<FeedEntryDto>, href: string | null = null) {
    const errors: unknown[] = [];
    const full: FeedEntryDto = {
        id: 'e-1',
        createdAt: '2026-09-13T11:56:00.000Z',
        kind: 'work',
        status: 'completed',
        actionType: 'task_created',
        actor: { kind: 'agent', agentId: 'a-1', label: 'Ivy' },
        narration: { key: 'agentRunCompleted', params: { actor: 'Ivy' } },
        target: null,
        ...entry,
    };
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={(error) => errors.push(error)}
        >
            <FeedRow entry={full} href={href} position={1} setSize={-1} now={NOW} />
        </NextIntlClientProvider>,
    );
    return { ...utils, errors };
}

describe('FeedRow', () => {
    it('renders the narrated line with the actor, the kind pill text and a relative time', () => {
        const { errors } = renderRow({});
        expect(screen.getByText('Ivy')).toBeInTheDocument();
        expect(screen.getByRole('article')).toHaveTextContent('Ivy finished a run');
        expect(screen.getByTestId('feed-kind-pill')).toHaveTextContent('work');
        expect(screen.getByText('4m ago')).toBeInTheDocument();
        expect(errors).toEqual([]);
    });

    it('links to the destination when there is one', () => {
        renderRow({}, '/agents/activity/run-1');
        expect(screen.getByRole('link')).toHaveAttribute('href', '/agents/activity/run-1');
    });

    it('renders plain text, never a dead link, when there is no destination', () => {
        renderRow({}, null);
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByRole('article')).toHaveAttribute('tabindex', '0');
    });

    it('fills in the selected subject and omits it cleanly when absent', () => {
        renderRow({
            narration: {
                key: 'taskCreated',
                params: { actor: 'Ivy', subject: 'Refresh the listings', hasSubject: 'yes' },
            },
        });
        expect(screen.getByRole('article')).toHaveTextContent(
            'Ivy created the task “Refresh the listings”',
        );
    });

    it('calls the signed-in user "You" and the platform "Ever Works"', () => {
        renderRow({ actor: { kind: 'user', label: 'someone@example.com' } });
        expect(screen.getByRole('article')).toHaveTextContent('You finished a run');
    });

    it('reads naturally when the signed-in user saved an agent file', () => {
        const { errors } = renderRow({
            actionType: 'agent_file_edited',
            actor: { kind: 'user', label: null },
            narration: {
                key: 'agentFileEdited',
                params: { actor: '', subject: 'SOUL.md', hasSubject: 'yes' },
            },
        });
        expect(screen.getByRole('article')).toHaveTextContent(
            'You edited the agent file “SOUL.md”',
        );
        expect(errors).toEqual([]);
    });

    it('uses the generic line for an action with no bespoke narration, never a raw token', () => {
        renderRow({
            actionType: 'some_new_thing',
            actor: { kind: 'system', label: null },
            narration: { key: 'fallback', params: { actor: '', action: 'Some new thing' } },
        });
        expect(screen.getByRole('article')).toHaveTextContent('Ever Works · Some new thing');
        expect(screen.getByRole('article').textContent).not.toContain('some_new_thing');
    });

    it('falls back to the generic line when the key is unknown to this build', () => {
        renderRow({
            actionType: 'task_blocker_added',
            narration: { key: 'aKeyFromANewerApi', params: { actor: 'Ivy' } },
        });
        expect(screen.getByRole('article')).toHaveTextContent('Ivy · Task blocker added');
    });

    it('names a deleted agent without a captured name', () => {
        renderRow({ actor: { kind: 'agent', agentId: 'gone', label: null } });
        expect(screen.getByRole('article')).toHaveTextContent('A deleted agent finished a run');
    });

    const narrationFixtures: Array<[string, Record<string, string | number>, string]> = [
        [
            'agentFileEdited',
            { hasSubject: 'yes', subject: 'AGENTS.md' },
            'Ivy edited the agent file “AGENTS.md”',
        ],
        [
            'agentFileEditRejected',
            { hasSubject: 'yes', subject: 'SOUL.md' },
            'Ivy could not save the agent file “SOUL.md” because it changed elsewhere',
        ],
        [
            'missionTick',
            { hasCount: 'yes', count: 2 },
            'Ivy ran a mission tick and created 2 ideas',
        ],
        ['missionTick', { hasCount: 'no' }, 'Ivy ran a mission tick'],
        ['taskTransitioned', { to: 'in_review' }, 'Ivy moved a task to In review'],
        ['taskTransitioned', { to: 'unknown' }, 'Ivy moved a task to a new status'],
        [
            'taskMerged',
            { hasPrNumber: 'yes', prNumber: '1234' },
            'Ivy merged pull request #1234 for a task',
        ],
        [
            'goalIterationDispatched',
            { hasIteration: 'no' },
            'Ivy picked up the next iteration of a goal',
        ],
        ['ideaGenerated', { hasCount: 'yes', count: 1 }, 'Ivy generated 1 idea'],
        ['ideaGenerated', { hasCount: 'no' }, 'Ivy generated new ideas'],
        [
            'kbDocumentCreated',
            { hasSubject: 'yes', subject: 'docs/q4.md' },
            'Ivy added “docs/q4.md” to the knowledge base',
        ],
        ['gitPushed', { hasSubject: 'no' }, 'Ivy pushed to a repository'],
        [
            'externalEventIngested',
            { hasSubject: 'yes', subject: 'issue' },
            'Ivy sent a “issue” event',
        ],
        [
            'scheduleExecuted',
            { hasWork: 'yes', work: 'Tools' },
            'Ivy ran a scheduled update for “Tools”',
        ],
        [
            'deploymentCompleted',
            { status: 'in_progress', hasWork: 'yes', work: 'Tools' },
            'Ivy started deploying “Tools”',
        ],
        [
            'generationCompleted',
            { status: 'failed', hasWork: 'no' },
            'Ivy could not generate a Work',
        ],
    ];

    it.each(narrationFixtures)('formats %s with %j', (key, params, expected) => {
        const { errors } = renderRow({ narration: { key, params: { actor: 'Ivy', ...params } } });
        expect(screen.getByRole('article')).toHaveTextContent(expected);
        expect(errors).toEqual([]);
    });

    it('formats every narration message in the catalogue without an error', () => {
        const narration = (
            messages as { dashboard: { feed: { narration: Record<string, string> } } }
        ).dashboard.feed.narration;
        for (const key of Object.keys(narration)) {
            const { errors, unmount } = renderRow({
                narration: {
                    key,
                    params: {
                        actor: 'Ivy',
                        action: 'Something',
                        subject: 'S',
                        hasSubject: 'yes',
                        work: 'W',
                        hasWork: 'yes',
                        count: 3,
                        hasCount: 'yes',
                        prNumber: '7',
                        hasPrNumber: 'yes',
                        iteration: '2',
                        hasIteration: 'yes',
                        to: 'done',
                        status: 'completed',
                    },
                },
            });
            expect({ key, errors }).toEqual({ key, errors: [] });
            expect(screen.getByRole('article').textContent).not.toMatch(
                /dashboard\.feed|\{|\}|<b>/,
            );
            unmount();
        }
    });
});
