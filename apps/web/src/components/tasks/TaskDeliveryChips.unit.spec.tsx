import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { TASK_DELIVERY_STATES } from '@ever-works/contracts';
import messages from '../../../messages/en.json';
import type { Task } from '@/lib/api/tasks';
import {
    TaskDeliveryChips,
    deliveryChipKey,
    type TaskDeliveryChipInput,
} from './TaskDeliveryChips';
import { TasksKanbanView } from './TasksKanbanView';

/**
 * APW-08 T27 (ACC-08-17, 21) — the delivery chip on the board, through the REAL English
 * catalogue: every state's copy (spec §6.1), the three failure outcomes told apart, the live
 * link (and no link where the chip sits inside another link), and the chip on a board card.
 */

vi.mock('@/app/actions/tasks', () => ({
    transitionTaskBoardAction: vi.fn(),
    listTaskRunCandidatesAction: vi.fn().mockResolvedValue([]),
    runTasksBatchAction: vi.fn(),
    listTasksWithRunsAction: vi.fn().mockResolvedValue([]),
    runTaskAction: vi.fn(),
    getTaskDiffAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const copy = messages.dashboard.tasksPage.delivery;

function renderChip(delivery: TaskDeliveryChipInput | null, linkLive?: boolean) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TaskDeliveryChips delivery={delivery} linkLive={linkLive} />
        </NextIntlClientProvider>,
    );
}

const chipText = () =>
    screen.getByTestId('task-delivery-chip').textContent?.replace('↗', '').trim();

afterEach(() => cleanup());

describe('TaskDeliveryChips (APW-08 T27)', () => {
    it.each([
        ['merged', copy.chipMerged],
        ['building', copy.chipBuilding],
        ['build_failed', copy.chipBuildFailed],
        ['built', copy.chipBuilt],
        ['deploying', copy.chipDeploying],
        ['live', copy.chipLive],
        ['closed_without_deploy', copy.chipClosed],
    ] as const)('%s reads its spec §6.1 copy', (state, text) => {
        renderChip({ state });
        expect(chipText()).toBe(text);
        expect(screen.getByTestId('task-delivery-chip').getAttribute('data-delivery-state')).toBe(
            state,
        );
    });

    it('pins the English copy of the states, so a renamed key cannot pass silently', () => {
        expect(copy.chipMerged).toBe('Merged ✓ · Waiting for a build');
        expect(copy.chipBuilding).toBe('Build ⟳');
        expect(copy.chipBuildFailed).toBe('Build failed ✗');
        expect(copy.chipBuilt).toBe('Built ✓ · Waiting for a deployment');
        expect(copy.chipDeploying).toBe('Deploying ⟳');
        expect(copy.chipLive).toBe('Live ✓');
        expect(copy.chipClosed).toBe('Closed without deploying');
    });

    it('a failed deployment names its APW-06 outcome, and a rolled-back one is never a plain failure', () => {
        renderChip({ state: 'deploy_failed', outcome: 'rolled_back' });
        expect(chipText()).toBe('Deploy failed ✗ (rolled back)');
        expect(screen.getByTestId('task-delivery-chip').getAttribute('aria-label')).toBe(
            'Deployment failed, rolled back',
        );
        cleanup();

        renderChip({ state: 'deploy_failed', outcome: 'rollback_failed' });
        expect(chipText()).toBe('Deploy failed ✗ (rollback failed)');
        cleanup();

        renderChip({ state: 'deploy_failed', outcome: 'failed' });
        expect(chipText()).toBe('Deploy failed ✗ (failed)');
        cleanup();

        // No outcome known: the plain chip, never "()" with nothing in it.
        renderChip({ state: 'deploy_failed', outcome: null });
        expect(chipText()).toBe(copy.chipDeployFailedPlain);
    });

    it('a live change says when it went live with warnings or through a later change', () => {
        renderChip({ state: 'live', liveWithWarnings: true });
        expect(chipText()).toBe(copy.chipLiveWarnings);
        cleanup();
        renderChip({ state: 'live', carriedByLaterChange: true });
        expect(chipText()).toBe(copy.chipCarried);
    });

    it('a live chip links to the live app, except inside another link and never for a script URL', () => {
        renderChip({ state: 'live', liveUrl: 'https://bookings.example.app' });
        const link = screen.getByTestId('task-delivery-chip');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://bookings.example.app');
        expect(link.getAttribute('rel')).toContain('noopener');
        cleanup();

        renderChip({ state: 'live', liveUrl: 'https://bookings.example.app' }, false);
        expect(screen.getByTestId('task-delivery-chip').tagName).toBe('SPAN');
        cleanup();

        renderChip({ state: 'live', liveUrl: 'javascript:alert(1)' });
        expect(screen.getByTestId('task-delivery-chip').tagName).toBe('SPAN');
    });

    it('renders nothing for an untracked Task or an unknown state', () => {
        const { container } = renderChip(null);
        expect(container.textContent).toBe('');
        cleanup();
        const unknown = renderChip({ state: 'shipped' as never });
        expect(unknown.container.textContent).toBe('');
    });

    it('every delivery state has a chip key that exists in the catalogue', () => {
        for (const state of TASK_DELIVERY_STATES) {
            const key = deliveryChipKey({ state, outcome: 'failed' });
            expect(typeof (copy as Record<string, unknown>)[key]).toBe('string');
        }
    });

    it('is drawn after the gate chip on a board card whose row carries a delivery embed', () => {
        const tasks = [
            {
                id: 'task-a',
                slug: 'T-1',
                title: 'Add an SMS reminder',
                status: 'in_review',
                priority: 'p2',
                labels: null,
                updatedAt: '2026-10-29T10:00:00.000Z',
                branchRef: null,
                prNumber: null,
                run: null,
                delivery: {
                    state: 'deploying',
                    liveUrl: null,
                    outcome: null,
                    liveWithWarnings: false,
                    carriedByLaterChange: false,
                },
            },
            {
                id: 'task-b',
                slug: 'T-2',
                title: 'Untracked',
                status: 'todo',
                priority: 'p3',
                labels: null,
                updatedAt: '2026-10-29T10:00:00.000Z',
                branchRef: null,
                prNumber: null,
                run: null,
            },
        ] as unknown as Task[];
        render(
            <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                <TasksKanbanView tasks={tasks} />
            </NextIntlClientProvider>,
        );
        const cards = screen.getAllByTestId('task-kanban-card');
        const tracked = cards.find((card) => card.getAttribute('data-task-id') === 'task-a')!;
        const untracked = cards.find((card) => card.getAttribute('data-task-id') === 'task-b')!;
        expect(within(tracked).getByTestId('task-delivery-chip').textContent).toBe(
            copy.chipDeploying,
        );
        expect(within(untracked).queryByTestId('task-delivery-chip')).toBeNull();
    });
});
