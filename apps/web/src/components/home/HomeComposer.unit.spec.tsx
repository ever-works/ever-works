import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../../messages/en.json';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
// The default action is never used here — every test injects `createTask`.
vi.mock('@/app/actions/dashboard/home', () => ({ createHomeTaskAction: vi.fn() }));

import { HOME_COMPOSER_DRAFT_KEY, HomeComposer } from './HomeComposer';
import type { CreateHomeTaskResult } from '@/app/actions/dashboard/home';

function renderComposer(
    createTask: (text: string) => Promise<CreateHomeTaskResult>,
    jobRuntimeConfigured: boolean | null = true,
) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <HomeComposer createTask={createTask} jobRuntimeConfigured={jobRuntimeConfigured} />
        </NextIntlClientProvider>,
    );
}

// Label and test-id queries rather than role queries: role resolution walks
// the accessibility tree on every call and is what times out under CI load.
// The accessible name of the field is still pinned once below.
const field = () => screen.getByLabelText('Hand something to your agents') as HTMLTextAreaElement;
const send = () => screen.getByTestId('home-composer').querySelector('button[type="submit"]')!;

describe('HomeComposer', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps Send disabled under 3 trimmed characters and Enter does nothing (S14)', () => {
        const createTask = vi.fn();
        renderComposer(createTask);
        expect(screen.getByRole('textbox', { name: 'Hand something to your agents' })).toBe(
            field(),
        );
        expect(send()).toHaveTextContent('Send');

        fireEvent.change(field(), { target: { value: ' ab ' } });
        expect(send()).toBeDisabled();
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(createTask).not.toHaveBeenCalled();

        fireEvent.change(field(), { target: { value: 'abc' } });
        expect(send()).toBeEnabled();
    });

    it('shows the counter from 1800 characters and refuses input past 2000', () => {
        renderComposer(vi.fn());

        fireEvent.change(field(), { target: { value: 'a'.repeat(1799) } });
        expect(screen.queryByTestId('home-composer-counter')).toBeNull();

        fireEvent.change(field(), { target: { value: 'a'.repeat(1800) } });
        expect(screen.getByTestId('home-composer-counter')).toHaveTextContent('1800 / 2000');

        fireEvent.change(field(), { target: { value: 'a'.repeat(2100) } });
        expect(field().value).toHaveLength(2000);
        expect(send()).toBeEnabled();
    });

    it('submits on Enter and Ctrl+Enter, inserts a newline on Shift+Enter, blurs on Escape', async () => {
        const createTask = vi
            .fn()
            .mockResolvedValue({ ok: true, task: { id: 't-1', title: 'Summarise' } });
        renderComposer(createTask);

        fireEvent.change(field(), { target: { value: 'Summarise the week' } });
        fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
        expect(createTask).not.toHaveBeenCalled();

        field().focus();
        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(document.activeElement).not.toBe(field());
        expect(field().value).toBe('Summarise the week');

        fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
        await waitFor(() => expect(createTask).toHaveBeenCalledWith('Summarise the week'));
    });

    it('clears the field and shows a chip linking to the created Task (S2)', async () => {
        const createTask = vi.fn().mockResolvedValue({
            ok: true,
            task: { id: 'task-9', title: 'summarise every item added this week' },
        });
        renderComposer(createTask);

        fireEvent.change(field(), { target: { value: 'summarise every item added this week' } });
        fireEvent.click(send());

        const chip = await screen.findByText(
            'Task created — “summarise every item added this week”',
        );
        expect(chip).toBeInTheDocument();
        expect(screen.getByText('Open').closest('a')).toHaveAttribute('href', '/tasks/task-9');
        expect(field().value).toBe('');
        expect(window.localStorage.getItem(HOME_COMPOSER_DRAFT_KEY)).toBeNull();
    });

    it('keeps at most 3 chips, newest first, each for 60 seconds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let n = 0;
        const createTask = vi.fn().mockImplementation(async () => {
            n += 1;
            return { ok: true, task: { id: `t-${n}`, title: `Task ${n}` } };
        });
        renderComposer(createTask);

        for (let index = 0; index < 4; index += 1) {
            fireEvent.change(field(), { target: { value: `Do thing ${index}` } });
            fireEvent.click(send());
            await screen.findByText(`Task created — “Task ${index + 1}”`);
        }

        const chips = screen.getByTestId('home-composer-chips').querySelectorAll('li');
        expect(chips).toHaveLength(3);
        expect(chips[0]).toHaveTextContent('Task 4');
        expect(screen.queryByText('Task created — “Task 1”')).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.queryByTestId('home-composer-chips')).toBeNull();
    });

    it('keeps the text, returns focus and offers Try again when the create fails (S13)', async () => {
        const createTask = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, reason: 'failed' })
            .mockResolvedValueOnce({ ok: true, task: { id: 't-2', title: 'Draft notes' } });
        renderComposer(createTask);

        fireEvent.change(field(), { target: { value: 'Draft notes' } });
        fireEvent.click(send());

        const error = await screen.findByTestId('home-composer-error');
        expect(error).toHaveAttribute('role', 'alert');
        expect(error).toHaveTextContent("Couldn't create that Task.");
        expect(field().value).toBe('Draft notes');
        await waitFor(() => expect(document.activeElement).toBe(field()));

        fireEvent.click(screen.getByText('Try again'));
        await screen.findByText('Task created — “Draft notes”');
    });

    it('shows the throttle message on a throttled create', async () => {
        renderComposer(vi.fn().mockResolvedValue({ ok: false, reason: 'throttled' }));

        fireEvent.change(field(), { target: { value: 'Draft notes' } });
        fireEvent.click(send());

        expect(await screen.findByTestId('home-composer-error')).toHaveTextContent(
            "You're creating these faster than we can file them. Try again in a minute.",
        );
    });

    it('restores an unsent draft and saves what is typed', async () => {
        window.localStorage.setItem(HOME_COMPOSER_DRAFT_KEY, 'half a thought');
        renderComposer(vi.fn());

        await waitFor(() => expect(field().value).toBe('half a thought'));
        fireEvent.change(field(), { target: { value: 'a whole thought' } });
        expect(window.localStorage.getItem(HOME_COMPOSER_DRAFT_KEY)).toBe('a whole thought');
    });

    it('survives a browser that refuses storage access', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        renderComposer(vi.fn());
        fireEvent.change(field(), { target: { value: 'still works' } });
        expect(field().value).toBe('still works');
        getItem.mockRestore();
        setItem.mockRestore();
    });

    it('says nothing will run when no job runtime is configured (S20)', async () => {
        renderComposer(
            vi.fn().mockResolvedValue({ ok: true, task: { id: 't-3', title: 'Report' } }),
            false,
        );

        fireEvent.change(field(), { target: { value: 'Report' } });
        fireEvent.click(send());

        expect(
            await screen.findByText(/Nothing will run until a job runtime is configured\./),
        ).toBeInTheDocument();
        expect(screen.getByText('Configure').closest('a')).toHaveAttribute(
            'href',
            '/settings/job-runtime',
        );
    });
});
