/**
 * Skills feature — invocation slugs. Contract under test for the shared
 * composer autocomplete: it opens only for a leading `/` token, filters
 * by prefix, completes to `/slug ` (which is exactly the shape the
 * server-side parser accepts), and degrades to silence when the
 * `GET /api/skills/invocable` fetch fails — an unknown or unfetched
 * command must still submit as plain text.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import {
    SlashCommandPopup,
    useSlashCommands,
    __resetInvocableSkillsCache,
} from './SlashCommandAutocomplete';

const OPTIONS = [
    { id: 's1', title: 'Planning Guide', invocationSlug: 'plan', description: 'plan things' },
    { id: 's2', title: 'Plot Twist', invocationSlug: 'plot', description: 'twist things' },
    { id: 's3', title: 'Deploy Helper', invocationSlug: 'deploy', description: 'ship things' },
];

function Harness({ initial = '', disabled = false }: { initial?: string; disabled?: boolean }) {
    const [value, setValue] = useState(initial);
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const slash = useSlashCommands({ value, onChange: setValue, disabled, inputRef: ref });
    return (
        <div className="relative">
            <SlashCommandPopup state={slash} />
            <textarea
                ref={ref}
                data-testid="input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => slash.handleKeyDown(e)}
            />
        </div>
    );
}

function mockInvocableFetch(response: { ok: boolean; data?: typeof OPTIONS }) {
    const fetchMock = vi.fn(() =>
        Promise.resolve({
            ok: response.ok,
            json: () => Promise.resolve({ data: response.data ?? [] }),
        } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const input = () => screen.getByTestId('input');

beforeEach(() => {
    __resetInvocableSkillsCache();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('useSlashCommands / SlashCommandPopup', () => {
    it('opens on a leading slash and lists every invocable skill', async () => {
        mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: '/' } });

        await waitFor(() => expect(screen.getByTestId('composer-slash-popup')).toBeTruthy());
        expect(screen.getAllByRole('option')).toHaveLength(3);
    });

    it('filters by prefix as the slug is typed', async () => {
        mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: '/pl' } });

        await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
        fireEvent.change(input(), { target: { value: '/plan' } });
        await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
        expect(screen.getByRole('option').textContent).toContain('/plan');
    });

    it('stays closed when the slash is not the first character', async () => {
        const fetchMock = mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: 'see /plan for details' } });

        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByTestId('composer-slash-popup')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('completes to "/slug " on click — the exact shape the server parses', async () => {
        mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: '/de' } });

        await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
        fireEvent.click(screen.getByRole('option'));
        expect((input() as HTMLTextAreaElement).value).toBe('/deploy ');
        // Completing dismisses the popup rather than re-opening on the
        // now-longer value.
        expect(screen.queryByTestId('composer-slash-popup')).toBeNull();
    });

    it('navigates with arrows and completes on Enter', async () => {
        mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: '/pl' } });
        await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

        expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
        fireEvent.keyDown(input(), { key: 'ArrowDown' });
        await waitFor(() =>
            expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true'),
        );
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect((input() as HTMLTextAreaElement).value).toBe('/plot ');
    });

    it('Escape dismisses without changing the text', async () => {
        mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: '/pl' } });
        await waitFor(() => expect(screen.getByTestId('composer-slash-popup')).toBeTruthy());

        fireEvent.keyDown(input(), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('composer-slash-popup')).toBeNull());
        expect((input() as HTMLTextAreaElement).value).toBe('/pl');
    });

    it('a failed fetch is silent — no popup, and a later keystroke retries', async () => {
        const failing = mockInvocableFetch({ ok: false });
        render(<Harness />);
        fireEvent.change(input(), { target: { value: '/' } });

        await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('composer-slash-popup')).toBeNull();

        // Not cached as "loaded": the next slash token tries again.
        mockInvocableFetch({ ok: true, data: OPTIONS });
        fireEvent.change(input(), { target: { value: '/pl' } });
        await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    });

    it('stays closed while the composer is disabled', async () => {
        mockInvocableFetch({ ok: true, data: OPTIONS });
        render(<Harness disabled />);
        fireEvent.change(input(), { target: { value: '/' } });

        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByTestId('composer-slash-popup')).toBeNull();
    });

    it('fetches once and shares the result across composers', async () => {
        const fetchMock = mockInvocableFetch({ ok: true, data: OPTIONS });
        render(
            <>
                <Harness />
                <Harness />
            </>,
        );
        const inputs = screen.getAllByTestId('input');
        fireEvent.change(inputs[0], { target: { value: '/' } });
        fireEvent.change(inputs[1], { target: { value: '/' } });

        await waitFor(() => expect(screen.getAllByTestId('composer-slash-popup')).toHaveLength(2));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
