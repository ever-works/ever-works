import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => ({ get: () => null }),
}));

const routerPushMock = vi.fn();
const routerBackMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: routerPushMock, back: routerBackMock }),
    Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a href={href}>{children}</a>
    ),
}));

vi.mock('@/lib/api/agent-templates', () => ({
    listAstTemplates: vi.fn(async () => []),
}));

import { NewAgentDialog } from './NewAgentDialog';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';

const T = 'dashboard.agentsPage.newDialog';
const createAgent = vi.fn(async () => ({ id: 'agent-1' }));

const TEMPLATES: AstTemplateEntry[] = [
    { slug: 'ceo', title: 'CEO', description: 'Chief Executive' },
    { slug: 'cto', title: 'CTO', description: 'Chief Technology Officer' },
];

function nextButton(container: HTMLElement): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(`${T}.next`),
    );
    if (!btn) throw new Error('Next button not found');
    return btn as HTMLButtonElement;
}

describe('NewAgentDialog — bug fix + template step', () => {
    it('Workspace (tenant) happy path: Next is enabled and advances to details', () => {
        const { container } = render(<NewAgentDialog createAgent={createAgent} />);
        // No templates passed → opens on the scope step.
        const next = nextButton(container);
        expect(next.disabled).toBe(false);
        fireEvent.click(next);
        // Details step renders the name input.
        expect(container.querySelector('input[type="text"]')).not.toBeNull();
    });

    it('non-tenant scope with no candidates does NOT dead-end: Next disabled + hint shown', () => {
        const { container } = render(<NewAgentDialog createAgent={createAgent} />);
        // Select the Mission scope (no missions passed → empty catalog).
        const missionBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.toLowerCase().includes('mission'),
        );
        fireEvent.click(missionBtn!);
        const next = nextButton(container);
        expect(next.disabled).toBe(true);
        expect(next.getAttribute('title')).toBe(`${T}.nextDisabledReason`);
        expect(screen.getByText(`${T}.pickParentHint`)).toBeTruthy();
    });

    it('opens on the optional template step when templates are provided', () => {
        const { container } = render(
            <NewAgentDialog createAgent={createAgent} templates={TEMPLATES} />,
        );
        expect(container.querySelector('[data-testid="agent-template-step-ceo"]')).not.toBeNull();
        expect(screen.getByText(`${T}.startFromScratch`)).toBeTruthy();
    });

    it('picking a template prefills the name and advances through scope to details', () => {
        const { container } = render(
            <NewAgentDialog createAgent={createAgent} templates={TEMPLATES} />,
        );
        fireEvent.click(container.querySelector('[data-testid="agent-template-step-cto"]')!);
        // Now on scope step (tenant default) → advance.
        fireEvent.click(nextButton(container));
        const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
        expect(nameInput.value).toBe('CTO');
    });

    it('pinned scope skips the template step and lands on details', () => {
        const { container } = render(
            <NewAgentDialog
                createAgent={createAgent}
                templates={TEMPLATES}
                pinned={{ scope: 'mission', missionId: 'm1', parentLabel: 'Cats Business' }}
            />,
        );
        // No template cards; the name input is immediately present.
        expect(container.querySelector('[data-testid="agent-template-step-ceo"]')).toBeNull();
        expect(container.querySelector('input[type="text"]')).not.toBeNull();
    });
});
