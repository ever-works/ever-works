// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadError, uploadFile, withUploadServeScope } from './uploads';

/**
 * `uploadFile` is the one browser→BFF call on a raw XMLHttpRequest (upload
 * progress), so it cannot go through `browserApiFetch`; it has to set the
 * selector itself. `setRequestHeader` is only legal between `open()` and
 * `send()`, so the ORDER is the property under test — a header set before
 * `open()` throws InvalidStateError and silently breaks every upload.
 */
class FakeXHR {
    public status = 0;
    public responseText = '';
    public withCredentials = false;
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public onabort: (() => void) | null = null;
    public ontimeout: (() => void) | null = null;
    public readonly upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
    public readonly calls: string[] = [];

    open(method: string, url: string) {
        this.calls.push(`open ${method} ${url}`);
    }
    setRequestHeader(name: string, value: string) {
        this.calls.push(`header ${name}=${value}`);
    }
    send() {
        this.calls.push('send');
    }
    abort() {
        this.onabort?.();
    }
    complete(body: unknown, status = 201) {
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
    }
}

const instances: FakeXHR[] = [];

beforeEach(() => {
    instances.length = 0;
    vi.stubGlobal('XMLHttpRequest', function FakeXHRCtor() {
        const x = new FakeXHR();
        instances.push(x);
        return x;
    } as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const RESULT = {
    id: 'a'.repeat(64),
    url: '/api/uploads/u1/aaaa.md',
    mimeType: 'text/markdown',
    size: 1,
};

describe('uploadFile — workspace selector on the XHR', () => {
    it('sets x-ever-workspace from the tab path AFTER open() and BEFORE send()', async () => {
        window.history.replaceState(null, '', '/org/acme/missions');

        const pending = uploadFile(new File(['x'], 'a.md'));
        const xhr = instances[0];
        xhr.complete(RESULT);
        await pending;

        expect(xhr.calls).toEqual([
            'open POST /api/uploads/file',
            'header x-ever-workspace=org:acme',
            'send',
        ]);
    });

    it('sends the personal selector on an unprefixed path', async () => {
        window.history.replaceState(null, '', '/missions');

        const pending = uploadFile(new File(['x'], 'a.md'));
        instances[0].complete(RESULT);
        await pending;

        expect(instances[0].calls).toContain('header x-ever-workspace=personal');
    });

    it('keeps the workId on the URL alongside the header', async () => {
        window.history.replaceState(null, '', '/org/acme/works/w-1');

        const pending = uploadFile(new File(['x'], 'a.md'), { workId: 'w-1' });
        instances[0].complete(RESULT);
        await pending;

        expect(instances[0].calls[0]).toBe('open POST /api/uploads/file?workId=w-1');
    });

    it('rejects with UploadError on a malformed tab path, before any XHR is opened', async () => {
        window.history.replaceState(null, '', '/org/Not_Valid/missions');

        await expect(uploadFile(new File(['x'], 'a.md'))).rejects.toMatchObject({
            name: 'UploadError',
            message: 'Invalid workspace scope',
        });
        expect(instances).toHaveLength(0);
    });

    it('still surfaces the upstream message on a non-2xx', async () => {
        window.history.replaceState(null, '', '/missions');

        const pending = uploadFile(new File(['x'], 'a.md'));
        instances[0].complete({ message: 'File too large' }, 413);

        await expect(pending).rejects.toBeInstanceOf(UploadError);
        await expect(pending).rejects.toMatchObject({ message: 'File too large', status: 413 });
    });
});

/**
 * The render-time half for the serve URL. The URL the API mints, the one in
 * chat text and the one in attachment lists stay scope-free; the tab's
 * workspace is added where an `<a href>` / `<img src>` is rendered.
 */
describe('withUploadServeScope', () => {
    const ORG = { kind: 'organization', slug: 'acme' } as const;

    it('appends the tab’s selector to an API-minted serve URL', () => {
        expect(withUploadServeScope('/api/uploads/u1/aaaa.png', ORG)).toBe(
            '/api/uploads/u1/aaaa.png?scope=org%3Aacme',
        );
    });

    it('keeps an existing workId next to the selector', () => {
        const url = new URL(
            withUploadServeScope('/api/uploads/u1/aaaa.png?workId=w-1', ORG),
            'http://n',
        );

        expect(url.searchParams.get('workId')).toBe('w-1');
        expect(url.searchParams.get('scope')).toBe('org:acme');
    });

    it('leaves the URL alone when there is no scope to add', () => {
        expect(withUploadServeScope('/api/uploads/u1/aaaa.png', null)).toBe(
            '/api/uploads/u1/aaaa.png',
        );
    });

    it.each([
        'blob:http://web.example/123',
        'https://cdn.example/x.png',
        '/api/works/w/kb/uploads/u/download',
    ])('never decorates %j — only the serve URL family carries this', (url) => {
        expect(withUploadServeScope(url, ORG)).toBe(url);
    });

    it('passes undefined through for an attachment with no URL yet', () => {
        expect(withUploadServeScope(undefined, ORG)).toBeUndefined();
    });
});
