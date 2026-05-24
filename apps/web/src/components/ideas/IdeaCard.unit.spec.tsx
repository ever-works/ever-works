import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const routerPushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: routerPushMock }),
}));

const dismissProposalMock = vi.fn();
vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    dismissProposalAction: (...args: unknown[]) => dismissProposalMock(...args),
}));

import { IdeaCard } from './IdeaCard';
import type { WorkProposal } from '@/lib/api/work-proposals';

/**
 * Phase 5 PR M — IdeaCard is the extracted (renamed) form of the
 * old WorkProposalCard. Goal of this spec: lock the render output
 * so the relocation is byte-identical (Decision A10), plus cover
 * the two action paths (Accept / Dismiss) so a later styling pass
 * doesn't accidentally swap the click handlers.
 *
 * The thin shim at `dashboard/WorkProposalCard.tsx` is covered by
 * the same render — it just re-exports IdeaCard under the old
 * name, so an import-rename refactor against either file picks
 * the new canonical implementation.
 */
const minimalProposal: WorkProposal = {
    id: 'prop-1',
    userId: 'u1',
    title: 'Top AI coding assistants',
    description: 'A curated list of the leading AI-powered coding tools used by professional developers in 2026.',
    slugSuggestion: 'top-ai-coding-assistants',
    suggestedCategories: [
        { name: 'AI', slug: 'ai' },
        { name: 'Developer Tools', slug: 'developer-tools' },
    ],
    suggestedFields: [],
    recommendedPlugins: [{ pluginId: 'openrouter', reason: 'AI gateway' }],
    generatedPrompt: 'p',
    reasoning: 'Picks adjacent to the user accepting Claude Code',
    source: 'auto-signup',
    status: 'pending',
    generatedAt: '2026-05-24T00:00:00Z',
} as unknown as WorkProposal;

