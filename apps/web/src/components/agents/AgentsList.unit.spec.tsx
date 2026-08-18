import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentsList } from './AgentsList';

/**
 * Navigation consolidation (`docs/specs/features/navigation-consolidation`
 * §3.5): the Agents tab is the only door to the Agents Chart, so the header
 * CTA that opens it is a contract — `flow-agents-ui-journey.spec.ts` asserts
 * the same test id and href end-to-end.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/lib/hooks/use-start-from-prompt', () => ({
    useStartFromPrompt: () => vi.fn(),
}));

// The composer owns a textarea, attachment uploads and a placeholder
// animation loop — none of it is under test here.
vi.mock('@/components/common/PromptComposer', () => ({
    PromptComposer: ({ testId }: { testId?: string }) => <div data-testid={testId} />,
    buildAttachmentRefs: () => [],
}));

vi.mock('./AgentTemplateChips', () => ({
    AgentTemplateChips: () => <div data-testid="agent-template-chips" />,
}));

vi.mock('./AgentCard', () => ({
    AgentCard: () => <div data-testid="agent-card" />,
}));

describe('AgentsList — header actions', () => {
    it('renders the Agents Chart CTA pointing at /agents/chart', () => {
        render(<AgentsList agents={[]} />);

        const link = screen.getByTestId('agents-chart-link');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('/agents/chart');
        expect(link.textContent).toContain('agentsChartCta');
    });

    it('keeps the chart CTA in the page header, beside the title', () => {
        const { container } = render(<AgentsList agents={[]} />);

        const heading = container.querySelector('h1');
        expect(heading).not.toBeNull();
        // The CTA lives in the PageHeader's actions slot — same header row as
        // the page title, not floated somewhere down the catalog.
        const headerRow = screen.getByTestId('agents-chart-link').closest('div.justify-between');
        expect(headerRow?.querySelector('h1')).toBe(heading);
    });
});
