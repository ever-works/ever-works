import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// Legacy `next/link` mock — KbTreePanel now imports `Link` from
// `@/i18n/navigation` (locale-aware), so this mock is dead-code; we
// leave it in place as a safety net for any transitive consumers.
vi.mock('next/link', () => ({
    default: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

// KbTreePanel imports `Link` from `@/i18n/navigation`. next-intl
// 4.9.2's navigation client uses a bare `next/navigation` specifier
// that fails to resolve under pnpm's symlinked tree in Vitest — stub
// the whole module with a passthrough `<a>` and no-op router.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    redirect: vi.fn(),
    getPathname: ({ href }: { href: string }) => href,
}));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));

// KbTreeDocRow + KbTreeClassDeleteButton (rendered by KbTreePanel)
// are client components that pull in `useTranslations` from
// `next-intl`. The panel itself is a server component, so this mock
// only needs to satisfy the nested client subtree.
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Server actions invoked by the delete affordances. The KbTreePanel
// spec doesn't assert on them — we just stub them so the imports
// resolve without pulling in `server-only`.
vi.mock('@/app/actions/works/kb-document', () => ({
    deleteKbDocumentAction: vi.fn(),
}));

import { KbTreePanel } from './KbTreePanel';
import type { KbDocumentDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-' + Math.random().toString(36).slice(2, 9),
        workId: 'work-1',
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Voice',
        description: null,
        class: 'brand',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'user',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: null,
        updatedById: null,
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        ...overrides,
    };
}

/**
 * EW-641 Phase 1B/d row 3 — `KbTreePanel` is a server component that
 * groups KB documents by class. These tests cover the rendered output
 * shape that Playwright e2e and follow-up tickets (A12-A17 acceptance
 * suite + editor row #4) will depend on:
 *  - empty list → friendly placeholder
 *  - non-empty → groups in canonical class order
 *  - sort-within-group by title
 *  - lock indicator + active highlight
 *  - Link target points to the upcoming `[...path]/page.tsx` route
 *
 * Server components in React 19 return a Promise from the function
 * call; we `await` it before handing the element tree to `render()`.
 */
