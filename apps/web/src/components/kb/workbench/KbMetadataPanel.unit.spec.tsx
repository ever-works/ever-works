import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        return `${key}:${JSON.stringify(vars)}`;
    },
}));

const updateActionMock = vi.fn();
const lockActionMock = vi.fn();
const unlockActionMock = vi.fn();

vi.mock('@/app/actions/works/kb-document', () => ({
    updateKbDocumentAction: (...args: unknown[]) => updateActionMock(...args),
}));
vi.mock('@/app/actions/works/kb-lock', () => ({
    lockKbDocumentAction: (...args: unknown[]) => lockActionMock(...args),
    unlockKbDocumentAction: (...args: unknown[]) => unlockActionMock(...args),
}));

// Stub the slice-E Git history modal — its real dependency chain
// (shared `Dialog` → `next-intl` navigation) trips Vitest module
// resolution under the worktree's pnpm hoist. The metadata spec only
// needs to verify the trigger button exists; the modal itself has its
// own dedicated unit spec.
vi.mock('./KbGitHistoryModal', () => ({
    KbGitHistoryModal: () => null,
}));

import { KbMetadataPanel } from './KbMetadataPanel';
import type { KbDocumentDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-1',
        workId: 'work-1',
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Brand voice',
        description: null,
        class: 'brand',
        tags: ['voice'],
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

describe('KbMetadataPanel', () => {
    beforeEach(() => {
        updateActionMock.mockReset();
        lockActionMock.mockReset();
        unlockActionMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders every required field on mount', () => {
        render(<KbMetadataPanel workId="work-1" document={doc()} />);
        expect(screen.getByTestId('kb-workbench-metadata-class')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-tags')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-description')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-status')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-lock')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-language')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-source')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-metadata-history-button')).toBeTruthy();
    });

    it('renders an enabled "View Git history" button wired to the history modal', () => {
        render(<KbMetadataPanel workId="work-1" document={doc()} />);
        const btn = screen.getByTestId('kb-workbench-metadata-history-button') as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
    });

    it('adds a tag on Enter and PATCHes with the new list', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ tags: ['voice', 'new-tag'] }),
        });

        render(
            <KbMetadataPanel workId="work-1" document={doc()} debounceOverrides={{ tagsMs: 0 }} />,
        );

        const input = screen.getByTestId('kb-workbench-metadata-tag-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'new-tag' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                body: { tags: ['voice', 'new-tag'] },
            });
        });
    });

    it('removes a tag via the × button and PATCHes the trimmed list', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ tags: [] }),
        });

        render(
            <KbMetadataPanel workId="work-1" document={doc()} debounceOverrides={{ tagsMs: 0 }} />,
        );

        const remove = screen.getByTestId('kb-workbench-metadata-tag-remove');
        fireEvent.click(remove);

        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                body: { tags: [] },
            });
        });
    });

    it('debounces description PATCH at the configured window', async () => {
        vi.useFakeTimers();
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ description: 'hello' }),
        });

        render(
            <KbMetadataPanel
                workId="work-1"
                document={doc()}
                debounceOverrides={{ descriptionMs: 800 }}
            />,
        );

        const textarea = screen.getByTestId(
            'kb-workbench-metadata-description-input',
        ) as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'hello' } });

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(updateActionMock).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(400);
            await vi.runAllTimersAsync();
        });
        expect(updateActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            body: { description: 'hello' },
        });
    });

    it('PATCHes status synchronously on dropdown change', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ status: 'archived' }),
        });

        render(<KbMetadataPanel workId="work-1" document={doc()} />);

        const select = screen.getByTestId(
            'kb-workbench-metadata-status-select',
        ) as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'archived' } });

        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                body: { status: 'archived' },
            });
        });
    });

    it('locks via lockKbDocumentAction with default full mode and re-enables the mode select', async () => {
        lockActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ locked: true, lockMode: 'full' }),
        });

        const onPatched = vi.fn();
        const { rerender } = render(
            <KbMetadataPanel workId="work-1" document={doc()} onPatched={onPatched} />,
        );

        const toggle = screen.getByTestId('kb-workbench-metadata-lock-toggle') as HTMLInputElement;
        fireEvent.click(toggle);

        await waitFor(() => {
            expect(lockActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'brand/voice.md',
                mode: 'full',
            });
            expect(onPatched).toHaveBeenCalled();
        });

        // Re-render with the locked doc — the LockMode select should
        // now be enabled.
        rerender(
            <KbMetadataPanel
                workId="work-1"
                document={doc({ locked: true, lockMode: 'full' })}
                onPatched={onPatched}
            />,
        );
        const mode = screen.getByTestId('kb-workbench-metadata-lock-mode') as HTMLSelectElement;
        expect(mode.disabled).toBe(false);
    });

    it('unlocks via unlockKbDocumentAction when the toggle goes off', async () => {
        unlockActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ locked: false, lockMode: null }),
        });

        render(
            <KbMetadataPanel workId="work-1" document={doc({ locked: true, lockMode: 'full' })} />,
        );

        const toggle = screen.getByTestId('kb-workbench-metadata-lock-toggle') as HTMLInputElement;
        fireEvent.click(toggle);

        await waitFor(() => {
            expect(unlockActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'brand/voice.md',
            });
        });
    });

    it('switching lock mode while locked re-calls lockKbDocumentAction with the new mode', async () => {
        lockActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ locked: true, lockMode: 'additions-only' }),
        });

        render(
            <KbMetadataPanel workId="work-1" document={doc({ locked: true, lockMode: 'full' })} />,
        );

        const mode = screen.getByTestId('kb-workbench-metadata-lock-mode') as HTMLSelectElement;
        fireEvent.change(mode, { target: { value: 'additions-only' } });

        await waitFor(() => {
            expect(lockActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'brand/voice.md',
                mode: 'additions-only',
            });
        });
    });

    it('surfaces the panel-wide locked banner when a PATCH returns HTTP 423', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: false,
            error: 'HTTP 423: document is locked',
        });

        render(<KbMetadataPanel workId="work-1" document={doc()} />);

        const select = screen.getByTestId(
            'kb-workbench-metadata-status-select',
        ) as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'archived' } });

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-metadata-locked-banner')).toBeTruthy();
        });
    });

    it('clicking a different class chip PATCHes { class }', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ class: 'legal' }),
        });

        render(<KbMetadataPanel workId="work-1" document={doc()} />);

        const chips = screen.getAllByTestId('kb-workbench-metadata-class-chip');
        const legalChip = chips.find((el) => el.getAttribute('data-kb-class') === 'legal');
        expect(legalChip).toBeTruthy();
        fireEvent.click(legalChip!);

        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                body: { class: 'legal' },
            });
        });
    });
});
