// The upload client is mocked — this spec covers what the chat composer's
// attachment strip renders and opens, not the XHR in `lib/api/uploads`.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

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

import { ChatAttachButton, ChatAttachmentChips, useChatAttachments } from './ChatAttachments';

function imageFile(name = 'shot.png') {
    return new File(['png-'], name, { type: 'image/png' });
}
function textFile(name = 'notes.txt') {
    return new File(['hello'], name, { type: 'text/plain' });
}
function pdfFile(name = 'brief.pdf') {
    return new File(['%PDF-'], name, { type: 'application/pdf' });
}
/** Over the 25 MB cap, so it lands with an error but still has a thumbnail. */
function oversizeImage(name = 'huge.png') {
    const file = imageFile(name);
    Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });
    return file;
}

function Harness() {
    const { items, addFiles, remove } = useChatAttachments();
    return (
        <>
            <ChatAttachButton onFiles={addFiles} />
            <ChatAttachmentChips items={items} onRemove={remove} />
        </>
    );
}

function pick(...files: File[]) {
    fireEvent.change(screen.getByTestId('chat-attachment-input'), { target: { files } });
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

describe('ChatAttachmentChips', () => {
    it('shows a picked image as a thumbnail and opens it full size', async () => {
        render(<Harness />);
        pick(imageFile());

        const chip = await screen.findByTestId('chat-attachment-preview');
        expect(chip.querySelector('img')).toHaveAttribute('src', 'blob:mock-preview');

        fireEvent.click(chip);

        const lightbox = await screen.findByTestId('chat-attachment-lightbox');
        expect(lightbox).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByTestId('chat-attachment-lightbox-image')).toHaveAttribute(
            'alt',
            'shot.png',
        );
    });

    it('closes the preview on Escape', async () => {
        render(<Harness />);
        pick(imageFile());
        fireEvent.click(await screen.findByTestId('chat-attachment-preview'));
        await screen.findByTestId('chat-attachment-lightbox');

        fireEvent.keyDown(document, { key: 'Escape' });

        await waitFor(() =>
            expect(screen.queryByTestId('chat-attachment-lightbox')).not.toBeInTheDocument(),
        );
    });

    it('reads a text document off the local file rather than waiting on the upload', async () => {
        render(<Harness />);
        pick(textFile());
        fireEvent.click(await screen.findByTestId('chat-attachment-preview'));

        const pane = await screen.findByTestId('chat-attachment-lightbox-text');
        await waitFor(() => expect(pane).toHaveTextContent('hello'));
    });

    it('steps between previewable attachments with the arrow keys', async () => {
        render(<Harness />);
        pick(imageFile('one.png'), imageFile('two.png'));

        fireEvent.click((await screen.findAllByTestId('chat-attachment-preview'))[0]);
        expect(screen.getByTestId('chat-attachment-lightbox-image')).toHaveAttribute(
            'alt',
            'one.png',
        );

        fireEvent.keyDown(document, { key: 'ArrowRight' });
        await waitFor(() =>
            expect(screen.getByTestId('chat-attachment-lightbox-image')).toHaveAttribute(
                'alt',
                'two.png',
            ),
        );
    });

    // A failed attachment's chip offers no preview button, so the overlay's
    // arrow keys must not be able to reach it either — otherwise a file the
    // strip says cannot be opened opens anyway, one keypress sideways.
    it('keeps a failed attachment out of the arrow-key sequence', async () => {
        render(<Harness />);
        pick(imageFile('ok.png'), oversizeImage());

        await waitFor(() => expect(screen.getAllByTestId('chat-attachment-chip')).toHaveLength(2));
        expect(screen.getAllByTestId('chat-attachment-preview')).toHaveLength(1);

        fireEvent.click(screen.getByTestId('chat-attachment-preview'));
        fireEvent.keyDown(document, { key: 'ArrowRight' });

        await waitFor(() =>
            expect(screen.getByTestId('chat-attachment-lightbox-image')).toHaveAttribute(
                'alt',
                'ok.png',
            ),
        );
    });

    // The uploads API serves attachments with a non-inline disposition and the
    // app's CSP blocks `blob:` frames, so a PDF chip must stay inert instead of
    // opening an overlay with nothing honest to show.
    it('does not offer a preview for a file it cannot render', async () => {
        render(<Harness />);
        pick(pdfFile());

        expect(await screen.findByTestId('chat-attachment-chip')).toHaveTextContent('brief.pdf');
        expect(screen.queryByTestId('chat-attachment-preview')).toBeNull();
    });

    it('revokes the object URL when an attachment is removed', async () => {
        render(<Harness />);
        pick(imageFile('gone.png'));
        await screen.findByTestId('chat-attachment-chip');

        fireEvent.click(screen.getByTestId('chat-attachment-remove'));

        await waitFor(() => expect(screen.queryByTestId('chat-attachment-chip')).toBeNull());
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview');
    });
});
