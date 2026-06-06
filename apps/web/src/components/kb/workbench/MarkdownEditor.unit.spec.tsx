import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const updateActionMock = vi.fn();
vi.mock('@/app/actions/works/kb-document', () => ({
    updateKbDocumentAction: (...args: unknown[]) => updateActionMock(...args),
}));

// react-markdown is heavy under jsdom and not relevant to the autosave
// wiring; stub it to a simple pass-through container.
vi.mock('react-markdown', () => ({
    default: ({ children }: { children?: string }) => (
        <div data-testid="md-preview-stub">{children}</div>
    ),
}));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

import { MarkdownEditor } from './MarkdownEditor';
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

describe('workbench MarkdownEditor', () => {
    beforeEach(() => {
        updateActionMock.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the textarea + preview pane', () => {
        render(<MarkdownEditor workId="work-1" document={doc()} />);
        expect(screen.getByTestId('kb-workbench-editor')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-editor-textarea')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-editor-preview')).toBeTruthy();
    });

    it('flips to dirty immediately on edit, then autosaves after the debounce', async () => {
        vi.useFakeTimers();
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ body: '# Voice — edited' }),
        });

        render(<MarkdownEditor workId="work-1" document={doc()} autosaveDebounceMs={500} />);

        const textarea = screen.getByTestId('kb-workbench-editor-textarea') as HTMLTextAreaElement;

        act(() => {
            fireEvent.change(textarea, { target: { value: '# Voice — edited' } });
        });
        expect(screen.getByTestId('kb-workbench-editor').getAttribute('data-status')).toBe('dirty');

        // Below the debounce → no save yet.
        await act(async () => {
            vi.advanceTimersByTime(300);
        });
        expect(updateActionMock).not.toHaveBeenCalled();

        // Cross the debounce threshold → save fires with the latest body.
        await act(async () => {
            vi.advanceTimersByTime(300);
            await vi.runAllTimersAsync();
        });
        expect(updateActionMock).toHaveBeenCalledTimes(1);
        expect(updateActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            body: { body: '# Voice — edited' },
        });

        // Swap back to real timers so `waitFor` can poll while the
        // resolved `updateActionMock` microtask drains.
        vi.useRealTimers();
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-editor').getAttribute('data-status')).toBe(
                'saved',
            );
        });
    });

    it('surfaces the 409 conflict banner with a Reload button', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: false,
            error: 'HTTP 409 conflict — version mismatch',
        });
        const onReload = vi.fn();

        render(
            <MarkdownEditor
                workId="work-1"
                document={doc()}
                autosaveDebounceMs={0}
                onReload={onReload}
            />,
        );

        const textarea = screen.getByTestId('kb-workbench-editor-textarea') as HTMLTextAreaElement;
        await act(async () => {
            fireEvent.change(textarea, { target: { value: '# Voice — edited' } });
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-conflict-banner')).toBeTruthy();
        });

        const reloadBtn = screen.getByTestId('kb-workbench-conflict-banner-action');
        act(() => {
            fireEvent.click(reloadBtn);
        });
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('surfaces the 423 locked banner without a Reload action', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: false,
            error: 'HTTP 423: document is locked',
        });

        render(<MarkdownEditor workId="work-1" document={doc()} autosaveDebounceMs={0} />);

        const textarea = screen.getByTestId('kb-workbench-editor-textarea') as HTMLTextAreaElement;
        await act(async () => {
            fireEvent.change(textarea, { target: { value: 'x' } });
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-locked-banner')).toBeTruthy();
        });
        expect(screen.queryByTestId('kb-workbench-locked-banner-action')).toBeNull();
    });

    it('skips the save when nothing meaningful changed', async () => {
        render(<MarkdownEditor workId="work-1" document={doc()} autosaveDebounceMs={0} />);

        const textarea = screen.getByTestId('kb-workbench-editor-textarea') as HTMLTextAreaElement;
        // Same value as the initial body → autosave path runs but
        // short-circuits without calling the action.
        await act(async () => {
            fireEvent.change(textarea, { target: { value: '# Voice' } });
        });
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-editor').getAttribute('data-status')).toBe(
                'idle',
            );
        });
        expect(updateActionMock).not.toHaveBeenCalled();
    });
});
