import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskPrPill, describeChecks, safePrUrl } from './TaskPrPill';
import type { Task } from '@/lib/api/tasks';

/**
 * PR insights (kanban run cockpit M5) — the review pill and its CI dot.
 *
 * Three things are pinned here:
 *
 *  1. the dot's colour tracks `ciState` across all four states — the
 *     whole point of the milestone is that a red check is visible from
 *     the board without opening anything;
 *  2. the pill renders at all only for a Task with a PR;
 *  3. the link is HOST-VALIDATED (plan 04 §7.3): a non-https URL, or one
 *     carrying userinfo, degrades to inert text rather than becoming a
 *     clickable board element.
 */

const baseTask = {
    id: 't1',
    slug: 't-1',
    title: 'Do the thing',
    prNumber: 241,
    prUrl: 'https://provider.invalid/acme/widgets/pull/241',
    prState: 'open',
    ciState: 'passing',
    prChecks: null,
} as unknown as Task;

const make = (overrides: Partial<Task> = {}) => ({ ...baseTask, ...overrides }) as Task;

describe('TaskPrPill', () => {
    it('renders nothing for a Task with no pull request', () => {
        const { container } = render(<TaskPrPill task={make({ prNumber: null })} />);
        expect(container.firstChild).toBeNull();
    });

    it('shows the PR number', () => {
        render(<TaskPrPill task={make()} />);
        expect(screen.getByTestId('task-pr-pill').textContent).toContain('#241');
    });

    it('renders a green dot for passing checks', () => {
        render(<TaskPrPill task={make({ ciState: 'passing' })} />);
        const dot = screen.getByTestId('task-pr-pill-ci-dot');
        expect(dot.getAttribute('data-ci-state')).toBe('passing');
        expect(dot.className).toContain('bg-emerald-500');
    });

    it('renders a red dot for failing checks', () => {
        render(<TaskPrPill task={make({ ciState: 'failing' })} />);
        const dot = screen.getByTestId('task-pr-pill-ci-dot');
        expect(dot.getAttribute('data-ci-state')).toBe('failing');
        expect(dot.className).toContain('bg-red-500');
    });

    it('renders a pulsing amber dot while checks are still running', () => {
        render(<TaskPrPill task={make({ ciState: 'pending' })} />);
        const dot = screen.getByTestId('task-pr-pill-ci-dot');
        expect(dot.className).toContain('bg-amber-500');
        expect(dot.className).toContain('animate-pulse');
    });

    it('falls back to a gray unknown dot when no CI has reported', () => {
        render(<TaskPrPill task={make({ ciState: null })} />);
        const dot = screen.getByTestId('task-pr-pill-ci-dot');
        expect(dot.getAttribute('data-ci-state')).toBe('unknown');
        expect(dot.className).toContain('bg-slate-400');
    });

    it('marks a draft PR distinctly from an open one', () => {
        render(<TaskPrPill task={make({ prState: 'draft' })} />);
        const pill = screen.getByTestId('task-pr-pill');
        expect(pill.getAttribute('data-pr-state')).toBe('draft');
        expect(pill.textContent).toContain('draft');
    });

    it('marks a merged PR', () => {
        render(<TaskPrPill task={make({ prState: 'merged' })} />);
        expect(screen.getByTestId('task-pr-pill').textContent).toContain('merged');
    });

    it('links out with noopener/noreferrer for a valid https URL', () => {
        render(<TaskPrPill task={make()} />);
        const pill = screen.getByTestId('task-pr-pill');
        expect(pill.tagName).toBe('A');
        expect(pill.getAttribute('rel')).toBe('noopener noreferrer');
        expect(pill.getAttribute('target')).toBe('_blank');
    });

    it('renders inert text (not a link) for a non-https PR URL', () => {
        render(<TaskPrPill task={make({ prUrl: 'javascript:alert(1)' })} />);
        expect(screen.getByTestId('task-pr-pill').tagName).toBe('SPAN');
    });

    it('renders inert text when the PR URL carries embedded credentials', () => {
        render(<TaskPrPill task={make({ prUrl: 'https://user:pw@evil.invalid/pull/1' })} />);
        expect(screen.getByTestId('task-pr-pill').tagName).toBe('SPAN');
    });

    it('names failing checks in the tooltip as plain text', () => {
        render(
            <TaskPrPill
                task={make({
                    ciState: 'failing',
                    prChecks: [
                        { name: 'build', status: 'completed', conclusion: 'success' },
                        { name: 'e2e <img>', status: 'completed', conclusion: 'failure' },
                    ],
                })}
            />,
        );
        const pill = screen.getByTestId('task-pr-pill');
        expect(pill.getAttribute('title')).toContain('Failing: e2e <img>');
        // Provider-authored text never becomes markup on the board.
        expect(pill.querySelector('img')).toBeNull();
    });
});

describe('safePrUrl', () => {
    it('accepts a plain https URL', () => {
        expect(safePrUrl('https://provider.invalid/x/y/pull/1')).toContain('provider.invalid');
    });

    it('rejects http, javascript, data and relative URLs', () => {
        expect(safePrUrl('http://provider.invalid/pull/1')).toBeNull();
        expect(safePrUrl('javascript:alert(1)')).toBeNull();
        expect(safePrUrl('data:text/html,<script>')).toBeNull();
        expect(safePrUrl('/pull/1')).toBeNull();
    });

    it('rejects empty and nullish input without throwing', () => {
        expect(safePrUrl(null)).toBeNull();
        expect(safePrUrl(undefined)).toBeNull();
        expect(safePrUrl('')).toBeNull();
    });
});

describe('describeChecks', () => {
    it('describes the rollup when no per-check detail is cached', () => {
        expect(describeChecks({ ciState: 'pending', prChecks: null })).toBe('checks running');
    });

    it('counts the checks when they all passed', () => {
        expect(
            describeChecks({
                ciState: 'passing',
                prChecks: [{ name: 'build', status: 'completed', conclusion: 'success' }],
            }),
        ).toBe('checks passing (1)');
    });

    it('names timed-out checks as failures too', () => {
        expect(
            describeChecks({
                ciState: 'failing',
                prChecks: [{ name: 'slow', status: 'completed', conclusion: 'timed_out' }],
            }),
        ).toBe('Failing: slow');
    });
});
