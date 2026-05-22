import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const routerRefreshMock = vi.fn();
vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: routerRefreshMock }),
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

const lockActionMock = vi.fn();
const unlockActionMock = vi.fn();
vi.mock('@/app/actions/works/kb-lock', () => ({
    lockKbDocumentAction: (...args: unknown[]) => lockActionMock(...args),
    unlockKbDocumentAction: (...args: unknown[]) => unlockActionMock(...args),
}));

import { KbLockControls } from './KbLockControls';
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
        body: '',
        assets: [],
        ...overrides,
    };
}

/**
 * EW-641 Phase 1B/d row 14 — `KbLockControls` is a client component
 * that drives the lock/unlock + mode-picker UI in the side panel.
 *
 * The tests pin:
 *  - the optimistic local state flip on click
 *  - the server-action call shape (workId, docId, path, mode)
 *  - the rollback path when the action returns `success: false`
 *  - the mode picker only being interactive while locked
 *  - the stable `kb-side-panel-lock` test-id (row 13 e2e still works)
 */
describe('KbLockControls', () => {
    beforeEach(() => {
        lockActionMock.mockReset();
        unlockActionMock.mockReset();
        routerRefreshMock.mockReset();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders the unlocked badge + Lock button + disabled mode-select when unlocked', () => {
        render(<KbLockControls doc={doc({ locked: false, lockMode: null })} />);
        const badge = screen.getByTestId('kb-side-panel-lock');
        expect(badge.getAttribute('data-locked')).toBe('false');
        expect(badge.getAttribute('data-kb-lock-mode')).toBeNull();
        expect(badge.textContent).toBe('sidePanel.unlocked');

        const toggle = screen.getByTestId('kb-side-panel-lock-toggle') as HTMLButtonElement;
        expect(toggle.getAttribute('data-action')).toBe('lock');
        expect(toggle.textContent).toBe('lockControls.lock');

        const mode = screen.getByTestId('kb-side-panel-lock-mode') as HTMLSelectElement;
        expect(mode.disabled).toBe(true);
    });

    it('renders the locked badge + Unlock button + enabled mode-select when locked', () => {
        render(<KbLockControls doc={doc({ locked: true, lockMode: 'additions-only' })} />);
        const badge = screen.getByTestId('kb-side-panel-lock');
        expect(badge.getAttribute('data-locked')).toBe('true');
        expect(badge.getAttribute('data-kb-lock-mode')).toBe('additions-only');
        expect(badge.textContent).toContain('🔒');
        expect(badge.textContent).toContain('lock.additions-only');

        const toggle = screen.getByTestId('kb-side-panel-lock-toggle') as HTMLButtonElement;
        expect(toggle.getAttribute('data-action')).toBe('unlock');
        expect(toggle.textContent).toBe('lockControls.unlock');

        const mode = screen.getByTestId('kb-side-panel-lock-mode') as HTMLSelectElement;
        expect(mode.disabled).toBe(false);
        expect(mode.value).toBe('additions-only');
    });

    it('flips to locked optimistically and calls lockKbDocumentAction with mode=full', async () => {
        lockActionMock.mockResolvedValueOnce({
            success: true,
            data: {
                id: 'doc-1',
                workId: 'work-1',
                path: 'brand/voice.md',
                locked: true,
                lockMode: 'full',
            },
        });
        render(<KbLockControls doc={doc({ locked: false })} />);
        fireEvent.click(screen.getByTestId('kb-side-panel-lock-toggle'));

        // Optimistic flip — even before the action resolves, the badge
        // already shows the locked state.
        expect(screen.getByTestId('kb-side-panel-lock').getAttribute('data-locked')).toBe('true');
        expect(lockActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            path: 'brand/voice.md',
            mode: 'full',
        });
        await waitFor(() => {
            expect(routerRefreshMock).toHaveBeenCalled();
        });
    });

    it('flips to unlocked and calls unlockKbDocumentAction', async () => {
        unlockActionMock.mockResolvedValueOnce({
            success: true,
            data: {
                id: 'doc-1',
                workId: 'work-1',
                path: 'brand/voice.md',
                locked: false,
                lockMode: null,
            },
        });
        render(<KbLockControls doc={doc({ locked: true, lockMode: 'full' })} />);
        fireEvent.click(screen.getByTestId('kb-side-panel-lock-toggle'));

        expect(screen.getByTestId('kb-side-panel-lock').getAttribute('data-locked')).toBe('false');
        expect(unlockActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            path: 'brand/voice.md',
        });
        await waitFor(() => {
            expect(routerRefreshMock).toHaveBeenCalled();
        });
    });

    it('reverts the optimistic flip + surfaces the error when the action fails', async () => {
        lockActionMock.mockResolvedValueOnce({
            success: false,
            error: 'concurrent lock attempt',
        });
        render(<KbLockControls doc={doc({ locked: false })} />);
        fireEvent.click(screen.getByTestId('kb-side-panel-lock-toggle'));

        await waitFor(() => {
            const error = screen.getByTestId('kb-side-panel-lock-error');
            expect(error.textContent).toBe('concurrent lock attempt');
        });
        // Reverted to unlocked.
        expect(screen.getByTestId('kb-side-panel-lock').getAttribute('data-locked')).toBe('false');
        expect(routerRefreshMock).not.toHaveBeenCalled();
    });

    it('switching the mode picker calls lockKbDocumentAction with the new mode', async () => {
        lockActionMock.mockResolvedValueOnce({
            success: true,
            data: {
                id: 'doc-1',
                workId: 'work-1',
                path: 'brand/voice.md',
                locked: true,
                lockMode: 'additions-only',
            },
        });
        render(<KbLockControls doc={doc({ locked: true, lockMode: 'full' })} />);
        const mode = screen.getByTestId('kb-side-panel-lock-mode') as HTMLSelectElement;
        fireEvent.change(mode, { target: { value: 'additions-only' } });

        expect(lockActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            path: 'brand/voice.md',
            mode: 'additions-only',
        });
        await waitFor(() => {
            expect(routerRefreshMock).toHaveBeenCalled();
        });
        expect(screen.getByTestId('kb-side-panel-lock').getAttribute('data-kb-lock-mode')).toBe(
            'additions-only',
        );
    });

    it('mode picker ignores changes while unlocked', () => {
        render(<KbLockControls doc={doc({ locked: false })} />);
        const mode = screen.getByTestId('kb-side-panel-lock-mode') as HTMLSelectElement;
        // jsdom still fires the change event even on a disabled select
        // (React doesn't synthesize a guard); the component-level guard
        // is the one we want to verify.
        fireEvent.change(mode, { target: { value: 'additions-only' } });
        expect(lockActionMock).not.toHaveBeenCalled();
    });
});
