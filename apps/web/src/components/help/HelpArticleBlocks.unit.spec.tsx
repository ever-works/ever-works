import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { HelpBlock, HelpInline, HelpLinkTarget } from '@ever-works/contracts/api';

// Stands in for the workspace-aware Link: inside an Organization it puts the
// `/org/<slug>` prefix on the address, which a bare anchor would not get.
const workspace = vi.hoisted(() => ({ prefix: '' }));
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={`${workspace.prefix}${href}`} {...rest}>
            {children}
        </a>
    ),
}));

afterEach(() => {
    workspace.prefix = '';
});

import { HelpArticleBlocks } from './HelpArticleBlocks';

const text = (value: string): HelpInline => ({ type: 'text', text: value });
const linkParagraph = (label: string, target: HelpLinkTarget): HelpBlock => ({
    kind: 'paragraph',
    content: [{ type: 'link', children: [text(label)], target }],
});

function renderBlocks(blocks: HelpBlock[], onOpenArticle = vi.fn(), idPrefix = '') {
    const utils = render(
        <HelpArticleBlocks blocks={blocks} onOpenArticle={onOpenArticle} idPrefix={idPrefix} />,
    );
    return { ...utils, onOpenArticle };
}

describe('HelpArticleBlocks — every block kind (spec FR-27, FR-28)', () => {
    it('renders each kind as elements, never as injected markup', () => {
        const blocks: HelpBlock[] = [
            { kind: 'heading', level: 2, id: 'first', content: [text('First')] },
            {
                kind: 'paragraph',
                content: [text('<img src=x onerror=alert(1)>'), { type: 'code', text: 'pnpm' }],
            },
            { kind: 'orderedList', items: [{ content: [text('one')], children: [] }] },
            {
                kind: 'unorderedList',
                items: [{ content: [{ type: 'strong', children: [text('two')] }], children: [] }],
            },
            {
                kind: 'note',
                tone: 'warning',
                title: 'Careful',
                blocks: [{ kind: 'paragraph', content: [text('x')] }],
            },
            { kind: 'shortcut', keys: ['Ctrl', 'K'], label: 'Palette' },
            { kind: 'code', language: 'bash', text: 'pnpm dev' },
            {
                kind: 'table',
                header: [[text('Col')]],
                rows: [[[{ type: 'emphasis', children: [text('cell')] }]]],
            },
        ];
        const { container } = renderBlocks(blocks, vi.fn(), 'help-drawer-');
        expect(container.querySelector('h2#help-drawer-first')).not.toBeNull();
        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
        expect(container.querySelector('ol li')?.textContent).toBe('one');
        expect(container.querySelector('ul li strong')?.textContent).toBe('two');
        expect(container.querySelector('aside[role="note"][data-tone="warning"]')).not.toBeNull();
        expect(container.querySelectorAll('kbd')).toHaveLength(2);
        expect(container.querySelector('pre code')?.textContent).toBe('pnpm dev');
        expect(container.querySelector('table th')?.textContent).toBe('Col');
        expect(container.querySelector('table td em')?.textContent).toBe('cell');
        expect(container.innerHTML).not.toContain('dangerouslySetInnerHTML');
    });
});

describe('HelpArticleBlocks — links (spec FR-27a)', () => {
    it('opens another article in place and still carries a same-origin address', () => {
        const { onOpenArticle } = renderBlocks([
            linkParagraph('Tasks', {
                type: 'article',
                articleId: 'tasks',
                headingId: 'creating-a-task',
            }),
        ]);
        const link = screen.getByRole('link', { name: 'Tasks' });
        expect(link).toHaveAttribute('href', '/help/tasks#creating-a-task');
        fireEvent.click(link);
        expect(onOpenArticle).toHaveBeenCalledWith('tasks#creating-a-task');
    });

    it('lets a modified click follow the address instead of opening in place', () => {
        const { onOpenArticle } = renderBlocks([
            linkParagraph('Tasks', { type: 'article', articleId: 'tasks', headingId: null }),
        ]);
        fireEvent.click(screen.getByRole('link', { name: 'Tasks' }), { ctrlKey: true });
        expect(onOpenArticle).not.toHaveBeenCalled();
    });

    it('keeps the Organization namespace on the address a modified click follows', () => {
        workspace.prefix = '/org/acme';
        const { onOpenArticle } = renderBlocks([
            linkParagraph('Tasks', {
                type: 'article',
                articleId: 'tasks',
                headingId: 'creating-a-task',
            }),
        ]);
        const link = screen.getByRole('link', { name: 'Tasks' });
        expect(link).toHaveAttribute('href', '/org/acme/help/tasks#creating-a-task');
        for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
            expect(fireEvent.click(link, { [modifier]: true }), modifier).toBe(true);
        }
        expect(onOpenArticle).not.toHaveBeenCalled();
        expect(fireEvent.click(link)).toBe(false);
        expect(onOpenArticle).toHaveBeenCalledWith('tasks#creating-a-task');
    });

    it('links a screen through the route map', () => {
        renderBlocks([
            linkParagraph('Missions', { type: 'screen', routeKey: 'DASHBOARD_MISSIONS' }),
        ]);
        expect(screen.getByRole('link', { name: 'Missions' })).toHaveAttribute('href', '/missions');
    });

    it('opens an external address in a new tab with no referrer and says it leaves the app', () => {
        renderBlocks([
            {
                kind: 'link',
                label: 'Status',
                target: { type: 'external', href: 'https://status.example.org/' },
            },
        ]);
        const link = screen.getByRole('link', { name: /Status/ });
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link).toHaveAttribute('href', 'https://status.example.org/');
        expect(link.textContent).toContain('externalLink');
    });

    it.each<[string, HelpLinkTarget]>([
        ['javascript:', { type: 'external', href: 'javascript:alert(1)' }],
        ['http:', { type: 'external', href: 'http://example.org' }],
        ['data:', { type: 'external', href: 'data:text/html,hi' }],
        ['credentials', { type: 'external', href: 'https://user:pass@example.org' }],
        ['an unknown article', { type: 'article', articleId: 'not-in-build', headingId: null }],
        ['an unknown screen', { type: 'screen', routeKey: 'DASHBOARD_NOPE' }],
        ['a parameterised screen', { type: 'screen', routeKey: 'DASHBOARD_MISSION' }],
        ['a non-dashboard route', { type: 'screen', routeKey: 'AUTH_LOGIN' }],
    ])('renders the label as plain text for %s', (_label, target) => {
        const { container } = renderBlocks([linkParagraph('Label', target)]);
        expect(container.querySelector('a')).toBeNull();
        expect(screen.getByText('Label')).toBeInTheDocument();
    });
});