describe('KbTreePanel', () => {
    it('shows an empty placeholder when the document list is empty', async () => {
        render(await KbTreePanel({ workId: 'work-1', documents: [] }));
        const tree = screen.getByTestId('kb-tree');
        expect(tree).toBeTruthy();
        expect(tree.textContent).toContain('panes.tree.empty');
        expect(screen.queryByTestId('kb-tree-count')).toBeNull();
    });

    it('renders the total count and one group per non-empty class', async () => {
        render(
            await KbTreePanel({
                workId: 'work-1',
                documents: [
                    doc({ id: 'a', title: 'Voice', class: 'brand', path: 'brand/voice.md' }),
                    doc({ id: 'b', title: 'Privacy', class: 'legal', path: 'legal/privacy.md' }),
                    doc({ id: 'c', title: 'GDPR', class: 'legal', path: 'legal/gdpr.md' }),
                ],
            }),
        );

        expect(screen.getByTestId('kb-tree-count').textContent).toBe('3');
        expect(screen.getByTestId('kb-tree-group-brand')).toBeTruthy();
        expect(screen.getByTestId('kb-tree-group-legal')).toBeTruthy();
        // Glossary etc. should NOT render — group only appears when populated.
        expect(screen.queryByTestId('kb-tree-group-glossary')).toBeNull();
    });

    it('preserves canonical class order (brand before legal before glossary…)', async () => {
        render(
            await KbTreePanel({
                workId: 'work-1',
                documents: [
                    doc({ id: 'g', title: 'Terms', class: 'glossary', path: 'glossary/t.md' }),
                    doc({ id: 'l', title: 'Privacy', class: 'legal', path: 'legal/p.md' }),
                    doc({ id: 'b', title: 'Voice', class: 'brand', path: 'brand/v.md' }),
                ],
            }),
        );
        const groups = screen.getAllByTestId(/^kb-tree-group-/);
        expect(groups[0].getAttribute('data-testid')).toBe('kb-tree-group-brand');
        expect(groups[1].getAttribute('data-testid')).toBe('kb-tree-group-legal');
        expect(groups[2].getAttribute('data-testid')).toBe('kb-tree-group-glossary');
    });

    it('sorts items within a group by title (case-insensitive)', async () => {
        render(
            await KbTreePanel({
                workId: 'work-1',
                documents: [
                    doc({ id: '1', title: 'zebra', class: 'brand', path: 'brand/z.md' }),
                    doc({ id: '2', title: 'Alpha', class: 'brand', path: 'brand/a.md' }),
                    doc({ id: '3', title: 'beta', class: 'brand', path: 'brand/b.md' }),
                ],
            }),
        );
        const group = screen.getByTestId('kb-tree-group-brand');
        const items = within(group).getAllByTestId('kb-tree-item');
        expect(items[0].textContent).toContain('Alpha');
        expect(items[1].textContent).toContain('beta');
        expect(items[2].textContent).toContain('zebra');
    });

    it('renders a lock marker when the doc is locked', async () => {
        render(
            await KbTreePanel({
                workId: 'work-1',
                documents: [doc({ locked: true, title: 'Locked doc', path: 'brand/x.md' })],
            }),
        );
        const item = screen.getByTestId('kb-tree-item');
        expect(item.getAttribute('data-locked')).toBe('true');
        expect(item.textContent).toContain('🔒');
    });

    it('highlights the active item via aria-current and links to the nested route', async () => {
        render(
            await KbTreePanel({
                workId: 'work-1',
                documents: [
                    doc({ id: 'a', title: 'Voice', class: 'brand', path: 'brand/voice.md' }),
                    doc({ id: 'b', title: 'Tone', class: 'brand', path: 'brand/tone.md' }),
                ],
                activePath: 'brand/voice.md',
            }),
        );
        const items = screen.getAllByTestId('kb-tree-item');
        const active = items.find((el) => el.getAttribute('data-doc-path') === 'brand/voice.md');
        const other = items.find((el) => el.getAttribute('data-doc-path') === 'brand/tone.md');
        expect(active?.getAttribute('aria-current')).toBe('page');
        expect(other?.getAttribute('aria-current')).toBeNull();
        // Link href targets the upcoming `[...path]` route in row 4.
        expect(active?.getAttribute('href')).toBe('/works/work-1/kb/brand/voice.md');
    });

    // ─── EW-641 Phase 2/e row 38a — "Inherited from organization" section ───

    describe('inheritedDocuments — "Inherited from organization" section', () => {
        it('does NOT render the inherited section when inheritedDocuments is omitted', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [doc({ title: 'Voice', class: 'brand', path: 'brand/v.md' })],
                }),
            );
            expect(screen.queryByTestId('kb-tree-inherited')).toBeNull();
        });

        it('does NOT render the inherited section when inheritedDocuments is empty', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [doc({ title: 'Voice', class: 'brand', path: 'brand/v.md' })],
                    inheritedDocuments: [],
                }),
            );
            expect(screen.queryByTestId('kb-tree-inherited')).toBeNull();
        });

        it('shows the empty placeholder only when BOTH lists are empty', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [],
                    inheritedDocuments: [],
                }),
            );
            const tree = screen.getByTestId('kb-tree');
            expect(tree.textContent).toContain('panes.tree.empty');
            // No header / count / inherited section in pure-empty state.
            expect(screen.queryByTestId('kb-tree-count')).toBeNull();
            expect(screen.queryByTestId('kb-tree-inherited')).toBeNull();
        });

        it('renders the inherited section ABOVE per-class groups when both populate', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [
                        doc({ id: 'w1', title: 'Voice', class: 'brand', path: 'brand/v.md' }),
                    ],
                    inheritedDocuments: [
                        doc({
                            id: 'org-1',
                            title: 'Privacy',
                            class: 'legal',
                            slug: 'privacy',
                            path: 'legal/privacy.md',
                            workId: null,
                            organizationId: 'org-1',
                        }),
                    ],
                }),
            );
            const inherited = screen.getByTestId('kb-tree-inherited');
            const brand = screen.getByTestId('kb-tree-group-brand');
            // DOM order: inherited section comes first inside the <nav>.
            expect(
                inherited.compareDocumentPosition(brand) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        });

        it('emits class+slug-scoped data-testid + lock marker + inherited data-source on each row', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [],
                    inheritedDocuments: [
                        doc({
                            id: 'org-l',
                            title: 'Privacy',
                            class: 'legal',
                            slug: 'privacy',
                            path: 'legal/privacy.md',
                            workId: null,
                            organizationId: 'org-1',
                        }),
                    ],
                }),
            );
            const row = screen.getByTestId('kb-tree-inherited-legal-privacy');
            expect(row.getAttribute('data-source')).toBe('inherited');
            expect(row.getAttribute('data-doc-class')).toBe('legal');
            expect(row.getAttribute('data-doc-path')).toBe('legal/privacy.md');
            // Lock-overlay marker is always present on inherited rows
            // — the read-only nature is conveyed at-a-glance.
            expect(row.textContent).toContain('🔒');
            // Links to the same nested route shape; row 38c teaches the
            // detail page to switch to read-only based on inherited
            // status (no Work-owned override at the same path).
            expect(row.getAttribute('href')).toBe('/works/work-1/kb/legal/privacy.md');
        });

        it('sorts inherited rows by canonical class order then by title (case-insensitive)', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [],
                    inheritedDocuments: [
                        // Seed order is intentionally noisy.
                        doc({
                            id: '1',
                            title: 'zebra',
                            class: 'style',
                            slug: 'z',
                            path: 'style/z.md',
                        }),
                        doc({
                            id: '2',
                            title: 'Alpha',
                            class: 'legal',
                            slug: 'a',
                            path: 'legal/a.md',
                        }),
                        doc({
                            id: '3',
                            title: 'beta',
                            class: 'legal',
                            slug: 'b',
                            path: 'legal/b.md',
                        }),
                        doc({
                            id: '4',
                            title: 'Charlie',
                            class: 'style',
                            slug: 'c',
                            path: 'style/c.md',
                        }),
                    ],
                }),
            );
            // KB_DOCUMENT_CLASSES canonical order places `legal` before
            // `style`. Within each, titles are sorted case-insensitive ASC.
            const inheritedSection = screen.getByTestId('kb-tree-inherited');
            const rows = within(inheritedSection).getAllByRole('link');
            expect(rows[0].getAttribute('data-doc-path')).toBe('legal/a.md');
            expect(rows[1].getAttribute('data-doc-path')).toBe('legal/b.md');
            expect(rows[2].getAttribute('data-doc-path')).toBe('style/c.md');
            expect(rows[3].getAttribute('data-doc-path')).toBe('style/z.md');
        });

        it('renders the i18n section title + description copy', async () => {
            render(
                await KbTreePanel({
                    workId: 'work-1',
                    documents: [],
                    inheritedDocuments: [
                        doc({
                            id: 'org-l',
                            class: 'legal',
                            slug: 'privacy',
                            path: 'legal/privacy.md',
                        }),
                    ],
                }),
            );
            const inherited = screen.getByTestId('kb-tree-inherited');
            // The test next-intl mock returns the message key itself —
            // verifies the component does call getTranslations() for both
            // the section title and the description copy. Real translations
            // are exercised by the messages/*.json catalogs.
            expect(inherited.textContent).toContain('panes.tree.inheritedSection.title');
            expect(screen.getByTestId('kb-tree-inherited-description').textContent).toBe(
                'panes.tree.inheritedSection.description',
            );
        });
    });
});
