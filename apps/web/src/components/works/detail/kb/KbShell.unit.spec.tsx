import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { KbShell } from './KbShell';

/**
 * EW-641 Phase 1B/d row 2 — `KbShell` renders the three placeholder
 * panes (tree / editor / AI). This spec locks the structural shape so
 * follow-up tickets (tree-data fetch, editor, side panel) can replace
 * each pane's body without breaking the route or the Playwright
 * selectors that the acceptance suite (A12-A17) leans on.
 */
describe('KbShell', () => {
    it('exposes the workId via data attribute (handed to data-fetching panes later)', () => {
        const { container } = render(<KbShell workId="work-123" />);
        const shell = container.querySelector('[data-testid="kb-shell"]');
        expect(shell).not.toBeNull();
        expect(shell?.getAttribute('data-work-id')).toBe('work-123');
    });

    it('renders all three placeholder panes with stable test ids', () => {
        render(<KbShell workId="work-abc" />);
        expect(screen.getByTestId('kb-tree')).toBeTruthy();
        expect(screen.getByTestId('kb-editor')).toBeTruthy();
        expect(screen.getByTestId('kb-ai-panel')).toBeTruthy();
    });

    it('uses translation keys for the header copy (no hardcoded strings)', () => {
        render(<KbShell workId="work-abc" />);
        // The mocked useTranslations echoes the key — so seeing "title"
        // in the DOM proves the heading reaches for `kb.title`.
        expect(screen.getByText('title')).toBeTruthy();
        expect(screen.getByText('subtitle')).toBeTruthy();
    });

    it('labels each pane with the matching translation key', () => {
        render(<KbShell workId="work-abc" />);
        const tree = screen.getByTestId('kb-tree');
        const editor = screen.getByTestId('kb-editor');
        const ai = screen.getByTestId('kb-ai-panel');
        expect(tree.getAttribute('aria-label')).toBe('panes.tree.title');
        expect(editor.getAttribute('aria-label')).toBe('panes.editor.title');
        expect(ai.getAttribute('aria-label')).toBe('panes.ai.title');
    });
});
