import type { FeedEntryDto } from '@ever-works/contracts';
import {
    publishActivityLine,
    publishAgent,
    publishDocument,
    publishDocumentSummary,
    publishTaskCard,
} from '../publish-filter';

/**
 * The publish filters are the security boundary of the shared view. These
 * specs pin the EXACT key set of every published object and feed each filter
 * a row carrying everything a visitor must never see, so a field that is not
 * deliberately published fails here first.
 */

const NOW = new Date('2026-09-14T12:00:00.000Z');

/** Everything a rich in-product row can carry that must never be published. */
const FORBIDDEN = {
    id: 'task-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    missionId: 'mission-1',
    workId: 'work-1',
    ideaId: 'idea-1',
    teamId: 'team-1',
    agentId: 'agent-1',
    goalId: 'goal-1',
    parentTaskId: 'parent-1',
    costUsd: 12.4,
    costCents: 1240,
    budget: 50,
    tokenCount: 90_000,
    totalTokens: 90_000,
    model: 'large-model-2',
    instructions: 'You are an internal agent',
    comments: [{ body: 'internal comment' }],
    repoUrl: 'https://git.example.com/acme/private-repo',
    prUrl: 'https://git.example.com/acme/private-repo/pull/7',
    branchRef: 'feature/secret-branch',
    email: 'owner@example.com',
    description: 'internal description',
    provenance: [{ kind: 'mission', label: 'Mission X' }],
    latestRunId: 'run-1',
};

const FORBIDDEN_STRINGS = [
    'task-1',
    'user-1',
    'tenant-1',
    'org-1',
    'mission-1',
    'work-1',
    'idea-1',
    'team-1',
    'agent-1',
    'goal-1',
    'large-model-2',
    'internal agent',
    'internal comment',
    'private-repo',
    'secret-branch',
    'owner@example.com',
    'internal description',
    'Mission X',
    'run-1',
];

function expectNothingForbidden(value: unknown): void {
    const serialised = JSON.stringify(value);
    for (const forbidden of FORBIDDEN_STRINGS) {
        expect(serialised).not.toContain(forbidden);
    }
}

describe('publishTaskCard', () => {
    const agentNames = new Map([['agent-1', 'Nova']]);

    const row = {
        ...FORBIDDEN,
        title: 'Q4 pricing review',
        status: 'in_progress',
        priority: 'p1',
        labels: ['pricing', 'finance', 'q4', 'overflow-label'],
        updatedAt: new Date('2026-09-14T11:54:00.000Z'),
        latestRunStatus: 'running',
        run: {
            status: 'running',
            costCents: 1240,
            totalTokens: 90_000,
            currentActivity: 'secret step',
        },
    };

    it('publishes exactly the card allowlist', () => {
        const card = publishTaskCard(row, { column: 'in_flight', agentNames, now: NOW });
        expect(Object.keys(card).sort()).toEqual(
            ['agent', 'column', 'labels', 'lastProgressAt', 'priority', 'stale', 'title'].sort(),
        );
        expect(Object.keys(card.agent ?? {})).toEqual(['name']);
    });

    it('drops every owner column, cost, run detail and provenance', () => {
        const card = publishTaskCard(row, { column: 'in_flight', agentNames, now: NOW });
        expectNothingForbidden(card);
        expect(JSON.stringify(card)).not.toContain('secret step');
        expect(card).toEqual({
            title: 'Q4 pricing review',
            column: 'in_flight',
            priority: 'p1',
            labels: ['pricing', 'finance', 'q4'],
            lastProgressAt: '2026-09-14T11:54:00.000Z',
            stale: false,
            agent: { name: 'Nova' },
        });
    });

    it('flags a card whose in-flight work has stopped moving', () => {
        const card = publishTaskCard(
            {
                ...row,
                latestRunStatus: 'completed',
                run: { status: 'completed' },
                updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            },
            { column: 'in_flight', agentNames, now: NOW },
        );
        expect(card.stale).toBe(true);
    });

    it('names no Agent it does not know, and falls back on an unknown priority', () => {
        const card = publishTaskCard(
            { ...row, agentId: 'agent-unknown', priority: 'urgent' },
            { column: 'backlog', agentNames, now: NOW },
        );
        expect(card.agent).toBeNull();
        expect(card.priority).toBe('p3');
    });

    it('keeps titles to one clean line and redacts credential-shaped text', () => {
        const card = publishTaskCard(
            {
                ...row,
                title: 'Rotate\nkey sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD now',
            },
            { column: 'backlog', agentNames, now: NOW },
        );
        expect(card.title).not.toContain('\n');
        expect(card.title).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    });
});

