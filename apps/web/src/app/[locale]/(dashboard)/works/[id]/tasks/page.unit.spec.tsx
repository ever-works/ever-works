import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * APW-08 T27 (lane L5, plan §5.1) — the Work Tasks tab is the App Work view, so an App Work's
 * header carries **Request a change** (the existing `RequestChangeDialog`) beside the Delivery
 * filter; every other Work kind is unchanged.
 */

const { list, getWork, getRunsSummary } = vi.hoisted(() => ({
    list: vi.fn(),
    getWork: vi.fn(),
    getRunsSummary: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/api/tasks', () => ({ tasksAPI: { list } }));
vi.mock('@/lib/api', () => ({ workAPI: { get: getWork, getRunsSummary } }));
vi.mock('@/components/tasks/TasksScopedSection', () => ({
    TasksScopedSection: () => <div data-testid="tasks-scoped-section" />,
}));
vi.mock('@/components/tasks/TasksFilterSelects', () => ({
    TasksFilterSelects: () => <div data-testid="tasks-filter-selects" />,
}));
vi.mock('@/components/works/app/RequestChangeDialog', () => ({
    RequestChangeDialog: ({ workId }: { workId: string }) => (
        <button type="button" data-testid="app-change-open" data-work-id={workId}>
            Request a change
        </button>
    ),
}));

import WorkTasksTabPage from './page';

async function renderPage(kind: string) {
    getWork.mockResolvedValue({ work: { id: 'work-1', kind } });
    const element = await WorkTasksTabPage({
        params: Promise.resolve({ id: 'work-1' }),
        searchParams: Promise.resolve({}),
    });
    return render(element);
}

beforeEach(() => {
    list.mockReset();
    getWork.mockReset();
    getRunsSummary.mockReset();
    list.mockResolvedValue({ data: [] });
    getRunsSummary.mockResolvedValue(null);
});

afterEach(cleanup);

describe('Work Tasks tab — header (APW-08 T27)', () => {
    it('an App Work gets Request a change for THIS Work, beside the Delivery filter', async () => {
        await renderPage('app');
        const header = screen.getByTestId('work-tasks-app-header');
        expect(header.contains(screen.getByTestId('work-tasks-delivery-filter'))).toBe(true);
        const button = screen.getByTestId('app-change-open');
        expect(header.contains(button)).toBe(true);
        expect(button.getAttribute('data-work-id')).toBe('work-1');
    });

    it('any other Work kind gets neither', async () => {
        await renderPage('directory');
        expect(screen.queryByTestId('app-change-open')).toBeNull();
        expect(screen.queryByTestId('work-tasks-delivery-filter')).toBeNull();
        expect(screen.getByTestId('tasks-scoped-section')).toBeTruthy();
    });

    it('a Work read that fails withholds the header, never the list', async () => {
        getWork.mockRejectedValue(new Error('down'));
        const element = await WorkTasksTabPage({
            params: Promise.resolve({ id: 'work-1' }),
            searchParams: Promise.resolve({}),
        });
        render(element);
        expect(screen.queryByTestId('app-change-open')).toBeNull();
        expect(screen.getByTestId('tasks-scoped-section')).toBeTruthy();
    });
});
