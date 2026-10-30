import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { TaskCostView, TaskRunContainmentView } from '@ever-works/contracts';
import messages from '../../../messages/en.json';

/**
 * APW-08 T27's additive item / T48 (FR-12, FR-70, S33, ACC-08-34) — `TaskRunContainmentNotice`,
 * through the REAL English catalogue: the containment a Fleet run got, its downgrades, and
 * **Allow on this machine** calling the allowance route (through `allowAppRunContainmentAction`)
 * for the node that holds the next run; then **Withdraw** once allowed. Mounted inside
 * `TaskCostSection`, which re-reads the view after a change.
 */

const { allow, getCost } = vi.hoisted(() => ({ allow: vi.fn(), getCost: vi.fn() }));

vi.mock('@/app/actions/dashboard/app-changes', () => ({
    allowAppRunContainmentAction: allow,
    getWorkCostAction: vi.fn(),
}));
vi.mock('@/app/actions/tasks', () => ({ getTaskCostAction: getCost }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

import { TaskRunContainmentNotice } from './TaskRunContainmentNotice';
import { TaskCostSection } from './TaskCostSection';

const copy = messages.dashboard.tasksPage.cost.containment;
const rules = messages.dashboard.tasksPage.appRules;
const NODE = '11111111-1111-4111-8111-111111111111';

function view(over: Partial<TaskRunContainmentView> = {}): TaskRunContainmentView {
    return {
        executionPath: 'ordinary',
        isolatedHome: false,
        downgrades: [
            { control: 'process-containment', reason: 'ordinary command runner' },
            { control: 'isolated-home', reason: 'modelHomeIsolation=inherit' },
        ],
        needsOwnerAllowance: true,
        runId: 'run-aaaaaaaa-1',
        nodeId: NODE,
        nodeName: 'Maya desktop',
        reportedAt: '2026-10-30T01:00:00.000Z',
        reported: true,
        allowedByOwner: false,
        // The signed-in viewer enrolled the node (review of #3040: only then are there buttons).
        viewerOwnsNode: true,
        ...over,
    };
}

function renderNotice(props: Partial<React.ComponentProps<typeof TaskRunContainmentNotice>> = {}) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <TaskRunContainmentNotice workId="work-1" containment={null} holds={[]} {...props} />
        </NextIntlClientProvider>,
    );
}

afterEach(() => {
    cleanup();
    allow.mockReset();
    getCost.mockReset();
});

