import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
}));

import { KbCitationHover } from './KbCitationHover';

const WORK_ID = 'work-1';

function makeDoc(
    overrides: Partial<{
        id: string;
        title: string;
        class: string;
        path: string;
        body: string;
    }> = {},
) {
    return {
        id: 'doc-1',
        workId: WORK_ID,
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
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        lastCommitSha: null,
        body: 'The voice is friendly, terse, and a bit irreverent. Use first-person plural sparingly.',
        assets: [],
        ...overrides,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('KbCitationHover', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // Real timers throughout — `waitFor` from @testing-library uses
        // `setTimeout` internally to poll, and mixing fake timers with
        // an async-fetch flow hangs `waitFor` even when we only fake
        // `setTimeout`. Tests use `debounceMs={0}` to run the hover
        // path immediately; the "debounce gates the fetch" timing
        // surface is covered separately via a dedicated test.
        fetchMock = vi.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders the citation token with stable testid + data attributes (no fetch on mount)', () => {
        render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" />);
        const wrapper = screen.getByTestId('kb-citation-hover');
        expect(wrapper).toBeTruthy();
        expect(wrapper.getAttribute('data-cls')).toBe('brand');
        expect(wrapper.getAttribute('data-slug')).toBe('voice');
        expect(wrapper.getAttribute('data-open')).toBe('false');
        expect(wrapper.textContent).toContain('kb:brand/voice');
        expect(screen.queryByTestId('kb-citation-popover')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses the supplied `raw` text when provided', () => {
        render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" raw="kb:brand/voice." />);
        expect(screen.getByTestId('kb-citation-hover').textContent).toContain('kb:brand/voice.');
    });

    it('does not fetch before the hover debounce fires', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" debounceMs={150} />);
            const wrapper = screen.getByTestId('kb-citation-hover');
            fireEvent.pointerEnter(wrapper);

            // 50 ms in — below the 150 ms debounce — no fetch yet.
            await act(async () => {
                vi.advanceTimersByTime(50);
            });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(wrapper.getAttribute('data-open')).toBe('false');
        } finally {
            vi.useRealTimers();
        }
    });

    it('opens popover + fetches resolution on pointerenter', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ document: makeDoc() }));

        render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" debounceMs={0} />);
        const wrapper = screen.getByTestId('kb-citation-hover');

        fireEvent.pointerEnter(wrapper);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toBe('/api/works/work-1/kb/citations/brand/voice');

        await waitFor(() => {
            const popover = screen.getByTestId('kb-citation-popover');
            expect(popover.getAttribute('data-status')).toBe('resolved');
        });
        expect(screen.getByTestId('kb-citation-popover-title').textContent).toBe('Brand voice');
        expect(screen.getByTestId('kb-citation-popover-class').textContent).toBe('brand');
        expect(screen.getByTestId('kb-citation-popover-path').textContent).toBe('brand/voice.md');
        expect(screen.getByTestId('kb-citation-popover-snippet').textContent).toContain(
            'The voice is friendly',
        );
        const link = screen.getByTestId('kb-citation-popover-link') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/works/work-1/kb/brand/voice');
    });

    it('shows missing state when the proxy returns `{ document: null }`', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ document: null }));

        render(<KbCitationHover workId={WORK_ID} cls="legal" slug="ghost" debounceMs={0} />);
        fireEvent.pointerEnter(screen.getByTestId('kb-citation-hover'));

        await waitFor(() => {
            expect(screen.getByTestId('kb-citation-popover').getAttribute('data-status')).toBe(
                'missing',
            );
        });
        expect(screen.getByTestId('kb-citation-popover-missing')).toBeTruthy();
        expect(screen.queryByTestId('kb-citation-popover-title')).toBeNull();
    });

    it('shows error state when the proxy responds non-2xx', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500));

        render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" debounceMs={0} />);
        fireEvent.pointerEnter(screen.getByTestId('kb-citation-hover'));

        await waitFor(() => {
            expect(screen.getByTestId('kb-citation-popover').getAttribute('data-status')).toBe(
                'error',
            );
        });
        expect(screen.getByTestId('kb-citation-popover-error').textContent).toContain('HTTP 500');
    });

    it('builds the proxy URL with multi-segment slug', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ document: makeDoc() }));
        render(
            <KbCitationHover
                workId={WORK_ID}
                cls="research"
                slug="v2.1/final-draft"
                debounceMs={0}
            />,
        );
        fireEvent.pointerEnter(screen.getByTestId('kb-citation-hover'));

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
        const url = fetchMock.mock.calls[0][0] as string;
        // encodeURIComponent encodes `/` to `%2F` so the catch-all
        // [...slug] segment receives the slug as one dynamic value.
        expect(url).toBe('/api/works/work-1/kb/citations/research/v2.1%2Ffinal-draft');
    });

    it('truncates long doc bodies to 240 chars + ellipsis in the popover snippet', async () => {
        const longBody = 'x'.repeat(500);
        fetchMock.mockResolvedValueOnce(jsonResponse({ document: makeDoc({ body: longBody }) }));
        render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" debounceMs={0} />);
        fireEvent.pointerEnter(screen.getByTestId('kb-citation-hover'));

        await waitFor(() => {
            expect(screen.getByTestId('kb-citation-popover-snippet')).toBeTruthy();
        });
        const snippet = screen.getByTestId('kb-citation-popover-snippet').textContent ?? '';
        expect(snippet.length).toBe(241); // 240 chars + the ellipsis
        expect(snippet.endsWith('…')).toBe(true);
    });

    it('Escape closes the popover', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ document: makeDoc() }));
        render(<KbCitationHover workId={WORK_ID} cls="brand" slug="voice" debounceMs={0} />);
        fireEvent.pointerEnter(screen.getByTestId('kb-citation-hover'));

        await waitFor(() => {
            expect(screen.getByTestId('kb-citation-popover')).toBeTruthy();
        });
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => {
            expect(screen.queryByTestId('kb-citation-popover')).toBeNull();
        });
    });
});
