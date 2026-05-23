import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const refreshMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: refreshMock }),
}));

// shadcn Button → simple <button> stub.
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

// Stub the classify modal so the upload-zone spec stays focused on the
// upload path. The modal exposes Confirm / Cancel buttons that drive the
// `onConfirm` / `onCancel` callbacks; capture the latest `onConfirm` so
// tests can fire it with any KbClassifyResult.
//
// `KbClassifyModal` proper has its own dedicated spec in
// `./KbClassifyModal.unit.spec.tsx`.
let latestOnConfirm: ((result: unknown) => void) | null = null;
let latestOnCancel: (() => void) | null = null;
let latestInitialClass: string | undefined;
vi.mock('./KbClassifyModal', () => ({
    KbClassifyModal: ({
        onConfirm,
        onCancel,
        initialClass,
    }: {
        onConfirm: (result: unknown) => void;
        onCancel: () => void;
        initialClass?: string;
    }) => {
        latestOnConfirm = onConfirm;
        latestOnCancel = onCancel;
        latestInitialClass = initialClass;
        return (
            <div data-testid="kb-classify-modal">
                <button
                    type="button"
                    data-testid="kb-classify-confirm"
                    onClick={() =>
                        onConfirm({
                            targetClass: initialClass ?? 'freeform',
                            description: '',
                            tags: [],
                            titles: {},
                        })
                    }
                >
                    confirm
                </button>
                <button type="button" data-testid="kb-classify-cancel" onClick={onCancel}>
                    cancel
                </button>
            </div>
        );
    },
}));

import { KbUploadZone } from './KbUploadZone';

/**
 * Minimal `XMLHttpRequest` stand-in: tests resolve uploads
 * synchronously via the captured instance's helper methods. The real
 * XHR pulls in DOM XML / event-target machinery that jsdom only
 * partially supports — and the component only needs the four events
 * (`load`, `error`, `abort`, `upload.progress`) to drive the UI.
 */
class FakeXHR {
    public method = '';
    public url = '';
    public response: unknown = null;
    public status = 0;
    public responseType = '';
    public readonly upload = new EventTarget();
    private readonly self = new EventTarget();

    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }

    send(_body: FormData) {
        // Tests trigger completion via `complete()` / `fail()` /
        // `errorOut()` below — `send` itself is a no-op.
    }

    addEventListener(type: string, cb: EventListener) {
        this.self.addEventListener(type, cb);
    }

    /** Helpers used by the tests. */
    fireProgress(loaded: number, total: number) {
        this.upload.dispatchEvent(
            Object.assign(new Event('progress'), {
                lengthComputable: true,
                loaded,
                total,
            }) as Event,
        );
    }
    complete(response: unknown, status = 201) {
        this.response = response;
        this.status = status;
        this.self.dispatchEvent(new Event('load'));
    }
    fail(response: unknown, status: number) {
        this.response = response;
        this.status = status;
        this.self.dispatchEvent(new Event('load'));
    }
    errorOut() {
        this.self.dispatchEvent(new Event('error'));
    }
}

const xhrInstances: FakeXHR[] = [];

