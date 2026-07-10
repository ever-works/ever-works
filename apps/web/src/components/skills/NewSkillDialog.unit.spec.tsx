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

import { NewSkillDialog } from './NewSkillDialog';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';
import type { Skill } from '@/lib/api/skills';

const T = 'dashboard.skillsPage.newPage';
const createSkill = vi.fn(async () => ({ id: 'skill-1' }) as Skill);

const TEMPLATES: AstTemplateEntry[] = [
    {
        slug: 'cron-defaults',
        title: 'Cron defaults',
        description: 'Conventions for cron expressions.',
        previewMd: '# Cron defaults\n\nUse UTC.',
    },
    { slug: 'secret-handling', title: 'Secret handling', description: 'Treat keys carefully.' },
];

function nextButton(container: HTMLElement): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(`${T}.next`),
    );
    if (!btn) throw new Error('Next button not found');
    return btn as HTMLButtonElement;
}

describe('NewSkillDialog', () => {
    it('Workspace (tenant) happy path: Next is enabled and advances to details', () => {
        const { container } = render(<NewSkillDialog createSkill={createSkill} />);
        // No templates passed → opens on the scope step.
        const next = nextButton(container);
        expect(next.disabled).toBe(false);
        fireEvent.click(next);
        // Details step renders the title input.
        expect(container.querySelector('#new-skill-title')).not.toBeNull();
    });

    it('non-tenant scope with no candidates does NOT dead-end: Next disabled + hint shown', () => {
        const { container } = render(<NewSkillDialog createSkill={createSkill} />);
        // Select the Agent scope (no agents passed → empty catalog).
        const agentBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.toLowerCase().includes('agent'),
        );
        fireEvent.click(agentBtn!);
        const next = nextButton(container);
        expect(next.disabled).toBe(true);
        expect(next.getAttribute('title')).toBe(`${T}.nextDisabledReason`);
        expect(screen.getByText(`${T}.pickParentHint`)).toBeTruthy();
    });

    it('opens on the optional template step when templates are provided', () => {
        const { container } = render(
            <NewSkillDialog createSkill={createSkill} templates={TEMPLATES} />,
        );
        expect(
            container.querySelector('[data-testid="skill-template-step-cron-defaults"]'),
        ).not.toBeNull();
        expect(screen.getByText(`${T}.startFromScratch`)).toBeTruthy();
    });

    it('picking a template prefills title, description, and body, then advances to details', () => {
        const { container } = render(
            <NewSkillDialog createSkill={createSkill} templates={TEMPLATES} />,
        );
        fireEvent.click(
            container.querySelector('[data-testid="skill-template-step-cron-defaults"]')!,
        );
        // Now on scope step (tenant default) → advance.
        fireEvent.click(nextButton(container));
        const titleInput = container.querySelector('#new-skill-title') as HTMLInputElement;
        const body = container.querySelector('#new-skill-instructions') as HTMLTextAreaElement;
        expect(titleInput.value).toBe('Cron defaults');
        expect(body.value).toContain('Use UTC.');
    });

    it('submits a tenant-scoped skill with empty ownerId and routes to the created skill', async () => {
        const { container } = render(<NewSkillDialog createSkill={createSkill} />);
        fireEvent.click(nextButton(container));
        fireEvent.change(container.querySelector('#new-skill-title')!, {
            target: { value: 'Code review checklist' },
        });
        const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
            b.textContent?.includes(`${T}.create`),
        );
        fireEvent.click(createBtn!);
        await vi.waitFor(() => expect(createSkill).toHaveBeenCalled());
        expect(createSkill).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerType: 'tenant',
                ownerId: '',
                title: 'Code review checklist',
            }),
        );
        await vi.waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/skills/skill-1'));
    });
});
