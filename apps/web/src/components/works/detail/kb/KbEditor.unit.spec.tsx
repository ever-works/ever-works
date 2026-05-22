import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Tiptap pulls in ProseMirror which doesn't play well with jsdom in
// the harness — stub the bits this unit test cares about so the spec
// focuses on the wiring (save action, status pill, selectors) rather
// than re-asserting Tiptap's own behaviour. The mock exposes a real
// `storage.markdown.getMarkdown()` so the save path round-trips.
let mockMarkdown = '';
vi.mock('@tiptap/react', () => ({
    useEditor: () => ({
        storage: {
            markdown: { getMarkdown: () => mockMarkdown },
        },
    }),
    EditorContent: ({ editor: _editor }: { editor: unknown }) => (
        <div data-testid="kb-editor-body" contentEditable />
    ),
}));
vi.mock('@tiptap/starter-kit', () => ({
    default: { configure: () => ({}) },
}));
vi.mock('@tiptap/extension-link', () => ({
    default: { configure: () => ({}) },
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
 * EW-641 Phase 1B/d row 5 — `KbEditor` glues Tiptap to the
 * `updateKbDocumentAction` server action. These tests exercise the
 * wiring rather than Tiptap itself: render shape, save click triggers
 * the action with the markdown round-trip output, status pill flips
 * `idle → saving → saved | error`, locked docs disable the save
 * button. Tiptap's own behaviour stays out of scope.
 */
describe('KbEditor', () => {
    beforeEach(() => {
        updateActionMock.mockReset();
        mockMarkdown = '# Voice\n\nUpdated body.';
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
    });

    it('disables the save button when readOnly is set', () => {
        render(<KbEditor workId="work-1" doc={doc({ locked: true, lockMode: 'full' })} readOnly />);
        const save = screen.getByTestId('kb-editor-save') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        const lockEl = screen.getByTestId('kb-document-meta').querySelector('[data-locked="true"]');
        expect(lockEl).not.toBeNull();
    });

    it('PATCHes the body via the server action and flips the status to saved', async () => {
        updateActionMock.mockResolvedValueOnce({ success: true, data: doc() });
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
});
