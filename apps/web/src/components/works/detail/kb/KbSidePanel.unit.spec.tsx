import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string, args?: Record<string, string | number>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
}));

// KbLockControls is a client component nested inside the server-rendered
// side panel — it pulls in next-intl, next/navigation, and the lock
// server actions. Mock those so the side-panel spec stays focused on the
// outer structure (the controls have their own spec).
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@/components/ui/button', () => ({
    Button: ({
        children,
        onClick,
        disabled,
        ...rest
    }: {
        children: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
    } & Record<string, unknown>) => (
        <button type="button" onClick={onClick} disabled={disabled} {...rest}>
            {children}
        </button>
    ),
}));
vi.mock('@/app/actions/works/kb-lock', () => ({
    lockKbDocumentAction: vi.fn(),
    unlockKbDocumentAction: vi.fn(),
}));

import { KbSidePanel } from './KbSidePanel';
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
        body: '# Voice',
        assets: [],
        ...overrides,
    };
}

/**
 * EW-641 Phase 1B/d row 13 — KbSidePanel is a server component (uses
 * `getTranslations`). React 19 lets server components return a Promise
 * that `render()` resolves; we `await` the call before passing the
 * element tree to React Testing Library (same pattern as the
 * KbDocumentView / KbTreePanel specs).
 *
 * These tests lock the rendered structure that the upcoming Playwright
 * A12-A17 suite (and the row 14 lock-UI PR) will rely on. Every section
 * has a stable `data-testid` so a markup shuffle in row 14 doesn't
 * silently break e2e.
 */
describe('KbSidePanel', () => {
    it('renders the root with stable selectors + doc identity attrs', async () => {
        render(await KbSidePanel({ doc: doc() }));
        const root = screen.getByTestId('kb-side-panel');
        expect(root.getAttribute('data-doc-id')).toBe('doc-1');
        expect(root.getAttribute('data-doc-path')).toBe('brand/voice.md');
    });

    it('renders the class chip with data-kb-class and class label', async () => {
        render(await KbSidePanel({ doc: doc({ class: 'legal' }) }));
        const chip = screen.getByTestId('kb-side-panel-class');
        expect(chip.getAttribute('data-kb-class')).toBe('legal');
        expect(chip.textContent).toBe('classes.legal');
    });

    it('renders the status badge with data-kb-status', async () => {
        render(await KbSidePanel({ doc: doc({ status: 'archived' }) }));
        const badge = screen.getByTestId('kb-side-panel-status');
        expect(badge.getAttribute('data-kb-status')).toBe('archived');
        expect(badge.textContent).toBe('status.archived');
    });

    it('shows unlocked badge when doc.locked === false', async () => {
        render(await KbSidePanel({ doc: doc({ locked: false, lockMode: null }) }));
        const lock = screen.getByTestId('kb-side-panel-lock');
        expect(lock.getAttribute('data-locked')).toBe('false');
        expect(lock.getAttribute('data-kb-lock-mode')).toBeNull();
        expect(lock.textContent).toBe('sidePanel.unlocked');
    });

    it('shows locked badge with lock mode when doc.locked === true', async () => {
        render(
            await KbSidePanel({
                doc: doc({ locked: true, lockMode: 'additions-only' }),
            }),
        );
        const lock = screen.getByTestId('kb-side-panel-lock');
        expect(lock.getAttribute('data-locked')).toBe('true');
        expect(lock.getAttribute('data-kb-lock-mode')).toBe('additions-only');
        expect(lock.textContent).toContain('🔒');
        expect(lock.textContent).toContain('lock.additions-only');
    });

    it('falls back to lock.full label when locked but lockMode is null', async () => {
        render(await KbSidePanel({ doc: doc({ locked: true, lockMode: null }) }));
        expect(screen.getByTestId('kb-side-panel-lock').textContent).toContain('lock.full');
    });

    it('renders the empty-tags placeholder when doc.tags is empty', async () => {
        render(await KbSidePanel({ doc: doc({ tags: [] }) }));
        const tags = screen.getByTestId('kb-side-panel-tags');
        expect(tags.getAttribute('data-empty')).toBe('true');
        expect(tags.textContent).toBe('sidePanel.emptyTags');
    });

    it('renders one <li data-kb-tag> per tag when present', async () => {
        render(await KbSidePanel({ doc: doc({ tags: ['voice', 'tone', 'editorial'] }) }));
        const tags = screen.getByTestId('kb-side-panel-tags');
        expect(tags.getAttribute('data-empty')).toBe('false');
        const items = tags.querySelectorAll('[data-kb-tag]');
        expect(items.length).toBe(3);
        expect(Array.from(items).map((el) => el.getAttribute('data-kb-tag'))).toEqual([
            'voice',
            'tone',
            'editorial',
        ]);
    });

    it('renders the description paragraph when present', async () => {
        render(await KbSidePanel({ doc: doc({ description: 'How we talk to customers' }) }));
        const desc = screen.getByTestId('kb-side-panel-description');
        expect(desc.getAttribute('data-empty')).toBeNull();
        expect(desc.textContent).toBe('How we talk to customers');
    });

    it('renders the empty-description placeholder when null', async () => {
        render(await KbSidePanel({ doc: doc({ description: null }) }));
        const desc = screen.getByTestId('kb-side-panel-description');
        expect(desc.getAttribute('data-empty')).toBe('true');
        expect(desc.textContent).toBe('sidePanel.emptyDescription');
    });

    it('renders language + source with data-attrs', async () => {
        render(await KbSidePanel({ doc: doc({ language: 'fr', source: 'agent' }) }));
        const lang = screen.getByTestId('kb-side-panel-language');
        expect(lang.getAttribute('data-kb-language')).toBe('fr');
        expect(lang.textContent).toBe('fr');
        const src = screen.getByTestId('kb-side-panel-source');
        expect(src.getAttribute('data-kb-source')).toBe('agent');
        expect(src.textContent).toBe('sidePanel.sources.agent');
    });

    it('omits counts section when both wordCount + tokenCount are null', async () => {
        render(await KbSidePanel({ doc: doc({ wordCount: null, tokenCount: null }) }));
        expect(screen.queryByTestId('kb-side-panel-counts')).toBeNull();
    });

    it('renders counts when at least one count is known', async () => {
        render(await KbSidePanel({ doc: doc({ wordCount: 412, tokenCount: 590 }) }));
        const counts = screen.getByTestId('kb-side-panel-counts');
        expect(counts.getAttribute('data-word-count')).toBe('412');
        expect(counts.getAttribute('data-token-count')).toBe('590');
        expect(counts.textContent).toContain('sidePanel.wordCount count=412');
        expect(counts.textContent).toContain('sidePanel.tokenCount count=590');
        expect(counts.textContent).toContain('·');
    });

    it('renders only word count when token count is null', async () => {
        render(await KbSidePanel({ doc: doc({ wordCount: 100, tokenCount: null }) }));
        const counts = screen.getByTestId('kb-side-panel-counts');
        expect(counts.getAttribute('data-token-count')).toBeNull();
        expect(counts.textContent).not.toContain('·');
        expect(counts.textContent).toContain('sidePanel.wordCount count=100');
    });

    it('renders the disabled "view history" placeholder button (row 18 will wire it)', async () => {
        render(await KbSidePanel({ doc: doc() }));
        const btn = screen.getByTestId('kb-side-panel-history') as HTMLButtonElement;
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('data-disabled')).toBe('true');
        expect(btn.getAttribute('aria-disabled')).toBe('true');
        expect(btn.textContent).toBe('sidePanel.viewHistory');
    });
});
