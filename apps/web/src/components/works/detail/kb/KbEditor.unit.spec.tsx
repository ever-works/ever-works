import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Tiptap pulls in ProseMirror which doesn't play well with jsdom in
// the harness — stub the bits this unit test cares about so the spec
// focuses on the wiring (save action, status pill, debounce, selectors)
// rather than re-asserting Tiptap's own behaviour.
//
// `editorMock.storage.markdown.getMarkdown()` is the lossless markdown
// round-trip the editor uses on save. `editorMock.on('update', cb)`
// captures the autosave listener so tests can fire a synthetic edit.
let mockMarkdown = '';
type Listener = () => void;
const updateListeners = new Set<Listener>();
const editorMock = {
    storage: {
        markdown: { getMarkdown: () => mockMarkdown },
    },
    on: (event: string, cb: Listener) => {
        if (event === 'update') updateListeners.add(cb);
    },
    off: (event: string, cb: Listener) => {
        if (event === 'update') updateListeners.delete(cb);
    },
};
function fireEditorUpdate() {
    updateListeners.forEach((cb) => cb());
}

vi.mock('@tiptap/react', () => ({
    useEditor: () => editorMock,
    EditorContent: ({ editor: _editor }: { editor: unknown }) => (
        <div data-testid="kb-editor-body" contentEditable />
    ),
    // WikiLinkExtension (row 16b) imports `Extension` from
    // `@tiptap/react` (which re-exports `@tiptap/core`). Provide a
    // minimal shape so the spec doesn't drag in the real Tiptap
    // create-time helpers.
    Extension: { create: () => ({ configure: () => ({}) }) },
    ReactRenderer: class {
        element = null;
        ref = null;
        updateProps() {}
        destroy() {}
    },
}));
vi.mock('@tiptap/starter-kit', () => ({
    default: { configure: () => ({}) },
}));
vi.mock('@tiptap/extension-link', () => ({
    default: { configure: () => ({}) },
}));
vi.mock('@tiptap/suggestion', () => ({
    default: () => ({}),
}));
vi.mock('@tiptap/pm/state', () => ({
    PluginKey: class {
        constructor(name?: string) {
            this.name = name;
        }
        name?: string;
    },
}));
vi.mock('tiptap-markdown', () => ({
    Markdown: { configure: () => ({}) },
}));

// Button is a simple shadcn wrapper. Stub it so the test doesn't pull
// in @radix-ui's slot logic just to render a click target.
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

const updateActionMock = vi.fn();
vi.mock('@/app/actions/works/kb-document', () => ({
    updateKbDocumentAction: (...args: unknown[]) => updateActionMock(...args),
}));

import { KbEditor } from './KbEditor';
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
        body: '# Voice\n\nClear, confident.',
        assets: [],
        ...overrides,
    };
}

/**
 * EW-641 Phase 1B/d row 6 — `KbEditor` adds debounced autosave +
 * dirty/saved indicator on top of the row 5 manual save. These tests
 * cover both: render shape, manual save path, locked behaviour, debounce
 * coalescing, dirty → saving → saved transitions, error pill text,
 * and the "no-op skip" when the body hasn't actually changed.
 */
