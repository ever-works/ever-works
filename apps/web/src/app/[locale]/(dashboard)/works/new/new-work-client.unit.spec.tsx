import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
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

// The entry view (creationMode === null) never renders these, but they are
// module-scope imports that drag in the API/data layer. Stub them so the spec
// stays scoped to the composer.
vi.mock('@/components/works/WorkAICreator', () => ({
    WorkAICreator: () => null,
}));
vi.mock('@/components/works/WorkImportForm', () => ({
    WorkImportForm: () => null,
}));
// The Repository form IS reached from the entry view (the Repository chip
// routes in-page), so stub it as a probe that exposes the seeded URL.
vi.mock('@/components/works/RepositoryWorkForm', () => ({
    RepositoryWorkForm: ({ initialRepositoryUrl }: { initialRepositoryUrl?: string }) => (
        <div data-testid="repository-work-form" data-url={initialRepositoryUrl ?? ''} />
    ),
}));
vi.mock('./git-provider-selector', () => ({
    GitProviderSelector: () => null,
}));
vi.mock('./deploy-provider-selector', () => ({
    DeployProviderSelector: () => null,
}));

import NewWorkClient from './new-work-client';

type NewWorkClientProps = React.ComponentProps<typeof NewWorkClient>;

const BASE_PROPS: NewWorkClientProps = {
    user: { id: 'u-1', email: 'u@example.dev' } as NewWorkClientProps['user'],
    providers: [],
    defaultProviderId: null,
    deployProviders: [],
    defaultDeployProviderId: null,
    websiteTemplates: [],
};

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
    const el = container.querySelector('textarea[data-testid="new-work-prompt"]');
    if (!el) throw new Error('prompt textarea not found');
    return el as HTMLTextAreaElement;
}

/**
 * Same `usePromptSeed` contract `NewPageClient` asserts, on the `/works/new`
 * entry view: a chip pick writes that kind's first placeholder example into
 * the box as submittable text, replaces a seed we put there ourselves, and
 * never touches words the user wrote.
 */
describe('NewWorkClient chip seeding', () => {
    const DIRECTORY_SEED =
        'Directory of AI coding assistants with reviews, pricing tiers, and editor compatibility';
    const BLOG_SEED =
        'Personal blog about indie game development with postmortems and tooling tags';

    function clickChip(container: HTMLElement, value: string) {
        // `testIdPrefix="new-work-kind"` on this surface's PromptChipsRow.
        const chip = container.querySelector(`button[data-testid="new-work-kind-${value}"]`);
        if (!chip) throw new Error(`chip ${value} not found`);
        fireEvent.click(chip);
    }

    it('writes the picked chip’s example into the input', () => {
        const { container } = render(<NewWorkClient {...BASE_PROPS} />);
        expect(getTextarea(container).value).toBe('');

        clickChip(container, 'directory');

        // The `e.g. "…"` wrapper is stripped — what lands in the box is a
        // prompt the user can send as-is.
        expect(getTextarea(container).value).toBe(DIRECTORY_SEED);
    });

    it('replaces its own seed when the user switches chips', () => {
        const { container } = render(<NewWorkClient {...BASE_PROPS} />);
        clickChip(container, 'directory');
        clickChip(container, 'blog');
        expect(getTextarea(container).value).toBe(BLOG_SEED);
    });

    it('stops replacing a seed once the user has edited it', () => {
        // Editing the seed makes it the user's own words — the next chip pick
        // has to leave it alone even though we put the first draft there.
        const { container } = render(<NewWorkClient {...BASE_PROPS} />);
        clickChip(container, 'directory');

        const edited = `${DIRECTORY_SEED}, self-hosted only`;
        fireEvent.change(getTextarea(container), { target: { value: edited } });

        clickChip(container, 'blog');

        expect(getTextarea(container).value).toBe(edited);
    });

    it('never overwrites text the user typed', () => {
        const { container } = render(<NewWorkClient {...BASE_PROPS} />);
        fireEvent.change(getTextarea(container), {
            target: { value: 'My own brief, in my own words' },
        });

        clickChip(container, 'directory');

        expect(getTextarea(container).value).toBe('My own brief, in my own words');
    });

    it('never overwrites an `initialPrompt` handed over from the URL', () => {
        // `?prompt=` prefill is the user's own words carried across a
        // navigation — a chip pick must leave it alone.
        const { container } = render(
            <NewWorkClient {...BASE_PROPS} initialPrompt="Prompt carried over from /new" />,
        );

        clickChip(container, 'directory');

        expect(getTextarea(container).value).toBe('Prompt carried over from /new');
    });

    it('does not seed from an inert “Soon” chip (store / company are not clickable)', () => {
        const { container } = render(<NewWorkClient {...BASE_PROPS} disabledKinds={['store']} />);

        for (const value of ['store', 'company']) {
            // Rendered as the inert span, so there is no click handler that
            // could seed — and no chip whose example the seed could come from.
            expect(
                container.querySelector(`button[data-testid="new-work-kind-${value}"]`),
            ).toBeNull();
            const soon = container.querySelector(`span[data-testid="new-work-kind-${value}"]`);
            expect(soon).not.toBeNull();
            expect(soon?.getAttribute('aria-disabled')).toBe('true');
        }
        expect(getTextarea(container).value).toBe('');
    });
});

describe('NewWorkClient Repository chip routing', () => {
    function getSubmit(container: HTMLElement): HTMLButtonElement {
        const el = container.querySelector('button[data-testid="new-work-prompt-submit"]');
        if (!el) throw new Error('submit button not found');
        return el as HTMLButtonElement;
    }

    function clickChip(container: HTMLElement, value: string) {
        const chip = container.querySelector(`button[data-testid="new-work-kind-${value}"]`);
        if (!chip) throw new Error(`chip ${value} not found`);
        fireEvent.click(chip);
    }

    it('renders the Repository form in-page, seeded with the text, and opens NO chat turn', async () => {
        // Self-build slice D (EW-766): on /works/new the Repository chip
        // switches to the manual form right here instead of navigating —
        // the composer text (a repo URL) becomes the form's URL seed.
        startFromPromptMock.mockClear();
        const { container } = render(<NewWorkClient {...BASE_PROPS} />);
        clickChip(container, 'repo');
        fireEvent.change(getTextarea(container), {
            target: { value: 'https://github.com/ever-works/ever-works' },
        });
        fireEvent.click(getSubmit(container));

        await waitFor(() =>
            expect(container.querySelector('[data-testid="repository-work-form"]')).not.toBeNull(),
        );
        expect(
            container
                .querySelector('[data-testid="repository-work-form"]')
                ?.getAttribute('data-url'),
        ).toBe('https://github.com/ever-works/ever-works');
        expect(startFromPromptMock).not.toHaveBeenCalled();
        // The entry-view composer is gone — the form replaced it.
        expect(container.querySelector('textarea[data-testid="new-work-prompt"]')).toBeNull();
    });

    it('a `?mode=manual&kind=repo&prompt=…` arrival (from /new or the Works composer) lands on the seeded form directly', () => {
        const { container } = render(
            <NewWorkClient
                {...BASE_PROPS}
                initialMode="manual"
                initialKind="repo"
                initialPrompt="https://github.com/ever-works/directory-web-template"
            />,
        );

        const form = container.querySelector('[data-testid="repository-work-form"]');
        expect(form).not.toBeNull();
        expect(form?.getAttribute('data-url')).toBe(
            'https://github.com/ever-works/directory-web-template',
        );
        expect(startFromPromptMock).not.toHaveBeenCalled();
    });
});
