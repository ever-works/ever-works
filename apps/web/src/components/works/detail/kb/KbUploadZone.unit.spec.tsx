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
    // Replace the global XMLHttpRequest with our stub for the duration
    // of the test. `globalThis` is the right surface — jsdom's
    // `window.XMLHttpRequest` and `globalThis.XMLHttpRequest` point at
    // the same constructor.
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
 * EW-641 Phase 1B/d row 7 — KbUploadZone tests cover the wiring that
 * the Playwright A12 (drag-drop → KB doc) acceptance suite leans on:
 *  - selectors stay stable (`kb-upload-zone`, `kb-upload-input`,
 *    `kb-upload-entries`, `kb-upload-entry` with `data-status`)
 *  - file pick + drop both kick off a POST to `/api/works/.../kb/uploads`
 *  - `data-status` on the entry cycles `uploading → succeeded` (or `failed`)
 *  - on success the page revalidates via `router.refresh` so the
 *    server-rendered `<KbTreePanel>` sees the new document
 *  - drag-over flips the `data-drag-active` flag for styling cues
 */
describe('KbUploadZone', () => {
    it('renders the drop target + hidden file input', () => {
        render(<KbUploadZone workId="work-1" />);
        expect(screen.getByTestId('kb-upload-zone')).toBeTruthy();
        const input = screen.getByTestId('kb-upload-input') as HTMLInputElement;
        expect(input.type).toBe('file');
        expect(input.multiple).toBe(true);
        // No entries yet.
        expect(screen.queryByTestId('kb-upload-entries')).toBeNull();
    });

    it('starts an upload when files are selected via the input', async () => {
        render(<KbUploadZone workId="work-1" />);
        const input = screen.getByTestId('kb-upload-input') as HTMLInputElement;

        await act(async () => {
            fireEvent.change(input, { target: { files: [fileLike('voice.md')] } });
        });

        // XHR opened against the proxied Next.js route.
        await waitFor(() => expect(xhrInstances.length).toBe(1));
        expect(xhrInstances[0].method).toBe('POST');
        expect(xhrInstances[0].url).toBe('/api/works/work-1/kb/uploads');

        // Entry rendered with status="uploading".
        const entry = screen.getByTestId('kb-upload-entry');
        expect(entry.getAttribute('data-status')).toBe('uploading');
        expect(entry.textContent).toContain('voice.md');
    });

    it('forwards targetClass as a form field when the prop is set', async () => {
        // We can't read the FormData out of `send` easily without
        // exposing it on the stub — extend the stub on the fly.
        let capturedBody: FormData | null = null;
        const origSend = FakeXHR.prototype.send;
        FakeXHR.prototype.send = function patched(body: FormData) {
            capturedBody = body;
            return origSend.call(this, body);
        };
        try {
            render(<KbUploadZone workId="work-1" targetClass="brand" />);
            await act(async () => {
                fireEvent.change(screen.getByTestId('kb-upload-input'), {
                    target: { files: [fileLike('voice.md')] },
                });
            });
            await waitFor(() => expect(xhrInstances.length).toBe(1));
            expect(capturedBody).not.toBeNull();
            expect(capturedBody!.get('targetClass')).toBe('brand');
            expect((capturedBody!.get('file') as File).name).toBe('voice.md');
        } finally {
            FakeXHR.prototype.send = origSend;
        }
    });

    it('flips entry to succeeded + calls router.refresh on 201', async () => {
        render(<KbUploadZone workId="work-1" />);
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('voice.md')] },
            });
        });
        await waitFor(() => expect(xhrInstances.length).toBe(1));

        await act(async () => {
            xhrInstances[0].complete({ upload: { id: 'u-1' }, document: { id: 'd-1' } }, 201);
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-upload-entry').getAttribute('data-status')).toBe(
                'succeeded',
            );
        });
        // Refresh runs in a microtask — flush once.
        await Promise.resolve();
        expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it('shows the backend error message on failure', async () => {
        render(<KbUploadZone workId="work-1" />);
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('big.bin')] },
            });
        });
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
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('voice.md')] },
            });
        });
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
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-upload-input'), {
                target: { files: [fileLike('voice.md')] },
            });
        });
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
