// The upload client is mocked — this spec covers what the composer renders and
// hands back, not the XHR in `lib/api/uploads`.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { PromptComposer, buildAttachmentRefs, type ComposerAttachment } from './PromptComposer';

vi.mock('@/lib/api/uploads', () => ({
    uploadFile: vi.fn(() =>
        Promise.resolve({
            id: 'sha256-abc',
            url: '/api/uploads/user-1/sha256-abc.png',
            filename: 'sha256-abc.png',
            size: 4,
            mimeType: 'image/png',
            hash: 'sha256-abc',
        }),
    ),
    UploadError: class UploadError extends Error {},
}));

const TEST_ID = 'pc';

function imageFile(name = 'shot.png') {
    return new File(['png-'], name, { type: 'image/png' });
}
function textFile(name = 'notes.txt') {
    return new File(['hello'], name, { type: 'text/plain' });
}
function pdfFile(name = 'brief.pdf') {
    return new File(['%PDF-'], name, { type: 'application/pdf' });
}
/** A file as the folder picker hands it over: name plus a relative path. */
function folderFile(relativePath: string) {
    const file = new File(['x'], relativePath.split('/').pop() ?? relativePath, {
        type: 'text/plain',
    });
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
    return file;
}

/** Controlled wrapper — the composer is a controlled input. */
function Harness(props: { readonly initial?: string } = {}) {
    const [value, setValue] = useState(props.initial ?? '');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    return (
        <>
            <PromptComposer
                value={value}
                onChange={setValue}
                onSubmit={() => undefined}
                ariaLabel="Describe your work"
                testId={TEST_ID}
                showImportGithubRepo
                onAttachmentsChange={setAttachments}
            />
            <output data-testid="ref-count">{buildAttachmentRefs(attachments).length}</output>
        </>
    );
}

beforeEach(() => {
    // jsdom implements neither of these.
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview');
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('PromptComposer attachments', () => {
    it('renders a picked image as a clickable thumbnail, not a filename chip', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-image-input`), {
            target: { files: [imageFile()] },
        });

        const tile = await screen.findByLabelText('Preview shot.png');
        const thumb = tile.querySelector('img');
        expect(thumb).toBeTruthy();
        expect(thumb).toHaveAttribute('src', 'blob:mock-preview');
    });

    it('opens the full-size lightbox when the thumbnail is clicked, and closes on Escape', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-image-input`), {
            target: { files: [imageFile('diagram.png')] },
        });
        fireEvent.click(await screen.findByLabelText('Preview diagram.png'));

        const lightbox = await screen.findByTestId(`${TEST_ID}-lightbox`);
        expect(lightbox).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByTestId(`${TEST_ID}-lightbox-image`)).toHaveAttribute(
            'alt',
            'diagram.png',
        );

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() =>
            expect(screen.queryByTestId(`${TEST_ID}-lightbox`)).not.toBeInTheDocument(),
        );
    });

    it('steps through multiple images with the arrow keys', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-image-input`), {
            target: { files: [imageFile('one.png'), imageFile('two.png')] },
        });
        fireEvent.click(await screen.findByLabelText('Preview one.png'));

        expect(screen.getByTestId(`${TEST_ID}-lightbox-image`)).toHaveAttribute('alt', 'one.png');
        fireEvent.keyDown(document, { key: 'ArrowRight' });
        await waitFor(() =>
            expect(screen.getByTestId(`${TEST_ID}-lightbox-image`)).toHaveAttribute(
                'alt',
                'two.png',
            ),
        );
    });

    it('renders a document as a typed card and exposes it as a ref once uploaded', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-file-input`), {
            target: { files: [pdfFile()] },
        });

        // Ready only after the mocked upload resolves — an in-flight upload is
        // never forwarded to callers.
        const card = await screen.findByTestId(`${TEST_ID}-attachment-ready`);
        expect(card).toHaveTextContent('brief.pdf');
        expect(card).toHaveTextContent(/PDF · \d+ B/);
        // A PDF cannot be rendered in-app, so it offers a download instead.
        expect(screen.queryByLabelText('Preview brief.pdf')).toBeNull();
        expect(screen.getByLabelText('Download brief.pdf')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByTestId('ref-count')).toHaveTextContent('1'));
    });

    it('previews a text document from the local file, without waiting on the upload', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-file-input`), {
            target: { files: [textFile()] },
        });
        fireEvent.click(await screen.findByLabelText('Preview notes.txt'));

        const pane = await screen.findByTestId(`${TEST_ID}-lightbox-text`);
        await waitFor(() => expect(pane).toHaveTextContent('hello'));
    });

    it('collapses a picked folder into one expandable card', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-folder-input`), {
            target: {
                files: [folderFile('docs/intro.md'), folderFile('docs/guides/setup.md')],
            },
        });

        const card = await screen.findByTestId(`${TEST_ID}-attachment-folder`);
        expect(card).toHaveTextContent('docs');
        // Collapsed: the individual paths are not on screen yet.
        expect(screen.queryByText('guides/setup.md')).toBeNull();

        fireEvent.click(screen.getByLabelText('Expand folder docs'));
        expect(await screen.findByText('guides/setup.md')).toBeInTheDocument();
        expect(screen.getByText('intro.md')).toBeInTheDocument();

        // Removing the folder removes every file it contributed.
        fireEvent.click(screen.getByLabelText('Remove folder docs'));
        await waitFor(() =>
            expect(screen.queryByTestId(`${TEST_ID}-attachment-folder`)).not.toBeInTheDocument(),
        );
    });

    it('attaches a pasted screenshot', async () => {
        render(<Harness />);

        fireEvent.paste(screen.getByTestId(TEST_ID), {
            clipboardData: { types: ['Files'], files: [imageFile('pasted.png')], items: [] },
        });

        expect(await screen.findByLabelText('Preview pasted.png')).toBeInTheDocument();
    });

    it('attaches dropped files and shows the drop hint while dragging', async () => {
        render(<Harness />);
        const card = screen.getByTestId(TEST_ID).parentElement as HTMLElement;

        fireEvent.dragEnter(card, { dataTransfer: { types: ['Files'], items: [], files: [] } });
        expect(await screen.findByTestId(`${TEST_ID}-dropzone`)).toBeInTheDocument();

        fireEvent.drop(card, {
            dataTransfer: { types: ['Files'], files: [imageFile('dropped.png')], items: [] },
        });

        expect(await screen.findByLabelText('Preview dropped.png')).toBeInTheDocument();
        expect(screen.queryByTestId(`${TEST_ID}-dropzone`)).not.toBeInTheDocument();
    });

    it('removes an attachment and revokes its preview URL', async () => {
        render(<Harness />);

        fireEvent.change(screen.getByTestId(`${TEST_ID}-image-input`), {
            target: { files: [imageFile('gone.png')] },
        });
        fireEvent.click(await screen.findByLabelText('Remove gone.png'));

        await waitFor(() => expect(screen.queryByLabelText('Preview gone.png')).toBeNull());
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview');
    });
});