beforeEach(() => {
    refreshMock.mockReset();
    xhrInstances.length = 0;
    latestOnConfirm = null;
    latestOnCancel = null;
    latestInitialClass = undefined;
    vi.stubGlobal('XMLHttpRequest', function FakeXHRCtor() {
        const x = new FakeXHR();
        xhrInstances.push(x);
        return x;
    } as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function fileLike(name: string, contents = 'hello'): File {
    return new File([contents], name, { type: 'text/markdown' });
}

/**
 * After picking files, the zone opens the classify modal. Helper that
 * resolves both the synthetic file pick + the modal confirm so each
 * test's assertions read top-to-bottom.
 */
async function pickAndConfirm(file: File, classify?: Record<string, unknown>) {
    await act(async () => {
        fireEvent.change(screen.getByTestId('kb-upload-input'), {
            target: { files: [file] },
        });
    });
    await waitFor(() => expect(screen.getByTestId('kb-classify-modal')).toBeTruthy());
    await act(async () => {
        if (classify) {
            latestOnConfirm?.(classify);
        } else {
            fireEvent.click(screen.getByTestId('kb-classify-confirm'));
        }
    });
}

/**
 * EW-641 Phase 1B/d row 7 + 8 — KbUploadZone tests cover the wiring
 * that Playwright A12 (drag-drop → KB doc) leans on:
 *  - selectors stay stable (`kb-upload-zone`, `kb-upload-input`,
 *    `kb-upload-entries`, `kb-upload-entry` with `data-status`)
 *  - file pick opens the classify modal first; confirming kicks off
 *    the POST with the chosen metadata
 *  - cancelling the modal discards the batch (no XHR fires)
 *  - `data-status` cycles `uploading → succeeded` (or `failed`)
 *  - on success the page revalidates via `router.refresh`
 *  - drag-over flips `data-drag-active`
 */
describe('KbUploadZone', () => {
    it('renders the drop target + hidden file input', () => {
        render(<KbUploadZone workId="work-1" />);
        expect(screen.getByTestId('kb-upload-zone')).toBeTruthy();
        const input = screen.getByTestId('kb-upload-input') as HTMLInputElement;
        expect(input.type).toBe('file');
        expect(input.multiple).toBe(true);
        // No entries yet + no modal open.
        expect(screen.queryByTestId('kb-upload-entries')).toBeNull();
        expect(screen.queryByTestId('kb-classify-modal')).toBeNull();
    });

    it('opens the classify modal when files are picked, then uploads on confirm', async () => {
        render(<KbUploadZone workId="work-1" />);

        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('voice.md')] },
            });
        });

        // Modal opened, no XHR yet.
        expect(screen.getByTestId('kb-classify-modal')).toBeTruthy();
        expect(xhrInstances.length).toBe(0);

        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-classify-confirm'));
        });

        await waitFor(() => expect(xhrInstances.length).toBe(1));
        expect(xhrInstances[0].method).toBe('POST');
        expect(xhrInstances[0].url).toBe('/api/works/work-1/kb/uploads');

        const entry = screen.getByTestId('kb-upload-entry');
        expect(entry.getAttribute('data-status')).toBe('uploading');
        expect(entry.textContent).toContain('voice.md');
    });

    it('discards the batch when the classify modal is cancelled', async () => {
        render(<KbUploadZone workId="work-1" />);
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('voice.md')] },
            });
        });
        expect(screen.getByTestId('kb-classify-modal')).toBeTruthy();

        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-classify-cancel'));
        });

        expect(xhrInstances.length).toBe(0);
        expect(screen.queryByTestId('kb-classify-modal')).toBeNull();
        expect(screen.queryByTestId('kb-upload-entries')).toBeNull();
    });

    it('forwards class + description + tags from the modal as form fields', async () => {
        let capturedBody: FormData | null = null;
        const origSend = FakeXHR.prototype.send;
        FakeXHR.prototype.send = function patched(body: FormData) {
            capturedBody = body;
            return origSend.call(this, body);
        };
        try {
            render(<KbUploadZone workId="work-1" targetClass="brand" />);
            await pickAndConfirm(fileLike('voice.md'), {
                targetClass: 'brand',
                description: 'Brand voice doc',
                tags: ['tier-1', 'audience-us'],
                titles: { 0: 'Voice' },
            });
            await waitFor(() => expect(xhrInstances.length).toBe(1));
            expect(capturedBody).not.toBeNull();
            expect(capturedBody!.get('targetClass')).toBe('brand');
            expect(capturedBody!.get('title')).toBe('Voice');
            expect(capturedBody!.get('description')).toBe('Brand voice doc');
            expect(capturedBody!.getAll('tags')).toEqual(['tier-1', 'audience-us']);
            expect((capturedBody!.get('file') as File).name).toBe('voice.md');
        } finally {
            FakeXHR.prototype.send = origSend;
        }
    });

    it('passes targetClass through to the modal as initialClass', async () => {
        render(<KbUploadZone workId="work-1" targetClass="legal" />);
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('privacy.md')] },
            });
        });
        expect(latestInitialClass).toBe('legal');
    });

    it('flips entry to succeeded + calls router.refresh on 201', async () => {
        render(<KbUploadZone workId="work-1" />);
        await pickAndConfirm(fileLike('voice.md'));
        await waitFor(() => expect(xhrInstances.length).toBe(1));

        await act(async () => {
            xhrInstances[0].complete({ upload: { id: 'u-1' }, document: { id: 'd-1' } }, 201);
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-upload-entry').getAttribute('data-status')).toBe(
                'succeeded',
            );
        });
        await Promise.resolve();
        expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('shows the backend error message on failure', async () => {
        render(<KbUploadZone workId="work-1" />);
        await pickAndConfirm(fileLike('big.bin'));
        await waitFor(() => expect(xhrInstances.length).toBe(1));

        await act(async () => {
            xhrInstances[0].fail({ message: 'File too large' }, 413);
        });

        await waitFor(() => {
            const entry = screen.getByTestId('kb-upload-entry');
            expect(entry.getAttribute('data-status')).toBe('failed');
            expect(entry.textContent).toContain('File too large');
        });
        expect(refreshMock).not.toHaveBeenCalled();
    });

    it('handles network errors with a generic message', async () => {
        render(<KbUploadZone workId="work-1" />);
        await pickAndConfirm(fileLike('voice.md'));
        await waitFor(() => expect(xhrInstances.length).toBe(1));

        await act(async () => {
            xhrInstances[0].errorOut();
        });

        await waitFor(() => {
            const entry = screen.getByTestId('kb-upload-entry');
            expect(entry.getAttribute('data-status')).toBe('failed');
            expect(entry.textContent).toContain('Network error');
        });
    });

    it('reflects upload progress on the status pill', async () => {
        render(<KbUploadZone workId="work-1" />);
        await pickAndConfirm(fileLike('voice.md'));
        await waitFor(() => expect(xhrInstances.length).toBe(1));

        await act(async () => {
            xhrInstances[0].fireProgress(50, 200);
        });
        const entry = screen.getByTestId('kb-upload-entry');
        expect(entry.getAttribute('data-status')).toBe('uploading');
        expect(entry.textContent).toContain('25%'); // 50/200
    });

    it('flips data-drag-active when dragging files over the zone', async () => {
        render(<KbUploadZone workId="work-1" />);
        const zone = screen.getByTestId('kb-upload-zone');
        expect(zone.getAttribute('data-drag-active')).toBe('false');

        await act(async () => {
            fireEvent.dragEnter(zone);
        });
        expect(zone.getAttribute('data-drag-active')).toBe('true');

        await act(async () => {
            fireEvent.dragLeave(zone);
        });
        expect(zone.getAttribute('data-drag-active')).toBe('false');
    });
});