describe('IdeaCard (Phase 5 PR M)', () => {
    it('renders the title, description, categories, plugin row, reasoning, and Build CTA', () => {
        const { container } = render(<IdeaCard proposal={minimalProposal} />);
        // Title + description rendered.
        expect(screen.getByText('Top AI coding assistants')).toBeTruthy();
        expect(
            screen.getByText(/leading AI-powered coding tools/i),
        ).toBeTruthy();
        // Both categories rendered as pills.
        expect(screen.getByText('AI')).toBeTruthy();
        expect(screen.getByText('Developer Tools')).toBeTruthy();
        // Plugin row.
        expect(container.textContent).toContain('plugins.label');
        expect(container.textContent).toContain('openrouter');
        // Reasoning rendered in quotes.
        expect(container.textContent).toContain('Picks adjacent to the user accepting Claude Code');
        // Build CTA (i18n key short-circuit via the mock).
        expect(screen.getByText('actions.accept')).toBeTruthy();
    });

    it('hides the categories row when there are no suggested categories', () => {
        const { container } = render(
            <IdeaCard proposal={{ ...minimalProposal, suggestedCategories: [] }} />,
        );
        // Pills wrapper is the only `.flex-wrap` element above the desc; it
        // shouldn't exist in this branch. Assert via .gap-1.5 .flex-wrap selector.
        expect(container.querySelector('.flex.flex-wrap.gap-1\\.5')).toBeNull();
    });

    it('hides the plugin row when recommendedPlugins is empty', () => {
        const { container } = render(
            <IdeaCard proposal={{ ...minimalProposal, recommendedPlugins: [] }} />,
        );
        expect(container.textContent).not.toContain('plugins.label');
    });

    it('hides the reasoning paragraph when reasoning is empty', () => {
        const { container } = render(
            <IdeaCard proposal={{ ...minimalProposal, reasoning: '' }} />,
        );
        expect(container.textContent).not.toMatch(/Picks adjacent/);
        // Only the title/description italicized text might remain — the
        // reasoning <p> uses italic. Nothing else does.
        expect(container.querySelector('p.italic')).toBeNull();
    });

    it('clips suggestedCategories to 4 and recommendedPlugins to 3', () => {
        const overflowing: WorkProposal = {
            ...minimalProposal,
            suggestedCategories: [
                { name: 'C1', slug: 'c1' },
                { name: 'C2', slug: 'c2' },
                { name: 'C3', slug: 'c3' },
                { name: 'C4', slug: 'c4' },
                { name: 'C5', slug: 'c5' },
                { name: 'C6', slug: 'c6' },
            ],
            recommendedPlugins: [
                { pluginId: 'p1', reason: 'r1' },
                { pluginId: 'p2', reason: 'r2' },
                { pluginId: 'p3', reason: 'r3' },
                { pluginId: 'p4', reason: 'r4' },
            ],
        };
        const { container } = render(<IdeaCard proposal={overflowing} />);
        // First 4 categories visible; 5th + 6th absent.
        for (const name of ['C1', 'C2', 'C3', 'C4']) {
            expect(screen.getByText(name)).toBeTruthy();
        }
        expect(screen.queryByText('C5')).toBeNull();
        expect(screen.queryByText('C6')).toBeNull();
        // Plugin list shows first 3 joined by ", ".
        expect(container.textContent).toContain('p1, p2, p3');
        expect(container.textContent).not.toContain('p4');
    });

    it('navigates to /works/new?proposal=<id> on Build click', () => {
        routerPushMock.mockClear();
        render(<IdeaCard proposal={minimalProposal} />);
        fireEvent.click(screen.getByText('actions.accept'));
        expect(routerPushMock).toHaveBeenCalledWith('/works/new?proposal=prop-1');
    });

    it('calls dismissProposalAction + onDismissed when the X is clicked', async () => {
        dismissProposalMock.mockClear();
        dismissProposalMock.mockResolvedValueOnce(undefined);
        const onDismissed = vi.fn();
        render(<IdeaCard proposal={minimalProposal} onDismissed={onDismissed} />);
        const dismissBtn = screen.getByLabelText('actions.dismissAria');
        fireEvent.click(dismissBtn);
        // Wait for the transition's microtask + the awaited promise to flush.
        await Promise.resolve();
        await Promise.resolve();
        expect(dismissProposalMock).toHaveBeenCalledWith('prop-1');
        expect(onDismissed).toHaveBeenCalledWith('prop-1');
    });

    it('does NOT call onDismissed when dismissProposalAction throws', async () => {
        dismissProposalMock.mockClear();
        dismissProposalMock.mockRejectedValueOnce(new Error('boom'));
        const onDismissed = vi.fn();
        render(<IdeaCard proposal={minimalProposal} onDismissed={onDismissed} />);
        fireEvent.click(screen.getByLabelText('actions.dismissAria'));
        await Promise.resolve();
        await Promise.resolve();
        expect(onDismissed).not.toHaveBeenCalled();
    });

    it('locks the rendered markup so the extraction is byte-identical (Decision A10)', () => {
        const { container } = render(
            <IdeaCard
                proposal={{
                    ...minimalProposal,
                    suggestedCategories: [{ name: 'AI', slug: 'ai' }],
                    recommendedPlugins: [{ pluginId: 'openrouter', reason: 'AI gateway' }],
                }}
            />,
        );
        // Single inline snapshot to lock the whole card shell. If a
        // future styling pass shifts a class or reorders a node this
        // diff is what surfaces it in code review.
        expect(container.firstChild).toMatchInlineSnapshot(`
          <div
            class="group relative flex min-h-[17rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 hover:border-primary-500/50 dark:hover:border-white/20 transition-colors"
          >
            <button
              aria-label="actions.dismissAria"
              class="absolute top-3 right-3 z-10 p-1 rounded-md text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-surface dark:hover:bg-surface-dark transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
              type="button"
            >
              <svg
                aria-hidden="true"
                class="lucide lucide-x w-4 h-4"
                fill="none"
                height="24"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M18 6 6 18"
                />
                <path
                  d="m6 6 12 12"
                />
              </svg>
            </button>
            <div
              class="flex items-center gap-3 mb-3 pr-6 min-w-0"
            >
              <div
                class="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-gray-100 dark:bg-white/5"
              >
                <svg
                  aria-hidden="true"
                  class="lucide lucide-sparkles w-4 h-4 text-primary dark:text-gray-300"
                  fill="none"
                  height="24"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.4"
                  viewBox="0 0 24 24"
                  width="24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
                  />
                  <path
                    d="M20 2v4"
                  />
                  <path
                    d="M22 4h-4"
                  />
                  <circle
                    cx="4"
                    cy="20"
                    r="2"
                  />
                </svg>
              </div>
              <div
                class="min-h-[2lh] flex items-center min-w-0"
              >
                <h3
                  class="text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2"
                >
                  Top AI coding assistants
                </h3>
              </div>
            </div>
            <p
              class="text-xs leading-4.5 text-text-secondary dark:text-text-secondary-dark line-clamp-3 min-h-[3lh] mb-3"
            >
              A curated list of the leading AI-powered coding tools used by professional developers in 2026.
            </p>
            <div
              class="flex flex-wrap gap-1.5 mb-3"
            >
              <span
                class="inline-flex items-center rounded-full bg-primary-400/10 dark:bg-white/10 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-200"
              >
                AI
              </span>
            </div>
            <div
              class="mb-3 text-xs text-text-muted dark:text-text-muted-dark"
            >
              plugins.label
              :
               
              <span
                class="text-text dark:text-text-dark font-medium"
              >
                openrouter
              </span>
            </div>
            <p
              class="text-xs italic text-text-secondary dark:text-text-secondary-dark line-clamp-2 mb-4"
            >
              "
              Picks adjacent to the user accepting Claude Code
              "
            </p>
            <button
              class="mt-auto inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover transition-colors active:scale-[0.98]"
              type="button"
            >
              actions.accept
              <svg
                aria-hidden="true"
                class="lucide lucide-chevron-right w-4 h-4"
                fill="none"
                height="24"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="m9 18 6-6-6-6"
                />
              </svg>
            </button>
          </div>
        `);
    });
});