describe('TaskRunContainmentNotice (APW-08 T27 / T48)', () => {
    it('renders nothing for a Task with no record and no hold', () => {
        renderNotice();
        expect(screen.queryByTestId('task-run-containment-notice')).toBeNull();
    });

    it('shows the containment the latest Fleet run got and every downgrade, as text (ACC-08-34)', () => {
        renderNotice({ containment: view() });

        const record = screen.getByTestId('task-containment-record');
        expect(record.textContent).toContain('Latest Fleet run on Maya desktop');
        expect(screen.getByTestId('task-containment-path').textContent).toBe(
            `${copy.pathOrdinary} · ${copy.isolatedHomeNotApplied}`,
        );
        const downgrades = screen
            .getAllByTestId('task-containment-downgrade')
            .map((li) => li.textContent);
        expect(downgrades).toEqual([
            'process-containment: ordinary command runner',
            'isolated-home: modelHomeIsolation=inherit',
        ]);
        // FR-13 — the honest statement of what containment does not cover.
        expect(screen.getByTestId('task-containment-real-home').textContent).toBe(copy.realHome);
        // A record alone is not a hold: no allow button.
        expect(screen.queryByTestId('task-containment-allow')).toBeNull();
    });

    it('a hold shows the S33 copy and Allow on this machine, which calls the allowance route for THAT node', async () => {
        const onChanged = vi.fn();
        allow.mockResolvedValue({ success: true, data: null });
        renderNotice({ holds: [view({ runId: null })], onChanged });

        const hold = screen.getByTestId('task-containment-hold');
        expect(within(hold).getByTestId('task-containment-hold-copy').textContent).toBe(
            rules.containmentDowngrade,
        );
        expect(rules.containmentDowngrade).toBe(
            'This machine runs app changes without an isolated home. Allow it once, or run this Task in an isolated sandbox.',
        );
        expect(hold.textContent).toContain(
            "Won't receive this Task's runs until you allow it: Maya desktop",
        );

        const button = within(hold).getByRole('button', { name: rules.allowOnThisMachine });
        fireEvent.click(button);

        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
        expect(allow).toHaveBeenCalledWith('work-1', NODE, true);
    });

    it('a node that never reported says so and can still be allowed once', () => {
        renderNotice({
            holds: [view({ runId: null, reported: false, downgrades: [], nodeName: null })],
        });
        expect(screen.getByTestId('task-containment-not-reported').textContent).toBe(
            copy.notReported,
        );
        expect(screen.getByTestId('task-containment-hold').textContent).toContain(
            `Won't receive this Task's runs until you allow it: ${copy.unknownMachine}`,
        );
        expect(screen.getByTestId('task-containment-allow')).toBeTruthy();
    });

    it('an allowed node shows the accepted downgrade and Withdraw, which withdraws it', async () => {
        allow.mockResolvedValue({ success: true, data: null });
        renderNotice({
            containment: view({
                allowedByOwner: true,
                acceptedDowngrade: 'modelHomeIsolation=inherit',
            }),
        });

        const allowed = screen.getByTestId('task-containment-allowed');
        expect(allowed.textContent).toContain(copy.allowed);
        expect(screen.getByTestId('task-containment-accepted').textContent).toBe(
            'Accepted: modelHomeIsolation=inherit',
        );
        fireEvent.click(within(allowed).getByRole('button', { name: copy.withdraw }));
        await waitFor(() => expect(allow).toHaveBeenCalledWith('work-1', NODE, false));
    });

    it('a failed save is announced in the polite live region and nothing reloads', async () => {
        const onChanged = vi.fn();
        allow.mockResolvedValue({ success: false, code: 'notFound', statusCode: 404 });
        renderNotice({ holds: [view({ runId: null })], onChanged });

        fireEvent.click(screen.getByTestId('task-containment-allow'));
        await waitFor(() =>
            expect(screen.getByTestId('task-containment-status').textContent).toBe(copy.saveFailed),
        );
        expect(screen.getByTestId('task-containment-status').getAttribute('aria-live')).toBe(
            'polite',
        );
        expect(onChanged).not.toHaveBeenCalled();
    });

    it('review of #3040: no Allow / Withdraw on a node the VIEWER does not own (the route would answer 404)', () => {
        renderNotice({
            holds: [view({ runId: null, viewerOwnsNode: false })],
            containment: view({ allowedByOwner: true, viewerOwnsNode: false }),
        });
        expect(screen.getByTestId('task-containment-hold-copy').textContent).toBe(
            rules.containmentDowngrade,
        );
        expect(screen.queryByTestId('task-containment-allow')).toBeNull();
        expect(screen.getByTestId('task-containment-allowed').textContent).toContain(copy.allowed);
        expect(screen.queryByTestId('task-containment-withdraw')).toBeNull();
    });

    it('review of #3040: a hold that names no node (the machines could not be read) is information only', () => {
        renderNotice({
            holds: [view({ runId: null, nodeId: null, nodeName: null, reported: false })],
        });
        expect(screen.getByTestId('task-containment-nodes-unreadable').textContent).toBe(
            copy.nodesUnreadable,
        );
        expect(screen.queryByTestId('task-containment-hold-copy')).toBeNull();
        expect(screen.queryByTestId('task-containment-allow')).toBeNull();
    });

    it('offers no action without a Work to address the route to', () => {
        renderNotice({ workId: null, holds: [view({ runId: null })] });
        expect(screen.queryByTestId('task-containment-allow')).toBeNull();
    });

    it('inside TaskCostSection: Allow on this machine re-reads the Cost view, which then shows the allowance', async () => {
        const base: TaskCostView = {
            taskId: 'task-1',
            runs: [],
            builds: [],
            totalCents: 0,
            currency: 'usd',
            runsLimit: 50,
            runsTruncated: false,
        };
        getCost
            .mockResolvedValueOnce({
                ok: true,
                cost: { ...base, containment: view(), containmentHolds: [view({ runId: null })] },
            })
            .mockResolvedValueOnce({
                ok: true,
                cost: {
                    ...base,
                    containment: view({ allowedByOwner: true }),
                    containmentHolds: [],
                },
            });
        allow.mockResolvedValue({ success: true, data: null });

        render(
            <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                <TaskCostSection taskId="task-1" workId="work-1" />
            </NextIntlClientProvider>,
        );

        fireEvent.click(await screen.findByTestId('task-containment-allow'));
        await waitFor(() => expect(screen.getByTestId('task-containment-allowed')).toBeTruthy());
        expect(allow).toHaveBeenCalledWith('work-1', NODE, true);
        expect(getCost).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('task-containment-hold')).toBeNull();
    });
});
