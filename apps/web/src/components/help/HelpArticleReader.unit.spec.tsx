import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HelpArticleBody } from '@ever-works/contracts/api';

const intl = vi.hoisted(() => ({ locale: 'en' }));
// Stands in for the workspace-aware Link: inside an Organization it puts the
// `/org/<slug>` prefix on the address, which a bare anchor would not get.
const workspace = vi.hoisted(() => ({ prefix: '' }));
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
    useLocale: () => intl.locale,
    useFormatter: () => ({ dateTime: () => '14 Sept 2026' }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={`${workspace.prefix}${href}`} {...rest}>
            {children}
        </a>
    ),
}));

import { HelpArticleReader } from './HelpArticleReader';
import { getHelpArticle } from '@/lib/help/help-target';

const missions = getHelpArticle('missions')!;
const heading = missions.headings.find((h) => h.level === 2)!;

function bodyFor(id: string, headingIds: string[]): HelpArticleBody {
    return {
        version: 1,
        id,
        blocks: headingIds.flatMap((headingId) => [
            {
                kind: 'heading' as const,
                level: 2 as const,
                id: headingId,
                content: [{ type: 'text' as const, text: headingId }],
            },
            {
                kind: 'paragraph' as const,
                content: [{ type: 'text' as const, text: `About ${headingId}` }],
            },
        ]),
    };
}

beforeEach(() => {
    intl.locale = 'en';
    workspace.prefix = '';
    Element.prototype.scrollIntoView = vi.fn();
});

describe('HelpArticleReader', () => {
    it('renders section, title, reviewed date, On this page, body, Open screen and related', async () => {
        const loadBody = vi.fn(async () =>
            bodyFor(
                'missions',
                missions.headings.map((h) => h.id),
            ),
        );
        render(
            <HelpArticleReader
                article={missions}
                headingId={null}
                mode="panel"
                onOpenArticle={vi.fn()}
                loadBody={loadBody}
            />,
        );
        expect(screen.getByText('sections.runningTheLoop')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: missions.title })).toBeInTheDocument();
        expect(screen.getByText(/reviewedOn/)).toHaveTextContent('14 Sept 2026');
        expect(screen.getByRole('navigation', { name: 'onThisPage' })).toBeInTheDocument();
        expect(await screen.findByText(`About ${heading.id}`)).toBeInTheDocument();
        expect(screen.getByTestId('help-open-screen')).toHaveAttribute('href', '/missions');
        expect(screen.getByTestId('help-open-screen').textContent).toContain(missions.label);
        expect(document.querySelectorAll('[data-help-related]').length).toBe(
            missions.related.length,
        );
        expect(screen.queryByTestId('help-english-only')).toBeNull();
        expect(loadBody).toHaveBeenCalledWith('missions');
    });

    it('opens at the named heading once the body is on screen', async () => {
        const loadBody = vi.fn(async () => bodyFor('missions', [heading.id]));
        render(
            <HelpArticleReader
                article={missions}
                headingId={heading.id}
                mode="panel"
                onOpenArticle={vi.fn()}
                loadBody={loadBody}
            />,
        );
        const target = await screen.findByText(heading.id, { selector: 'h3' });
        await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled());
        expect(target.id).toBe(`help-drawer-${heading.id}`);
        expect(screen.queryByTestId('help-heading-moved')).toBeNull();
    });

    it('opens at the top with one dismissible notice when the heading no longer exists (spec S-15)', async () => {
        const loadBody = vi.fn(async () => bodyFor('missions', [heading.id]));
        render(
            <HelpArticleReader
                article={missions}
                headingId="writing-a-brief"
                mode="page"
                onOpenArticle={vi.fn()}
                loadBody={loadBody}
            />,
        );
        const notice = await screen.findByTestId('help-heading-moved');
        expect(notice).toHaveTextContent('headingMoved');
        fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
        expect(screen.queryByTestId('help-heading-moved')).toBeNull();
    });

    it('shows the English-only notice above the body for a non-English interface (spec FR-39)', async () => {
        intl.locale = 'fr';
        render(
            <HelpArticleReader
                article={missions}
                headingId={null}
                mode="panel"
                onOpenArticle={vi.fn()}
                loadBody={vi.fn(async () => bodyFor('missions', [heading.id]))}
            />,
        );
        expect(screen.getByTestId('help-english-only')).toHaveTextContent('englishOnly');
    });

    it('never ends in an error: an unavailable body shows the summary, a retry and the published page', async () => {
        const loadBody = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(bodyFor('missions', [heading.id]));
        render(
            <HelpArticleReader
                article={missions}
                headingId={null}
                mode="panel"
                onOpenArticle={vi.fn()}
                loadBody={loadBody}
            />,
        );
        expect(await screen.findByTestId('help-body-unavailable')).toBeInTheDocument();
        expect(screen.getByText(missions.summary)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /readOnDocsSite/ })).toHaveAttribute(
            'href',
            missions.docsUrl,
        );
        fireEvent.click(screen.getByRole('button', { name: 'retry' }));
        expect(await screen.findByText(`About ${heading.id}`)).toBeInTheDocument();
        expect(loadBody).toHaveBeenCalledTimes(2);
    });

    it('opens a related article in place and offers Back in the panel', async () => {
        const onOpenArticle = vi.fn();
        const onBack = vi.fn();
        render(
            <HelpArticleReader
                article={missions}
                headingId={null}
                mode="panel"
                onBack={onBack}
                onOpenArticle={onOpenArticle}
                loadBody={vi.fn(async () => null)}
            />,
        );
        const related = document.querySelector<HTMLAnchorElement>(
            `[data-help-related="${missions.related[0]}"]`,
        )!;
        expect(related).toHaveAttribute('href', `/help/${missions.related[0]}`);
        fireEvent.click(related);
        expect(onOpenArticle).toHaveBeenCalledWith(missions.related[0]);
        fireEvent.click(screen.getByTestId('help-article-back'));
        expect(onBack).toHaveBeenCalled();
    });

    it('keeps the Organization namespace on a related article a modified click follows', () => {
        workspace.prefix = '/org/acme';
        const onOpenArticle = vi.fn();
        render(
            <HelpArticleReader
                article={missions}
                headingId={null}
                mode="panel"
                onOpenArticle={onOpenArticle}
                loadBody={vi.fn(async () => null)}
            />,
        );
        const related = document.querySelector<HTMLAnchorElement>(
            `[data-help-related="${missions.related[0]}"]`,
        )!;
        expect(related).toHaveAttribute('href', `/org/acme/help/${missions.related[0]}`);
        for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
            expect(fireEvent.click(related, { [modifier]: true }), modifier).toBe(true);
        }
        expect(onOpenArticle).not.toHaveBeenCalled();
    });

    it('uses a page-level title and no Back control on the full page', () => {
        render(
            <HelpArticleReader
                article={missions}
                headingId={null}
                mode="page"
                onOpenArticle={vi.fn()}
                loadBody={vi.fn(async () => null)}
            />,
        );
        expect(screen.getByRole('heading', { level: 1, name: missions.title })).toBeInTheDocument();
        expect(screen.queryByTestId('help-article-back')).toBeNull();
    });
});
