import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

const toastMock = vi.hoisted(() => {
    const fn = vi.fn() as ReturnType<typeof vi.fn> & { success: ReturnType<typeof vi.fn> };
    fn.success = vi.fn();
    return fn;
});

vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { FactsPanel } from './FactsPanel';
import type { MemoryFactDto, MemoryFactListDto } from '@/lib/api/memory-facts-types';

function fact(id: string, overrides: Partial<MemoryFactDto> = {}): MemoryFactDto {
    return {
        id,
        body: `Fact ${id}`,
        status: 'active',
        origin: 'user',
        scope: 'workspace',
        agentId: null,
        pinned: false,
        sourceRunId: null,
        sourceConversationId: null,
        sourceAgentId: null,
        recallCount: 0,
        lastRecalledAt: null,
        forgottenAt: null,
        restorableUntil: null,
        embedded: false,
        score: null,
        literalMatch: false,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
        ...overrides,
    };
}

function list(
    facts: MemoryFactDto[],
    overrides: Partial<MemoryFactListDto> = {},
): MemoryFactListDto {
    return {
        facts,
        total: facts.length,
        counts: { active: facts.length, proposed: 0, forgotten: 0, pinned: 0 },
        semantic: true,
        ...overrides,
    };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FactsPanel', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        window.history.replaceState({}, '', '/org/ever/memory');
        fetchMock = vi.fn(async () => json(list([])));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    function calls(): Array<{ url: string; init: RequestInit }> {
        return fetchMock.mock.calls.map(([url, init]) => ({
            url: String(url),
            init: init as RequestInit,
        }));
    }

    describe('states', () => {
        it('shows the empty state with Add a fact and a copyable starter prompt', () => {
            render(<FactsPanel initial={list([])} />);
            expect(screen.getByTestId('memory-facts-empty')).toHaveTextContent('emptyTitle');
            expect(screen.getByTestId('memory-facts-add-first')).toBeInTheDocument();
            expect(screen.getByTestId('memory-facts-copy-prompt')).toBeInTheDocument();
            // No spinner, no error on a brand-new workspace.
            expect(screen.queryByTestId('memory-facts-load-error')).toBeNull();
            expect(screen.queryByTestId('memory-facts-forget-all')).toBeNull();
        });

        it('lists facts with a showing count', () => {
            render(<FactsPanel initial={list([fact('f-1'), fact('f-2')], { total: 182 })} />);
            expect(screen.getByTestId('fact-row-f-1')).toBeInTheDocument();
            expect(screen.getByTestId('fact-row-f-2')).toBeInTheDocument();
            expect(screen.getByTestId('memory-facts-showing')).toHaveTextContent('showingCount');
        });

        it('shows the memory-full banner at 2,000 active facts with Tidy up', () => {
            const onTidyUp = vi.fn();
            render(
                <FactsPanel
                    initial={list([fact('f-1')], {
                        counts: { active: 2000, proposed: 0, forgotten: 0, pinned: 0 },
                    })}
                    onTidyUp={onTidyUp}
                />,
            );
            expect(screen.getByTestId('memory-facts-full')).toHaveTextContent('capacityFullTitle');
            fireEvent.click(screen.getByTestId('memory-facts-tidy-up'));
            expect(onTidyUp).toHaveBeenCalledTimes(1);
        });
    });

    describe('search', () => {
        it('searches through the BFF with the per-tab workspace selector', async () => {
            fetchMock.mockResolvedValue(
                json(list([fact('f-1', { score: 0.81 })], { semantic: true })),
            );
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.change(screen.getByTestId('memory-facts-search'), {
                target: { value: 'delivery promises' },
            });

            await waitFor(() => expect(fetchMock).toHaveBeenCalled());
            const [{ url, init }] = calls();
            expect(url).toBe('/api/memory/facts?q=delivery+promises&status=active&limit=50');
            expect(new Headers(init.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
            expect(await screen.findByTestId('fact-relevance-f-1')).toBeInTheDocument();
            expect(screen.queryByTestId('memory-facts-degraded')).toBeNull();
        });

        it('shows the exact-words note with a settings link when meaning-based search is unavailable', async () => {
            fetchMock.mockResolvedValue(
                json(list([fact('f-1', { literalMatch: true })], { semantic: false })),
            );
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.change(screen.getByTestId('memory-facts-search'), {
                target: { value: 'Fact' },
            });

            expect(await screen.findByTestId('memory-facts-degraded')).toHaveTextContent(
                'degradedSearchNote',
            );
            expect(screen.getByTestId('memory-facts-degraded-cta')).toHaveAttribute(
                'href',
                '/plugins',
            );
        });

        it('offers Clear search and Add as a fact when nothing matches', async () => {
            fetchMock.mockResolvedValue(
                json(list([], { counts: { active: 40, proposed: 0, forgotten: 0, pinned: 0 } })),
            );
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.change(screen.getByTestId('memory-facts-search'), {
                target: { value: 'refund policy' },
            });

            expect(await screen.findByTestId('memory-facts-no-results')).toBeInTheDocument();
            fireEvent.click(screen.getByTestId('memory-facts-add-query'));
            expect(screen.getByTestId('memory-facts-composer-input')).toHaveValue('refund policy');
        });

        it('keeps the search box usable while a view is loading', async () => {
            let resolve: (value: Response) => void = () => undefined;
            fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.click(screen.getByTestId('memory-rail-view-forgotten'));

            expect(screen.getAllByTestId('memory-facts-skeleton')).toHaveLength(6);
            const search = screen.getByTestId('memory-facts-search');
            fireEvent.change(search, { target: { value: 'typed while loading' } });
            expect(search).toHaveValue('typed while loading');

            await act(async () => resolve(json(list([]))));
        });

        it('shows a retryable error when the list fails to load', async () => {
            fetchMock.mockResolvedValueOnce(json({ message: 'boom' }, 500));
            render(<FactsPanel initial={list([fact('f-1')])} />);
            fireEvent.click(screen.getByTestId('memory-rail-view-proposed'));
            expect(await screen.findByTestId('memory-facts-load-error')).toBeInTheDocument();
        });
    });

    describe('writes', () => {
        it('adds a fact and reloads the All view', async () => {
            fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
                if (init?.method === 'POST') return json(fact('f-new'), 201);
                return json(list([fact('f-new')]));
            });
            render(<FactsPanel initial={list([])} />);

            fireEvent.click(screen.getByTestId('memory-facts-add'));
            fireEvent.change(screen.getByTestId('memory-facts-composer-input'), {
                target: { value: 'Invoices go out on the first working day.' },
            });
            fireEvent.click(screen.getByTestId('memory-facts-composer-save'));

            expect(await screen.findByTestId('fact-row-f-new')).toBeInTheDocument();
            const post = calls().find((c) => c.init.method === 'POST')!;
            expect(post.url).toBe('/api/memory/facts');
            expect(JSON.parse(String(post.init.body))).toEqual({
                body: 'Invoices go out on the first working day.',
            });
            expect(new Headers(post.init.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe(
                'org:ever',
            );
        });

        it('keeps the composer open with the refusal when memory is full', async () => {
            fetchMock.mockResolvedValue(
                json(
                    { statusCode: 409, message: 'Memory is full — 2,000 facts is the limit.' },
                    409,
                ),
            );
            render(<FactsPanel initial={list([])} />);
            fireEvent.click(screen.getByTestId('memory-facts-add'));
            fireEvent.change(screen.getByTestId('memory-facts-composer-input'), {
                target: { value: 'one more' },
            });
            fireEvent.click(screen.getByTestId('memory-facts-composer-save'));

            expect(await screen.findByTestId('memory-facts-composer-error')).toHaveTextContent(
                '2,000',
            );
            expect(screen.getByTestId('memory-facts-composer-input')).toHaveValue('one more');
        });

        it('forgets optimistically and offers Undo for 10 seconds', async () => {
            fetchMock.mockImplementation(async (url: string) => {
                if (url.endsWith('/forget')) return json({ id: 'f-1', status: 'forgotten' });
                if (url.endsWith('/restore')) return json(fact('f-1'));
                return json(list([]));
            });
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.click(screen.getByTestId('fact-forget-button-f-1'));

            // Gone before the API answers.
            expect(screen.queryByTestId('fact-row-f-1')).toBeNull();
            await waitFor(() => expect(toastMock).toHaveBeenCalled());
            const [message, options] = toastMock.mock.calls[0];
            expect(message).toBe('forgottenToast');
            expect(options.duration).toBe(10_000);
            expect(options.action.label).toBe('undo');

            await act(async () => options.action.onClick());
            await waitFor(() =>
                expect(calls().some((c) => c.url === '/api/memory/facts/f-1/restore')).toBe(true),
            );
        });

        it('refetches the view being shown when a write finishes after a view switch', async () => {
            let finishForget: (value: Response) => void = () => undefined;
            fetchMock.mockImplementation((url: string) => {
                if (url.endsWith('/forget')) {
                    return new Promise<Response>((resolve) => (finishForget = resolve));
                }
                if (url.includes('status=forgotten')) {
                    return Promise.resolve(
                        json(list([fact('f-1', { status: 'forgotten' })], { total: 1 })),
                    );
                }
                return Promise.resolve(json(list([])));
            });
            render(<FactsPanel initial={list([fact('f-1')])} />);

            // Forget, and switch to Forgotten while the forget is still in flight.
            fireEvent.click(screen.getByTestId('fact-forget-button-f-1'));
            fireEvent.click(screen.getByTestId('memory-rail-view-forgotten'));
            expect(await screen.findByTestId('fact-restore-button-f-1')).toBeInTheDocument();

            await act(async () => finishForget(json({ id: 'f-1', status: 'forgotten' })));

            // The follow-up refresh reloads Forgotten — never "All" into it.
            await waitFor(() => {
                const listCalls = calls().filter((c) => c.url.startsWith('/api/memory/facts?'));
                expect(listCalls[listCalls.length - 1].url).toContain('status=forgotten');
            });
            expect(await screen.findByTestId('fact-restore-button-f-1')).toBeInTheDocument();
        });

        it('puts the row back when forget is refused', async () => {
            fetchMock.mockResolvedValue(json({ message: 'nope' }, 500));
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.click(screen.getByTestId('fact-forget-button-f-1'));

            expect(await screen.findByTestId('fact-row-f-1')).toBeInTheDocument();
            expect(screen.getByTestId('memory-facts-action-error')).toHaveTextContent('nope');
            expect(toastMock).not.toHaveBeenCalled();
        });

        it('pins optimistically and rolls back with the API message at the pin cap', async () => {
            fetchMock.mockResolvedValue(
                json({ message: 'At most 20 facts can be pinned. Unpin one first.' }, 409),
            );
            render(<FactsPanel initial={list([fact('f-1')])} />);

            fireEvent.click(screen.getByTestId('fact-pin-button-f-1'));
            expect(screen.getByTestId('fact-pin-button-f-1')).toHaveAttribute(
                'aria-pressed',
                'true',
            );

            expect(await screen.findByTestId('memory-facts-action-error')).toHaveTextContent(
                'At most 20',
            );
            expect(screen.getByTestId('fact-pin-button-f-1')).toHaveAttribute(
                'aria-pressed',
                'false',
            );
        });

        it('forgets everything behind the typed confirmation', async () => {
            fetchMock.mockImplementation(async (url: string) => {
                if (url === '/api/memory/facts/forget-all') return json({ forgotten: 2 });
                return json(
                    list([], { counts: { active: 0, proposed: 0, forgotten: 2, pinned: 0 } }),
                );
            });
            render(<FactsPanel initial={list([fact('f-1'), fact('f-2')])} />);

            fireEvent.click(screen.getByTestId('memory-facts-forget-all'));
            fireEvent.change(screen.getByTestId('forget-all-confirm-input'), {
                target: { value: 'FORGET ALL' },
            });
            fireEvent.click(screen.getByTestId('forget-all-confirm'));

            await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('done'));
            const post = calls().find((c) => c.url === '/api/memory/facts/forget-all')!;
            expect(JSON.parse(String(post.init.body))).toEqual({ confirm: 'FORGET ALL' });
            expect(await screen.findByTestId('memory-facts-empty')).toBeInTheDocument();
        });
    });

    describe('keyboard', () => {
        it('focuses the search box on /', () => {
            render(<FactsPanel initial={list([fact('f-1')])} />);
            fireEvent.keyDown(document.body, { key: '/' });
            expect(document.activeElement).toBe(screen.getByTestId('memory-facts-search'));
        });

        it('jumps to the first fact on G then F', () => {
            render(<FactsPanel initial={list([fact('f-1'), fact('f-2')])} />);
            fireEvent.keyDown(document.body, { key: 'g' });
            fireEvent.keyDown(document.body, { key: 'f' });
            expect(document.activeElement).toBe(screen.getByTestId('fact-row-f-1'));
        });

        it('ignores / while typing in another field', () => {
            render(
                <>
                    <input data-testid="other" />
                    <FactsPanel initial={list([fact('f-1')])} />
                </>,
            );
            const other = screen.getByTestId('other');
            other.focus();
            fireEvent.keyDown(other, { key: '/' });
            expect(document.activeElement).toBe(other);
        });
    });
});
