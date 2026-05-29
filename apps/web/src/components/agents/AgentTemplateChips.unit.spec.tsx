import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

import { AgentTemplateChips } from './AgentTemplateChips';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';

const TEMPLATES: AstTemplateEntry[] = [
    { slug: 'ceo', title: 'CEO', description: 'Chief Executive', iconName: 'Crown' },
    { slug: 'cto', title: 'CTO', description: 'Chief Technology Officer', iconName: 'Cpu' },
];

describe('AgentTemplateChips', () => {
    it('renders a `View All` chip first, then a chip per template', () => {
        const { container } = render(<AgentTemplateChips templates={TEMPLATES} onPick={vi.fn()} />);
        const chips = Array.from(
            container.querySelectorAll('button[role="option"]'),
        ) as HTMLButtonElement[];
        // View All + 2 templates.
        expect(chips.length).toBe(3);
        expect(
            container.querySelector('[data-testid="agent-template-chip-__view_all__"]'),
        ).not.toBeNull();
        expect(container.querySelector('[data-testid="agent-template-chip-ceo"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="agent-template-chip-cto"]')).not.toBeNull();
    });

    it('calls onPick with the template when a template chip is clicked (no catalog expand)', () => {
        const onPick = vi.fn();
        const { container } = render(<AgentTemplateChips templates={TEMPLATES} onPick={onPick} />);
        fireEvent.click(container.querySelector('[data-testid="agent-template-chip-cto"]')!);
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick.mock.calls[0][0].slug).toBe('cto');
        // Catalog stays collapsed when picking a chip directly.
        expect(container.querySelector('[data-testid="agent-template-catalog"]')).toBeNull();
    });

    it('toggles the `View All` catalog with both sections', () => {
        const { container } = render(
            <AgentTemplateChips
                templates={TEMPLATES}
                userTemplates={[{ slug: 'mine', title: 'My Agent', description: 'A saved one' }]}
                onPick={vi.fn()}
            />,
        );
        const viewAll = container.querySelector(
            '[data-testid="agent-template-chip-__view_all__"]',
        )!;
        fireEvent.click(viewAll);
        expect(container.querySelector('[data-testid="agent-template-catalog"]')).not.toBeNull();
        // "All templates" + "Your templates" headings (mocked i18n echoes keys).
        expect(screen.getByText('dashboard.agentsPage.catalog.allTemplates')).toBeTruthy();
        expect(screen.getByText('dashboard.agentsPage.catalog.yourTemplates')).toBeTruthy();
        // Re-click collapses (row emits null for the active chip).
        fireEvent.click(viewAll);
        expect(container.querySelector('[data-testid="agent-template-catalog"]')).toBeNull();
    });

    it('picking a card from the catalog calls onPick and collapses the panel', () => {
        const onPick = vi.fn();
        const { container } = render(<AgentTemplateChips templates={TEMPLATES} onPick={onPick} />);
        fireEvent.click(
            container.querySelector('[data-testid="agent-template-chip-__view_all__"]')!,
        );
        fireEvent.click(container.querySelector('[data-testid="agent-template-card-ceo"]')!);
        expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ slug: 'ceo' }));
        expect(container.querySelector('[data-testid="agent-template-catalog"]')).toBeNull();
    });
});
