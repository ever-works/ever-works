import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
    // `Button` re-exports this as its `asChild`-less link variant, so the
    // mock has to cover it even though these tests never navigate.
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/hooks/use-start-from-prompt', () => ({
    useStartFromPrompt: () => vi.fn(),
}));

import { WorksCreateComposer } from './WorksCreateComposer';

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
    const el = container.querySelector('textarea[data-testid="works-quick-add"]');
    if (!el) throw new Error('prompt textarea not found');
    return el as HTMLTextAreaElement;
}

/**
 * Same `usePromptSeed` contract `NewPageClient` asserts, on the `/works`
 * quick-add composer: a chip pick writes that kind's first placeholder
 * example into the box as submittable text, replaces a seed we put there
 * ourselves, and never touches words the user wrote.
 */
describe('WorksCreateComposer chip seeding', () => {
    const DIRECTORY_SEED =
        'Directory of AI coding assistants with reviews, pricing tiers, and editor compatibility';
    const BLOG_SEED =
        'Personal blog about indie game development with postmortems and tooling tags';

    function clickChip(container: HTMLElement, value: string) {
        // `testIdPrefix="works-quick-add"` on this surface's PromptChipsRow.
        const chip = container.querySelector(`button[data-testid="works-quick-add-${value}"]`);
        if (!chip) throw new Error(`chip ${value} not found`);
        fireEvent.click(chip);
    }

    it('writes the picked chip’s example into the input', () => {
        const { container } = render(<WorksCreateComposer />);
        expect(getTextarea(container).value).toBe('');

        clickChip(container, 'directory');

        // The `e.g. "…"` wrapper is stripped — what lands in the box is a
        // prompt the user can send as-is.
        expect(getTextarea(container).value).toBe(DIRECTORY_SEED);
    });

    it('replaces its own seed when the user switches chips', () => {
        const { container } = render(<WorksCreateComposer />);
        clickChip(container, 'directory');
        clickChip(container, 'blog');
        expect(getTextarea(container).value).toBe(BLOG_SEED);
    });

    it('stops replacing a seed once the user has edited it', () => {
        // Editing the seed makes it the user's own words — the next chip pick
        // has to leave it alone even though we put the first draft there.
        const { container } = render(<WorksCreateComposer />);
        clickChip(container, 'directory');

        const edited = `${DIRECTORY_SEED}, self-hosted only`;
        fireEvent.change(getTextarea(container), { target: { value: edited } });

        clickChip(container, 'blog');

        expect(getTextarea(container).value).toBe(edited);
    });

    it('never overwrites text the user typed', () => {
        const { container } = render(<WorksCreateComposer />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'My own brief, in my own words' },
        });

        clickChip(container, 'directory');

        expect(getTextarea(container).value).toBe('My own brief, in my own words');
    });
});
