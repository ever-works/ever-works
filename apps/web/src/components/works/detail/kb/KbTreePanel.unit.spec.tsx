import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

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

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
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
});
