import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
    INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_EXTERNAL_REF_KINDS,
} from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
    // `@/components/ui/button` re-wraps `Link` from the same module.
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

const updateWorkExternalRefs = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    updateWorkExternalRefs: (...args: unknown[]) => updateWorkExternalRefs(...args),
}));

let work: Record<string, unknown> = { id: 'work-1', externalRefs: null };
vi.mock('./SettingsContext', () => ({
    useSettings: () => ({ context: { work } }),
}));

import { ExternalRefsSettings, rowsToExternalRefs } from './ExternalRefsSettings';

/**
 * The Work external-refs editor — the missing half of workId routing.
 * `works.externalRefs` routes ingested events to a Work; this card is the
 * only surface that populates it.
 */
describe('ExternalRefsSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        work = { id: 'work-1', externalRefs: null };
        updateWorkExternalRefs.mockResolvedValue({ success: true });
    });

    it('renders one section per claimable ref kind, each with helper copy', () => {
        render(<ExternalRefsSettings />);

        for (const kind of WORK_EXTERNAL_REF_KINDS) {
            expect(screen.getByTestId(`external-ref-${kind}`)).toBeTruthy();
            expect(screen.getByTestId(`external-ref-${kind}`).textContent).toContain(
                `kinds.${kind}.helper`,
            );
        }
        // `repo` is deliberately not claimable — repo hints resolve through
        // the repositories the Work already declares.
        expect(screen.queryByTestId('external-ref-repo')).toBeNull();
    });

    it('adds a claim and saves the normalized map through the Work update path', async () => {
        const user = userEvent.setup();
        render(<ExternalRefsSettings />);

        const input = screen.getByLabelText('kinds.chat-channel.label');
        await user.type(input, 'C0123456789');
        await user.click(screen.getAllByText('add')[0]);
        await user.click(screen.getByTestId('external-refs-save'));

        expect(updateWorkExternalRefs).toHaveBeenCalledWith('work-1', {
            'chat-channel': ['C0123456789'],
        });
        expect(toastSuccess).toHaveBeenCalledWith('saved');
        expect(refresh).toHaveBeenCalled();
    });

    it('rejects a duplicate claim under the same kind (case-insensitive) without adding a row', async () => {
        const user = userEvent.setup();
        work = { id: 'work-1', externalRefs: { 'chat-channel': ['C-Support'] } };
        render(<ExternalRefsSettings />);

        const input = screen.getByLabelText('kinds.chat-channel.label');
        await user.type(input, 'c-support');
        await user.click(screen.getAllByText('add')[0]);

        expect(toastError).toHaveBeenCalledWith('errors.duplicate');
        expect(screen.getByTestId('external-ref-chat-channel').querySelectorAll('li')).toHaveLength(
            1,
        );
    });

    it('refuses an identifier longer than the ingest cap', async () => {
        const user = userEvent.setup();
        render(<ExternalRefsSettings />);

        const input = screen.getByLabelText('kinds.meeting.label') as HTMLInputElement;
        // The input carries the cap as `maxLength` (typing/pasting is
        // clamped by the browser), so assert that bound AND drive the
        // programmatic path that can still exceed it.
        expect(input.maxLength).toBe(INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS);
        fireEvent.change(input, {
            target: { value: 'm'.repeat(INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS + 5) },
        });
        await user.click(screen.getAllByText('add')[3]);

        expect(toastError).toHaveBeenCalledWith(
            `errors.tooLong:{"max":${INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS}}`,
        );
        expect(updateWorkExternalRefs).not.toHaveBeenCalled();
    });

    it('locks a kind that is already at the per-kind cap', () => {
        work = {
            id: 'work-1',
            externalRefs: {
                'chat-channel': Array.from(
                    { length: WORK_EXTERNAL_REFS_MAX_PER_KIND },
                    (_, i) => `C${i}`,
                ),
            },
        };
        render(<ExternalRefsSettings />);

        const section = screen.getByTestId('external-ref-chat-channel');
        expect(section.textContent).toContain(
            `errors.tooMany:{"max":${WORK_EXTERNAL_REFS_MAX_PER_KIND}}`,
        );
        expect((section.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    });

    it('removes a claim row and persists the shorter list', async () => {
        const user = userEvent.setup();
        work = { id: 'work-1', externalRefs: { 'tracker-team': ['ENG', 'OPS'] } };
        render(<ExternalRefsSettings />);

        await user.click(screen.getByLabelText('remove:{"id":"OPS"}'));
        await user.click(screen.getByTestId('external-refs-save'));

        expect(updateWorkExternalRefs).toHaveBeenCalledWith('work-1', { 'tracker-team': ['ENG'] });
    });

    it('sends null when the last claim is removed (clears the column)', async () => {
        const user = userEvent.setup();
        work = { id: 'work-1', externalRefs: { meeting: ['zoom-1'] } };
        render(<ExternalRefsSettings />);

        await user.click(screen.getByLabelText('remove:{"id":"zoom-1"}'));
        await user.click(screen.getByTestId('external-refs-save'));

        expect(updateWorkExternalRefs).toHaveBeenCalledWith('work-1', null);
    });

    it('surfaces the server-side duplicate-claim rejection verbatim', async () => {
        const user = userEvent.setup();
        updateWorkExternalRefs.mockResolvedValue({
            success: false,
            error: 'External reference already claimed by another Work you own: "C-1" (chat-channel) is already claimed by "Support Work".',
        });
        render(<ExternalRefsSettings />);

        await user.type(screen.getByLabelText('kinds.chat-channel.label'), 'C-1');
        await user.click(screen.getAllByText('add')[0]);
        await user.click(screen.getByTestId('external-refs-save'));

        expect(toastError).toHaveBeenCalledWith(
            expect.stringContaining('already claimed by "Support Work"'),
        );
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('keeps save disabled until something actually changes', async () => {
        const user = userEvent.setup();
        work = { id: 'work-1', externalRefs: { 'tracker-team': ['ENG'] } };
        render(<ExternalRefsSettings />);

        const save = screen.getByTestId('external-refs-save') as HTMLButtonElement;
        expect(save.disabled).toBe(true);

        await user.type(screen.getByLabelText('kinds.tracker-team.label'), 'OPS');
        await user.click(screen.getAllByText('add')[1]);
        expect((screen.getByTestId('external-refs-save') as HTMLButtonElement).disabled).toBe(
            false,
        );
    });
});

describe('rowsToExternalRefs', () => {
    const empty = WORK_EXTERNAL_REF_KINDS.reduce(
        (acc, kind) => ({ ...acc, [kind]: [] }),
        {} as Record<string, string[]>,
    );

    it('returns null when every kind is empty or blank-only', () => {
        expect(rowsToExternalRefs(empty as never)).toBeNull();
        expect(rowsToExternalRefs({ ...empty, meeting: ['   '] } as never)).toBeNull();
    });

    it('trims, drops blanks and dedupes case-insensitively', () => {
        expect(
            rowsToExternalRefs({
                ...empty,
                'chat-channel': [' C1 ', 'c1', '', 'C2'],
            } as never),
        ).toEqual({ 'chat-channel': ['C1', 'C2'] });
    });
});
