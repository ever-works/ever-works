import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

const routerPushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: routerPushMock }),
    // `Button` re-exports this as its `asChild`-less link variant, so the
    // mock has to cover it even though most of these tests never navigate.
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

const startFromPromptMock = vi.fn();
vi.mock('@/lib/hooks/use-start-from-prompt', () => ({
    useStartFromPrompt: () => startFromPromptMock,
}));

import { WorksCreateComposer } from './WorksCreateComposer';

function getSubmit(container: HTMLElement): HTMLButtonElement {
    const el = container.querySelector('button[data-testid="works-quick-add-submit"]');
    if (!el) throw new Error('submit button not found');
    return el as HTMLButtonElement;
}

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

describe('WorksCreateComposer Repository chip routing', () => {
    function clickChip(container: HTMLElement, value: string) {
        const chip = container.querySelector(`button[data-testid="works-quick-add-${value}"]`);
        if (!chip) throw new Error(`chip ${value} not found`);
        fireEvent.click(chip);
    }

    it('hands the text to the Repository form (mode=manual&kind=repo&prompt=…) and opens NO chat turn', async () => {
        // Self-build slice D (EW-766): a Repository Work has nothing for the
        // chat AI to generate — the composer text (a repo URL, typically)
        // goes straight to the form on /works/new.
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<WorksCreateComposer />);
        clickChip(container, 'repo');
        fireEvent.change(getTextarea(container), {
            target: { value: 'https://github.com/ever-works/ever-works' },
        });
        fireEvent.click(getSubmit(container));

        await waitFor(() => expect(routerPushMock).toHaveBeenCalledTimes(1));
        expect(startFromPromptMock).not.toHaveBeenCalled();
        const href = routerPushMock.mock.calls[0][0] as string;
        expect(href.startsWith('/works/new?')).toBe(true);
        const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
        expect(params.get('mode')).toBe('manual');
        expect(params.get('kind')).toBe('repo');
        expect(params.get('prompt')).toBe('https://github.com/ever-works/ever-works');
    });

    it('every other chip still opens a chat turn and routes to the AI form without the prompt in the URL', async () => {
        startFromPromptMock.mockClear();
        routerPushMock.mockClear();
        const { container } = render(<WorksCreateComposer />);
        clickChip(container, 'blog');
        fireEvent.change(getTextarea(container), {
            target: { value: 'Personal blog about indie game development' },
        });
        fireEvent.click(getSubmit(container));

        await waitFor(() => expect(routerPushMock).toHaveBeenCalledTimes(1));
        expect(startFromPromptMock).toHaveBeenCalledTimes(1);
        const href = routerPushMock.mock.calls[0][0] as string;
        expect(href).toContain('mode=ai');
        expect(href).toContain('kind=blog');
        expect(href).not.toContain('prompt=');
    });
});
