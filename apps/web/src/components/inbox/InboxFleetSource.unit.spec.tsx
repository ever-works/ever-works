import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InboxFleetSource } from './InboxFleetSource';
import type { InboxItem } from '@/lib/api/inbox.shared';

/**
 * Self-build slice Q — the provenance chips on a question a FLEET run
 * asked. The owner must see which machine, Task and branch a question
 * belongs to before answering; every other source type renders nothing.
 */

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

function item(overrides: Partial<InboxItem> = {}): InboxItem {
    return {
        id: 'i1',
        kind: 'question',
        title: 'Use Postgres?',
        body: 'Use Postgres?\n\nContext…',
        options: null,
        sourceType: 'fleet-run',
        sourceMeta: {
            nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            nodeName: 'everdesk2',
            branch: 'task/tsk-1-fix-the-thing',
            taskTitle: 'Fix the thing',
            prUrl: null,
            mountDir: null,
        },
        agentId: 'agent-1',
        agentRunId: 'run-1',
        taskId: 't1',
        workId: 'w1',
        escalationId: null,
        proposalId: null,
        status: 'open',
        unread: true,
        answeredAt: null,
        answerText: null,
        answerOptionId: null,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        ...overrides,
    };
}

describe('InboxFleetSource', () => {
    it('renders nothing for a cloud (agent-run) question, even one carrying sourceMeta', () => {
        const { container } = render(<InboxFleetSource item={item({ sourceType: 'agent-run' })} />);
        expect(container.firstChild).toBeNull();
        const compact = render(
            <InboxFleetSource item={item({ sourceType: 'system', kind: 'notice' })} compact />,
        );
        expect(compact.container.firstChild).toBeNull();
    });

    it('shows the badge, node, Task and branch of a fleet-run question', () => {
        render(<InboxFleetSource item={item()} />);
        const line = screen.getByTestId('inbox-fleet-source');
        expect(line.textContent).toContain('dashboard.inbox.fleet.badge');
        expect(screen.getByTestId('inbox-fleet-source-node').textContent).toBe(
            'dashboard.inbox.fleet.node: everdesk2',
        );
        expect(screen.getByTestId('inbox-fleet-source-task').textContent).toBe(
            'dashboard.inbox.fleet.task: Fix the thing',
        );
        const branch = screen.getByTestId('inbox-fleet-source-branch');
        expect(branch.textContent).toBe('dashboard.inbox.fleet.branch: task/tsk-1-fix-the-thing');
        expect(branch.querySelector('code')?.textContent).toBe('task/tsk-1-fix-the-thing');
        // No PR was recorded → no link at all, not an empty anchor.
        expect(screen.queryByTestId('inbox-fleet-source-pr')).toBeNull();
    });

    it('falls back to the head of the node id when the node has no name', () => {
        render(
            <InboxFleetSource
                item={item({
                    sourceMeta: {
                        nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                        nodeName: null,
                        branch: null,
                        taskTitle: null,
                    },
                })}
            />,
        );
        expect(screen.getByTestId('inbox-fleet-source-node').textContent).toBe(
            'dashboard.inbox.fleet.node: a1b2c3d4',
        );
        expect(screen.queryByTestId('inbox-fleet-source-task')).toBeNull();
        expect(screen.queryByTestId('inbox-fleet-source-branch')).toBeNull();
    });

    it('survives a fleet-run row without sourceMeta (older API / degraded producer)', () => {
        render(<InboxFleetSource item={item({ sourceMeta: undefined })} />);
        const line = screen.getByTestId('inbox-fleet-source');
        expect(line.textContent).toBe('dashboard.inbox.fleet.badge');
        render(<InboxFleetSource item={item({ id: 'i2', sourceMeta: null })} />);
        expect(screen.getAllByTestId('inbox-fleet-source')).toHaveLength(2);
    });

    it('compact renders only the badge — for the list row', () => {
        render(<InboxFleetSource item={item()} compact />);
        expect(screen.getByTestId('inbox-fleet-source-badge').textContent).toBe(
            'dashboard.inbox.fleet.badge',
        );
        expect(screen.queryByTestId('inbox-fleet-source')).toBeNull();
        expect(screen.queryByText(/everdesk2/)).toBeNull();
    });

    it('appends the mount directory to the branch when the question came from a mount', () => {
        render(
            <InboxFleetSource
                item={item({
                    sourceMeta: {
                        nodeName: 'everdesk2',
                        branch: 'task/tsk-1-fix-the-thing',
                        mountDir: 'template',
                    },
                })}
            />,
        );
        expect(screen.getByTestId('inbox-fleet-source-branch').textContent).toBe(
            'dashboard.inbox.fleet.branch: task/tsk-1-fix-the-thing (.mounts/template)',
        );
    });

    it('links the pull request only for a real http(s) URL and never renders meta as markup', () => {
        render(
            <InboxFleetSource
                item={item({
                    sourceMeta: {
                        nodeName: '<b>node</b>',
                        branch: 'task/tsk-1-fix-the-thing',
                        prUrl: 'https://github.com/ever-works/ever-works/pull/42',
                    },
                })}
            />,
        );
        const link = screen.getByTestId('inbox-fleet-source-pr');
        expect(link.getAttribute('href')).toBe('https://github.com/ever-works/ever-works/pull/42');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(link.textContent).toBe('dashboard.inbox.fleet.pullRequest');
        // The node name is text: the literal tag survives, no <b> element exists.
        const node = screen.getByTestId('inbox-fleet-source-node');
        expect(node.textContent).toBe('dashboard.inbox.fleet.node: <b>node</b>');
        expect(node.querySelector('b')).toBeNull();
    });

    it('drops a non-http pull request URL rather than rendering it as a link', () => {
        render(
            <InboxFleetSource
                item={item({
                    sourceMeta: { nodeName: 'everdesk2', prUrl: 'javascript:alert(1)' },
                })}
            />,
        );
        expect(screen.queryByTestId('inbox-fleet-source-pr')).toBeNull();
    });
});