describe('publishAgent', () => {
    const agent = { ...FORBIDDEN, label: 'Nova', status: 'active', avatarMode: 'image' };

    it('publishes exactly name, status and in-flight count', () => {
        const published = publishAgent(agent, { inFlightCount: 2 });
        expect(Object.keys(published).sort()).toEqual(['inFlightCount', 'name', 'status']);
        expectNothingForbidden(published);
        expect(published).toEqual({ name: 'Nova', status: 'working', inFlightCount: 2 });
    });

    it('maps a paused Agent to paused, a running one to working, the rest to idle', () => {
        expect(publishAgent({ ...agent, status: 'paused' }, { inFlightCount: 3 }).status).toBe(
            'paused',
        );
        expect(publishAgent({ ...agent, status: 'running' }, { inFlightCount: 0 }).status).toBe(
            'working',
        );
        expect(publishAgent({ ...agent, status: 'error' }, { inFlightCount: 0 }).status).toBe(
            'idle',
        );
        expect(publishAgent(agent, { inFlightCount: -4 }).inFlightCount).toBe(0);
    });
});

describe('publishActivityLine', () => {
    function entry(overrides: Partial<FeedEntryDto> = {}): FeedEntryDto {
        return {
            id: 'activity-1',
            createdAt: '2026-09-14T09:00:00.000Z',
            kind: 'work',
            status: 'completed',
            actionType: 'task_created',
            actor: { kind: 'agent', agentId: 'agent-1', label: 'Nova', avatarMode: 'initials' },
            narration: {
                key: 'taskCreated',
                params: {
                    actor: 'Nova',
                    subject: 'Site copy refresh',
                    hasSubject: 'yes',
                    costUsd: 12,
                    email: 'owner@example.com',
                },
            },
            target: { type: 'task', id: 'task-1' },
            workId: 'work-1',
            ...overrides,
        };
    }

    it('publishes exactly actor kind, actor name, narration and time', () => {
        const line = publishActivityLine(entry());
        expect(line).not.toBeNull();
        expect(Object.keys(line!).sort()).toEqual(['actorKind', 'actorName', 'at', 'narration']);
        expect(Object.keys(line!.narration).sort()).toEqual(['key', 'params']);
        expect(line!.narration.params).toEqual({
            actor: 'Nova',
            subject: 'Site copy refresh',
            hasSubject: 'yes',
        });
        expectNothingForbidden(line);
    });

    it('never names a person', () => {
        const line = publishActivityLine(
            entry({
                actionType: 'task_assigned',
                actor: { kind: 'user', label: 'Lena Owner' },
                narration: { key: 'taskAssigned', params: { actor: 'Lena Owner' } },
            }),
        );
        expect(line).toEqual({
            actorKind: 'person',
            actorName: null,
            narration: { key: 'taskAssigned', params: { actor: '' } },
            at: '2026-09-14T09:00:00.000Z',
        });
        expect(JSON.stringify(line)).not.toContain('Lena');
    });

    it.each([
        'task_commented',
        'kb_document_created',
        'git_pushed',
        'mission_created',
        'agent_run_failed',
        'inbox_item_created',
        'member_invited',
        'shared_view_regenerated',
        'a_kind_added_tomorrow',
    ])('drops %s — the strip fails closed', (actionType) => {
        expect(publishActivityLine(entry({ actionType }))).toBeNull();
    });
});

describe('publishDocumentSummary / publishDocument', () => {
    const document = {
        ...FORBIDDEN,
        title: 'Refund policy',
        kbDocumentClass: 'glossary',
        wordCount: 640,
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        path: 'glossary/refund-policy.md',
        commitSha: 'abc123',
        citations: ['internal'],
        embeddingStatus: 'embedded',
    };

    it('publishes exactly the summary allowlist with the caller-supplied reference', () => {
        const summary = publishDocumentSummary(document, { ref: 'doc-ref-1', now: NOW });
        expect(Object.keys(summary).sort()).toEqual(
            ['documentClass', 'ref', 'title', 'updatedAt', 'wordCount'].sort(),
        );
        expectNothingForbidden(summary);
        expect(JSON.stringify(summary)).not.toContain('refund-policy.md');
        expect(JSON.stringify(summary)).not.toContain('abc123');
    });

    it('adds only the body to a published document', () => {
        const published = publishDocument(document, {
            ref: 'doc-ref-1',
            body: 'Customers may request a refund within 30 days.',
            now: NOW,
        });
        expect(Object.keys(published).sort()).toEqual(
            ['body', 'documentClass', 'ref', 'title', 'updatedAt', 'wordCount'].sort(),
        );
        expect(published.body).toBe('Customers may request a refund within 30 days.');
    });
});