interface FakeSpeechEvent {
    resultIndex: number;
    results: { length: number; [index: number]: unknown };
}

class FakeRecognition {
    static instances: FakeRecognition[] = [];
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ((event: FakeSpeechEvent) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
        FakeRecognition.instances.push(this);
    }
    start() {}
    stop() {}
}

function emit(final: string) {
    const rec = FakeRecognition.instances.at(-1);
    act(() => {
        rec?.onresult?.({
            resultIndex: 0,
            results: { length: 1, 0: { isFinal: true, 0: { transcript: final } } },
        });
    });
}

describe('PromptComposer dictation', () => {
    beforeEach(() => {
        FakeRecognition.instances = [];
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
    });
    afterEach(() => {
        const w = window as unknown as {
            SpeechRecognition?: unknown;
            webkitSpeechRecognition?: unknown;
        };
        delete w.SpeechRecognition;
        delete w.webkitSpeechRecognition;
    });

    it('swaps the toolbar for the dictation bar while listening', async () => {
        render(<Harness />);
        fireEvent.click(await screen.findByTestId(`${TEST_ID}-mic`));

        expect(await screen.findByTestId(`${TEST_ID}-voice-bar`)).toBeInTheDocument();
        // Send is replaced by keep/discard — recording is a mode, not a toggle.
        expect(screen.queryByTestId(`${TEST_ID}-submit`)).toBeNull();
        expect(screen.getByTestId(`${TEST_ID}-voice-done`)).toBeInTheDocument();
        // No getUserMedia in jsdom, so the live meter degrades to static bars.
        expect(screen.getByTestId(`${TEST_ID}-voice-static`)).toBeInTheDocument();
        expect(screen.getByText('Listening…')).toHaveClass('sr-only');
    });

    it('appends final transcripts and puts the prompt back on discard', async () => {
        render(<Harness initial="Build me" />);
        fireEvent.click(await screen.findByTestId(`${TEST_ID}-mic`));

        emit('a directory of AI tools');
        const textarea = screen.getByTestId(TEST_ID) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('Build me a directory of AI tools'));

        fireEvent.click(screen.getByTestId(`${TEST_ID}-voice-cancel`));
        await waitFor(() => expect(textarea.value).toBe('Build me'));
    });

    it('falls back to webkitSpeechRecognition on browsers without the standard name', async () => {
        const w = window as unknown as {
            SpeechRecognition?: unknown;
            webkitSpeechRecognition?: unknown;
        };
        delete w.SpeechRecognition;
        w.webkitSpeechRecognition = FakeRecognition;

        render(<Harness />);
        fireEvent.click(await screen.findByTestId(`${TEST_ID}-mic`));

        emit('a pricing page');
        const textarea = screen.getByTestId(TEST_ID) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('a pricing page'));
    });

    it('keeps the transcript when dictation is confirmed', async () => {
        render(<Harness />);
        fireEvent.click(await screen.findByTestId(`${TEST_ID}-mic`));

        emit('a landing page');
        fireEvent.click(screen.getByTestId(`${TEST_ID}-voice-done`));

        const textarea = screen.getByTestId(TEST_ID) as HTMLTextAreaElement;
        await waitFor(() => expect(textarea.value).toBe('a landing page'));
        expect(screen.queryByTestId(`${TEST_ID}-voice-bar`)).toBeNull();
    });
});