describe('KbEditor', () => {
    beforeEach(() => {
        updateActionMock.mockReset();
        updateListeners.clear();
        mockMarkdown = '# Voice\n\nClear, confident.'; // matches the initial doc body
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the editor body, header chips, and save button', () => {
        render(<KbEditor workId="work-1" doc={doc()} />);
        expect(screen.getByTestId('kb-editor')).toBeTruthy();
        expect(screen.getByTestId('kb-editor-body')).toBeTruthy();
        const save = screen.getByTestId('kb-editor-save');
        expect(save).toBeTruthy();
        expect(save.getAttribute('disabled')).toBeNull();

        const meta = screen.getByTestId('kb-document-meta');
        expect(meta.textContent).toContain('classes.brand');
        expect(meta.textContent).toContain('status.active');
        expect(meta.textContent).toContain('brand/voice.md');

        // No autosave listener should be wired when no edits have happened —
        // but the component must have subscribed exactly once.
        expect(updateListeners.size).toBe(1);
    });

    it('renders the additions-only banner only when locked && lockMode === additions-only', () => {
        // Unlocked → no banner.
        const { unmount } = render(<KbEditor workId="work-1" doc={doc()} />);
        expect(screen.queryByTestId('kb-editor-lock-banner')).toBeNull();
        unmount();

        // Locked in `full` mode → also no banner (the route already swaps
        // KbEditor for KbDocumentView in that case; the guard is belt + braces).
        const { unmount: u2 } = render(
            <KbEditor workId="work-1" doc={doc({ locked: true, lockMode: 'full' })} readOnly />,
        );
        expect(screen.queryByTestId('kb-editor-lock-banner')).toBeNull();
        u2();

        // Locked in additions-only → banner appears.
        render(
            <KbEditor workId="work-1" doc={doc({ locked: true, lockMode: 'additions-only' })} />,
        );
        const banner = screen.getByTestId('kb-editor-lock-banner');
        expect(banner.getAttribute('data-mode')).toBe('additions-only');
        expect(banner.getAttribute('role')).toBe('status');
        expect(banner.textContent).toContain('editor.additionsOnlyBanner');
    });

    it('disables the save button when readOnly is set + skips the update listener', () => {
        render(<KbEditor workId="work-1" doc={doc({ locked: true, lockMode: 'full' })} readOnly />);
        const save = screen.getByTestId('kb-editor-save') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        const lockEl = screen.getByTestId('kb-document-meta').querySelector('[data-locked="true"]');
        expect(lockEl).not.toBeNull();
        // readOnly = no autosave subscription (it'd never save anyway).
        expect(updateListeners.size).toBe(0);
    });

    it('PATCHes the body via the server action and flips the status to saved (manual)', async () => {
        mockMarkdown = '# Voice\n\nUpdated body.';
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ body: mockMarkdown }),
        });
        render(<KbEditor workId="work-1" doc={doc()} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-editor-save'));
        });

        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledTimes(1);
        });
        expect(updateActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            body: { body: '# Voice\n\nUpdated body.' },
        });

        await waitFor(() => {
            const pill = screen.getByTestId('kb-editor-status');
            expect(pill.getAttribute('data-status')).toBe('saved');
        });
    });

    it('surfaces the action error on the status pill', async () => {
        mockMarkdown = '# Voice\n\nUpdated body.';
        updateActionMock.mockResolvedValueOnce({ success: false, error: 'boom' });
        render(<KbEditor workId="work-1" doc={doc()} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-editor-save'));
        });

        await waitFor(() => {
            const pill = screen.getByTestId('kb-editor-status');
            expect(pill.getAttribute('data-status')).toBe('error');
            expect(pill.textContent).toBe('boom');
        });
    });

    it('exposes the docId + path via data attributes (for e2e selectors)', () => {
        render(<KbEditor workId="work-1" doc={doc({ id: 'abc-123', path: 'legal/privacy.md' })} />);
        const root = screen.getByTestId('kb-editor');
        expect(root.getAttribute('data-doc-id')).toBe('abc-123');
        expect(root.getAttribute('data-doc-path')).toBe('legal/privacy.md');
    });

    it('shows `dirty` immediately on edit, then autosaves after the debounce', async () => {
        vi.useFakeTimers();
        mockMarkdown = '# Voice\n\nedited';
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ body: mockMarkdown }),
        });
        render(<KbEditor workId="work-1" doc={doc()} autosaveDebounceMs={500} />);

        // Synthesise an editor edit.
        act(() => {
            fireEditorUpdate();
        });
        expect(screen.getByTestId('kb-editor-status').getAttribute('data-status')).toBe('dirty');

        // Advance halfway → still dirty, no save yet.
        await act(async () => {
            vi.advanceTimersByTime(300);
        });
        expect(updateActionMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('kb-editor-status').getAttribute('data-status')).toBe('dirty');

        // Cross the debounce threshold → save fires.
        await act(async () => {
            vi.advanceTimersByTime(300);
            await vi.runAllTimersAsync();
        });
        expect(updateActionMock).toHaveBeenCalledTimes(1);

        // Swap back to real timers so waitFor's polling actually
        // advances — under fake timers waitFor never re-checks and
        // the test times out.
        vi.useRealTimers();
        await waitFor(() => {
            expect(screen.getByTestId('kb-editor-status').getAttribute('data-status')).toBe(
                'saved',
            );
        });
    });

    it('coalesces rapid edits into a single autosave (debounce reset)', async () => {
        vi.useFakeTimers();
        mockMarkdown = '# Voice\n\nedit';
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ body: mockMarkdown }),
        });
        render(<KbEditor workId="work-1" doc={doc()} autosaveDebounceMs={500} />);

        // Three rapid edits within the debounce window.
        for (let i = 0; i < 3; i += 1) {
            act(() => {
                fireEditorUpdate();
            });
            await act(async () => {
                vi.advanceTimersByTime(200);
            });
        }
        // 3 × 200ms = 600ms of fake time elapsed but the last edit reset
        // the timer twice, so total wait since last edit < 500ms → no save.
        expect(updateActionMock).not.toHaveBeenCalled();

        // Settle past the debounce now.
        await act(async () => {
            vi.advanceTimersByTime(500);
            await vi.runAllTimersAsync();
        });
        expect(updateActionMock).toHaveBeenCalledTimes(1);
    });

    it('skips the save when the body matches the last-saved value', async () => {
        vi.useFakeTimers();
        // mockMarkdown still equals the initial doc body → flush should
        // settle back to `idle` without calling the server action.
        render(<KbEditor workId="work-1" doc={doc()} autosaveDebounceMs={500} />);

        act(() => {
            fireEditorUpdate();
        });
        await act(async () => {
            vi.advanceTimersByTime(600);
            await vi.runAllTimersAsync();
        });
        expect(updateActionMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('kb-editor-status').getAttribute('data-status')).toBe('idle');
    });
});
