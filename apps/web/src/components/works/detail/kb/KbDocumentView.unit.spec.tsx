import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));

// MarkdownPreview is a client component that pulls in react-markdown.
// Stub it so the unit test focuses on KbDocumentView's structure
// rather than re-asserting markdown rendering itself.
vi.mock('@/components/works/detail/items/MarkdownPreview', () => ({
    MarkdownPreview: ({ content }: { content: string }) => (
        <div data-testid="markdown-preview-mock">{content}</div>
    ),
}));

import { KbDocumentView } from './KbDocumentView';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentBodyDto> = {}): KbDocumentBodyDto {
    return {
        id: 'doc-1',
        workId: 'work-1',
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Brand voice',
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
        body: '# Voice\n\nClear, confident, never breathless.',
        assets: [],
        ...overrides,
    };
}

/**
 * EW-641 Phase 1B/d row 4 — KbDocumentView is a server component (it
 * uses `getTranslations`). React 19 lets server components return a
 * Promise that `render()` resolves; we `await` the call before passing
 * the element tree to React Testing Library.
 *
 * These tests lock the rendered structure that:
 *  - the upcoming Playwright suite (A12-A17) selectors against
 *  - the editor PR (row 5) will swap out — `data-testid="kb-editor"` +
 *    `kb-document-body` need to stay stable across the read-only →
 *    Tiptap transition.
 */
describe('KbDocumentView', () => {
    it('renders the title, class chip, status chip, and path', async () => {
        render(await KbDocumentView({ doc: doc() }));

        expect(screen.getByTestId('kb-document-title').textContent).toBe('Brand voice');
        const meta = screen.getByTestId('kb-document-meta');
        expect(meta.textContent).toContain('classes.brand');
        expect(meta.textContent).toContain('status.active');
        expect(meta.textContent).toContain('brand/voice.md');
    });

    it('falls back to the path when the title is empty', async () => {
        render(await KbDocumentView({ doc: doc({ title: '', path: 'legal/privacy.md' }) }));
        expect(screen.getByTestId('kb-document-title').textContent).toBe('legal/privacy.md');
    });

    it('renders the body via MarkdownPreview when content is present', async () => {
        render(await KbDocumentView({ doc: doc({ body: '# Heading\n\nBody' }) }));
        const body = screen.getByTestId('kb-document-body');
        const preview = screen.getByTestId('markdown-preview-mock');
        expect(body.contains(preview)).toBe(true);
        expect(preview.textContent).toBe('# Heading\n\nBody');
    });

    it('shows the empty-body placeholder when body is blank/whitespace', async () => {
        render(await KbDocumentView({ doc: doc({ body: '   \n\n' }) }));
        const body = screen.getByTestId('kb-document-body');
        expect(body.textContent).toContain('document.emptyBody');
        // No markdown preview rendered when body is empty.
        expect(screen.queryByTestId('markdown-preview-mock')).toBeNull();
    });

    it('exposes the lock chip + data-locked when the doc is locked', async () => {
        render(
            await KbDocumentView({
                doc: doc({ locked: true, lockMode: 'additions-only' }),
            }),
        );
        const lockEl = screen.getByTestId('kb-document-meta').querySelector('[data-locked="true"]');
        expect(lockEl).not.toBeNull();
        expect(lockEl?.getAttribute('data-kb-lock-mode')).toBe('additions-only');
        expect(lockEl?.textContent).toContain('lock.additions-only');
    });

    it('omits the lock chip when unlocked', async () => {
        render(await KbDocumentView({ doc: doc({ locked: false }) }));
        const meta = screen.getByTestId('kb-document-meta');
        expect(meta.querySelector('[data-locked="true"]')).toBeNull();
    });

    it('renders the description paragraph when present', async () => {
        render(await KbDocumentView({ doc: doc({ description: 'How we talk to customers' }) }));
        expect(screen.getByText('How we talk to customers')).toBeTruthy();
    });
});
