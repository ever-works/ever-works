import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));

const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccessMock(...args),
        error: (...args: unknown[]) => toastErrorMock(...args),
    },
}));

const updateMock = vi.fn();
const deleteMock = vi.fn();
const ingestMock = vi.fn();
vi.mock('./actions', () => ({
    updateMeetingAction: (...args: unknown[]) => updateMock(...args),
    deleteMeetingAction: (...args: unknown[]) => deleteMock(...args),
    ingestMeetingTranscriptAction: (...args: unknown[]) => ingestMock(...args),
}));

import { MeetingDetailClient } from './MeetingDetailClient';
import type { Meeting } from '@/lib/api/meetings';

/**
 * MeetingDetailClient — the `/meetings/:id` detail surface.
 *
 * Covers the behaviour the UX rework introduced or changed:
 *   - Delete goes through the shared confirmation Dialog (it used to be a
 *     blocking `window.confirm`, which jsdom cannot exercise at all).
 *   - The edit panel now patches `startedAt` and `participants`, which the
 *     API has always accepted but the UI could only ever set at capture.
 *   - `endedAt` is validated against the DRAFT start, so shifting a whole
 *     meeting forward in one save is legal.
 *
 * Server actions are mocked: this is component logic, not a round trip.
 */

/** A local `datetime-local` value and the exact ISO instant it maps to. */
const LOCAL_START = '2026-05-24T09:00';
const LOCAL_START_ISO = new Date(LOCAL_START).toISOString();
const LOCAL_END = '2026-05-24T10:30';
const LOCAL_END_ISO = new Date(LOCAL_END).toISOString();

function mkMeeting(overrides: Partial<Meeting> = {}): Meeting {
    return {
        id: 'mtg-1',
        title: 'Weekly roadmap review',
        startedAt: LOCAL_START_ISO,
        endedAt: null,
        source: 'manual',
        externalId: null,
        workId: null,
        organizationId: null,
        participants: [],
        sourceUrl: null,
        summary: null,
        hasTranscript: false,
        transcriptText: null,
        createdAt: LOCAL_START_ISO,
        ...overrides,
    };
}

beforeEach(() => {
    routerPushMock.mockClear();
    routerRefreshMock.mockClear();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    updateMock.mockClear();
    deleteMock.mockClear();
    ingestMock.mockClear();
});

describe('MeetingDetailClient — header', () => {
    it('renders the title, the badges and a back link to the catalog', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Weekly roadmap review');
        // The source pill appears twice by design — once in the header badge
        // row and once as the Details "source" row value.
        expect(screen.getAllByTestId('meeting-source-badge')).toHaveLength(2);
        expect(screen.getByTestId('meeting-transcript-badge')).toBeTruthy();
        expect(screen.getByText('backToMeetings').closest('a')?.getAttribute('href')).toBe(
            '/meetings',
        );
    });

    it('shows the recording link only when the meeting carries a sourceUrl', () => {
        const { unmount } = render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.queryByTestId('meeting-recording-link')).toBeNull();
        unmount();

        render(
            <MeetingDetailClient meeting={mkMeeting({ sourceUrl: 'https://example.com/rec/1' })} />,
        );
        const link = screen.getByTestId('meeting-recording-link');
        expect(link.getAttribute('href')).toBe('https://example.com/rec/1');
        // Anti-tabnabbing on a user-supplied URL opened in a new tab.
        expect(link.getAttribute('rel')).toContain('noopener');
    });
});

describe('MeetingDetailClient — delete', () => {
    it('opens the confirmation dialog instead of deleting straight away', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.queryByTestId('meeting-delete-confirm')).toBeNull();

        fireEvent.click(screen.getByTestId('meeting-delete'));

        expect(screen.getByText('deleteDialog.title')).toBeTruthy();
        expect(screen.getByTestId('meeting-delete-confirm')).toBeTruthy();
        expect(deleteMock).not.toHaveBeenCalled();
    });

    it('Cancel closes the dialog without deleting', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        fireEvent.click(screen.getByTestId('meeting-delete'));
        fireEvent.click(screen.getByTestId('meeting-delete-cancel'));
        expect(deleteMock).not.toHaveBeenCalled();
    });

    it('Confirm deletes and returns to the catalog', async () => {
        deleteMock.mockResolvedValueOnce({ deleted: true });
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        fireEvent.click(screen.getByTestId('meeting-delete'));
        fireEvent.click(screen.getByTestId('meeting-delete-confirm'));

        await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('mtg-1'));
        await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/meetings'));
    });

    it('a failed delete surfaces the error inline and stays on the page', async () => {
        deleteMock.mockRejectedValueOnce(new Error('Meeting is locked'));
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        fireEvent.click(screen.getByTestId('meeting-delete'));
        fireEvent.click(screen.getByTestId('meeting-delete-confirm'));

        expect(await screen.findByTestId('meeting-delete-error')).toBeTruthy();
        expect(screen.getByText('Meeting is locked')).toBeTruthy();
        expect(routerPushMock).not.toHaveBeenCalled();
    });
});

/** Render, then open the edit dialog that holds the editable fields. */
function renderWithEditOpen(
    meeting: Meeting = mkMeeting(),
    works: { id: string; name: string }[] = [],
) {
    const result = render(<MeetingDetailClient meeting={meeting} works={works} />);
    fireEvent.click(screen.getByTestId('meeting-edit-open'));
    return result;
}

/**
 * Roster rows are addressed by their accessible name rather than a
 * testid: `useTranslations` is mocked to echo the key, so the label the
 * screen reader announces is the handle the spec uses — the two cannot
 * drift apart. Order matches the roster.
 */
function participantNameInputs(): HTMLInputElement[] {
    return screen.queryAllByLabelText('fields.participantName') as HTMLInputElement[];
}

function participantEmailInputs(): HTMLInputElement[] {
    return screen.queryAllByLabelText('fields.participantEmail') as HTMLInputElement[];
}

describe('MeetingDetailClient — edit dialog', () => {
    it('keeps the form behind the header Edit button rather than in the page body', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.queryByTestId('meeting-edit')).toBeNull();
        expect(screen.queryByTestId('meeting-save')).toBeNull();

        fireEvent.click(screen.getByTestId('meeting-edit-open'));

        expect(screen.getByTestId('meeting-edit')).toBeTruthy();
        expect(screen.getByTestId('meeting-save')).toBeTruthy();
    });

    it('Cancel closes the dialog without patching', () => {
        renderWithEditOpen();
        fireEvent.change(screen.getByLabelText('fields.title'), { target: { value: 'Renamed' } });
        fireEvent.click(screen.getByTestId('meeting-edit-cancel'));
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('re-opening discards an abandoned draft', () => {
        renderWithEditOpen();
        const titleInput = () => screen.getByLabelText('fields.title') as HTMLInputElement;
        fireEvent.change(titleInput(), { target: { value: 'Abandoned rename' } });
        fireEvent.click(screen.getByTestId('meeting-edit-cancel'));

        fireEvent.click(screen.getByTestId('meeting-edit-open'));
        // Re-seeded from the canonical row, not left holding the draft.
        expect(titleInput().value).toBe('Weekly roadmap review');
    });

    it('offers the Work picker, defaulting to the org-wide row, only when Works exist', () => {
        renderWithEditOpen();
        // Nothing to route to → no picker at all, rather than an empty one.
        expect(screen.queryByTestId('meeting-edit-work')).toBeNull();

        cleanup();
        renderWithEditOpen(mkMeeting(), [{ id: 'work-1', name: 'Cats Directory' }]);
        const picker = screen.getByTestId('meeting-edit-work');
        // An org-wide meeting shows the "no Work" row as the current value.
        expect(picker.textContent).toContain('fields.workNone');
    });

    it('seeds one editable row per stored participant', () => {
        renderWithEditOpen(
            mkMeeting({
                participants: [
                    { name: 'Ada Lovelace', email: 'ada@example.com' },
                    { name: 'Grace Hopper' },
                ],
            }),
        );
        expect(participantNameInputs().map((i) => i.value)).toEqual([
            'Ada Lovelace',
            'Grace Hopper',
        ]);
        // The address is its own field now, not `<>` syntax inside the name.
        expect(participantEmailInputs().map((i) => i.value)).toEqual(['ada@example.com', '']);
    });

    it('adds a participant on a new row, leaving the existing roster alone', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(mkMeeting({ participants: [{ name: 'Ada Lovelace' }] }));

        // The whole point of the editor: adding someone must not require
        // retyping (or even touching) the people already on the list.
        fireEvent.click(screen.getByTestId('meeting-edit-participant-add'));
        const names = participantNameInputs();
        fireEvent.change(names[names.length - 1], { target: { value: 'Alan Turing' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({
                    participants: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }],
                }),
            ),
        );
    });

    it('patches startedAt and participants — the two fields the UI could not edit before', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(mkMeeting({ participants: [{ name: 'Grace Hopper' }] }));

        fireEvent.change(screen.getByTestId('meeting-edit-started-at'), {
            target: { value: LOCAL_START },
        });
        fireEvent.change(participantEmailInputs()[0], {
            target: { value: 'grace@example.com' },
        });
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({
                    startedAt: LOCAL_START_ISO,
                    participants: [{ name: 'Grace Hopper', email: 'grace@example.com' }],
                }),
            ),
        );
    });

    it('removes a participant through that row’s own control', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(
            mkMeeting({ participants: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }] }),
        );

        fireEvent.click(screen.getAllByTestId('meeting-edit-participant-remove')[0]);
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({ participants: [{ name: 'Grace Hopper' }] }),
            ),
        );
    });

    it('an emptied roster patches an empty array rather than skipping the field', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(mkMeeting({ participants: [{ name: 'Ada Lovelace' }] }));

        fireEvent.click(screen.getByTestId('meeting-edit-participant-remove'));
        expect(screen.getByTestId('meeting-edit-participants-empty')).toBeTruthy();
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({ participants: [] }),
            ),
        );
    });

    it('drops a row left blank instead of refusing the save', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(mkMeeting({ participants: [{ name: 'Ada Lovelace' }] }));

        // "Add participant" produces an empty row; abandoning it must not
        // block the save or post a nameless participant.
        fireEvent.click(screen.getByTestId('meeting-edit-participant-add'));
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({ participants: [{ name: 'Ada Lovelace' }] }),
            ),
        );
    });

    it('refuses to save a malformed address, and says so', () => {
        renderWithEditOpen(mkMeeting({ participants: [{ name: 'Ada Lovelace' }] }));

        fireEvent.change(participantEmailInputs()[0], { target: { value: 'ada@' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        expect(updateMock).not.toHaveBeenCalled();
        expect(toastErrorMock).toHaveBeenCalledWith('errors.participantEmailInvalid');
    });

    it('refuses to save with an emptied start time (the API requires one)', () => {
        renderWithEditOpen();
        fireEvent.change(screen.getByTestId('meeting-edit-started-at'), { target: { value: '' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        expect(toastErrorMock).toHaveBeenCalledWith('errors.startedAtInvalid');
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('refuses to save a title that is only whitespace', () => {
        renderWithEditOpen();
        fireEvent.change(screen.getByLabelText('fields.title'), { target: { value: '   ' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        expect(toastErrorMock).toHaveBeenCalledWith('errors.titleRequired');
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects an end time before the start time', () => {
        renderWithEditOpen();
        fireEvent.change(screen.getByTestId('meeting-edit-started-at'), {
            target: { value: LOCAL_END },
        });
        fireEvent.change(screen.getByTestId('meeting-edit-ended-at'), {
            target: { value: LOCAL_START },
        });
        fireEvent.click(screen.getByTestId('meeting-save'));

        expect(toastErrorMock).toHaveBeenCalledWith('errors.endedBeforeStarted');
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('validates endedAt against the DRAFT start, so a whole meeting can shift in one save', async () => {
        // Stored start is 09:00. Moving BOTH ends to 10:30 → 11:00 must pass:
        // validating the new end against the PERSISTED start would too, but
        // validating a new *earlier* pair proves the draft is what counts.
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(mkMeeting({ endedAt: LOCAL_END_ISO }));

        fireEvent.change(screen.getByTestId('meeting-edit-started-at'), {
            target: { value: '2026-05-24T07:00' },
        });
        fireEvent.change(screen.getByTestId('meeting-edit-ended-at'), {
            target: { value: '2026-05-24T08:00' },
        });
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({
                    startedAt: new Date('2026-05-24T07:00').toISOString(),
                    endedAt: new Date('2026-05-24T08:00').toISOString(),
                }),
            ),
        );
        expect(toastErrorMock).not.toHaveBeenCalled();
    });

    it('clears sourceUrl and workId with an explicit null so the API patches them', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        renderWithEditOpen(mkMeeting({ sourceUrl: 'https://example.com/rec/1', workId: 'work-1' }));

        fireEvent.change(screen.getByLabelText('fields.sourceUrl'), { target: { value: '  ' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({ sourceUrl: null }),
            ),
        );
    });
});

describe('MeetingDetailClient — quick-add participant', () => {
    /** Open the Details rail's inline add form and return its name input. */
    function openQuickAdd(): HTMLInputElement {
        fireEvent.click(screen.getByTestId('meeting-participant-quick-add-open'));
        return screen.getByTestId('meeting-participant-quick-add-name') as HTMLInputElement;
    }

    it('appends to the stored roster instead of replacing it', async () => {
        updateMock.mockResolvedValueOnce(
            mkMeeting({ participants: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }] }),
        );
        render(
            <MeetingDetailClient
                meeting={mkMeeting({ participants: [{ name: 'Ada Lovelace' }] })}
            />,
        );

        fireEvent.change(openQuickAdd(), { target: { value: 'Alan Turing' } });
        fireEvent.click(screen.getByTestId('meeting-participant-quick-add-submit'));

        // Only `participants` is patched: a quick add must not carry some
        // other field along with it.
        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith('mtg-1', {
                participants: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }],
            }),
        );
        expect(await screen.findByText('Alan Turing')).toBeTruthy();
    });

    it('closes and clears once the person has landed', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting({ participants: [{ name: 'Ada Lovelace' }] }));
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        fireEvent.change(openQuickAdd(), { target: { value: 'Ada Lovelace' } });
        fireEvent.click(screen.getByTestId('meeting-participant-quick-add-submit'));

        await waitFor(() =>
            expect(screen.queryByTestId('meeting-participant-quick-add')).toBeNull(),
        );
        expect(screen.getByTestId('meeting-participant-quick-add-open')).toBeTruthy();
    });

    it('sends the address as the name when only an address is given', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        openQuickAdd();
        fireEvent.change(screen.getByTestId('meeting-participant-quick-add-email'), {
            target: { value: 'ada@example.com' },
        });
        fireEvent.click(screen.getByTestId('meeting-participant-quick-add-submit'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith('mtg-1', {
                participants: [{ name: 'ada@example.com', email: 'ada@example.com' }],
            }),
        );
    });

    it('refuses a malformed address and keeps what was typed', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        fireEvent.change(openQuickAdd(), { target: { value: 'Ada' } });
        fireEvent.change(screen.getByTestId('meeting-participant-quick-add-email'), {
            target: { value: 'ada@' },
        });
        fireEvent.click(screen.getByTestId('meeting-participant-quick-add-submit'));

        expect(updateMock).not.toHaveBeenCalled();
        expect(toastErrorMock).toHaveBeenCalledWith('errors.participantEmailInvalid');
        // The fix is one keystroke — the form must not throw the entry away.
        const name = screen.getByTestId('meeting-participant-quick-add-name') as HTMLInputElement;
        expect(name.value).toBe('Ada');
    });

    it('refuses someone already on the list', () => {
        render(
            <MeetingDetailClient
                meeting={mkMeeting({
                    participants: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
                })}
            />,
        );

        openQuickAdd();
        fireEvent.change(screen.getByTestId('meeting-participant-quick-add-email'), {
            // Same person, different casing.
            target: { value: 'ADA@example.com' },
        });
        fireEvent.click(screen.getByTestId('meeting-participant-quick-add-submit'));

        expect(updateMock).not.toHaveBeenCalled();
        expect(toastErrorMock).toHaveBeenCalledWith('errors.participantDuplicate');
    });

    it('cannot submit an empty form', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        openQuickAdd();

        const submit = screen.getByTestId(
            'meeting-participant-quick-add-submit',
        ) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.click(submit);
        expect(updateMock).not.toHaveBeenCalled();
    });
});

/** A meeting whose transcript has already landed. */
const STORED = 'Ada: the gate is green.';

function withTranscript(overrides: Partial<Meeting> = {}): Meeting {
    return mkMeeting({ hasTranscript: true, transcriptText: STORED, ...overrides });
}

function composer(): HTMLTextAreaElement {
    return screen.getByTestId('meeting-transcript-composer') as HTMLTextAreaElement;
}

describe('MeetingDetailClient — transcript', () => {
    it('shows the composer when no transcript has landed yet', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.getByTestId('meeting-transcript-composer')).toBeTruthy();
        expect(screen.queryByTestId('meeting-transcript-body')).toBeNull();
        // …and the Summary section says why there is no summary.
        expect(screen.getByText('summary.noTranscript')).toBeTruthy();
    });

    it('collapses the composer behind Edit once a transcript exists', () => {
        render(<MeetingDetailClient meeting={withTranscript()} />);
        expect(screen.getByTestId('meeting-transcript-body').textContent).toContain(STORED);
        expect(screen.queryByTestId('meeting-transcript-composer')).toBeNull();

        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));
        expect(screen.getByTestId('meeting-transcript-composer')).toBeTruthy();
    });

    it('edits the stored transcript in place rather than opening an empty second box', () => {
        render(<MeetingDetailClient meeting={withTranscript()} />);
        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));

        // The whole point: the editor starts from the stored text, and the
        // read-only copy steps aside instead of sitting above a blank box.
        expect(composer().value).toBe(STORED);
        expect(screen.queryByTestId('meeting-transcript-body')).toBeNull();
    });

    it('posts the edited text, not a whole re-paste', async () => {
        ingestMock.mockResolvedValueOnce({
            meeting: withTranscript({ transcriptText: 'Ada: the gate is GREEN.' }),
            memorySaved: false,
            envelopeEmitted: false,
        });
        render(<MeetingDetailClient meeting={withTranscript()} />);

        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));
        fireEvent.change(composer(), { target: { value: 'Ada: the gate is GREEN.' } });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        await waitFor(() =>
            expect(ingestMock).toHaveBeenCalledWith('mtg-1', 'Ada: the gate is GREEN.'),
        );
    });

    it('Cancel drops the draft and leaves the stored transcript alone', () => {
        render(<MeetingDetailClient meeting={withTranscript()} />);

        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));
        fireEvent.change(composer(), { target: { value: 'Ada: nonsense.' } });
        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));

        expect(ingestMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('meeting-transcript-body').textContent).toContain(STORED);

        // Re-opening starts from the stored text again, not the abandoned draft.
        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));
        expect(composer().value).toBe(STORED);
    });

    it('labels the button Save for an existing transcript and Attach for the first one', () => {
        const { unmount } = render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.getByTestId('meeting-attach-transcript').textContent).toContain(
            'actions.attachTranscript',
        );
        unmount();

        render(<MeetingDetailClient meeting={withTranscript()} />);
        fireEvent.click(screen.getByTestId('meeting-edit-transcript-toggle'));
        expect(screen.getByTestId('meeting-attach-transcript').textContent).toContain(
            'actions.saveTranscript',
        );
    });

    it('reports honestly when the best-effort summary leg produced nothing', async () => {
        // The transcript WRITE is the only part that can fail the call; on a
        // stack with no AI provider `summary` is simply absent.
        ingestMock.mockResolvedValueOnce({
            meeting: mkMeeting({ hasTranscript: true, transcriptText: 'Ada: hello.' }),
            memorySaved: false,
            envelopeEmitted: false,
        });
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: 'Ada: hello.' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        await waitFor(() => expect(ingestMock).toHaveBeenCalledWith('mtg-1', 'Ada: hello.'));
        await waitFor(() =>
            expect(toastSuccessMock).toHaveBeenCalledWith('toasts.transcriptSaved'),
        );
        expect(toastSuccessMock).not.toHaveBeenCalledWith('toasts.transcriptSummarized');
    });

    it('claims a summary only when the API actually returned one', async () => {
        ingestMock.mockResolvedValueOnce({
            meeting: mkMeeting({
                hasTranscript: true,
                transcriptText: 'Ada: hello.',
                summary: 'They said hello.',
            }),
            summary: 'They said hello.',
            memorySaved: true,
            envelopeEmitted: true,
        });
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: 'Ada: hello.' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        await waitFor(() =>
            expect(toastSuccessMock).toHaveBeenCalledWith('toasts.transcriptSummarized'),
        );
        expect(await screen.findByText('They said hello.')).toBeTruthy();
    });

    it('refuses to attach an empty transcript', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: '   ' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        expect(toastErrorMock).toHaveBeenCalledWith('errors.transcriptRequired');
        expect(ingestMock).not.toHaveBeenCalled();
    });
});

describe('MeetingDetailClient — summary generation', () => {
    /** A promise the spec resolves by hand, so the request can be held open. */
    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    }

    it('shows the generating panel while the transcript is in flight, then the summary', async () => {
        const pending = deferred<unknown>();
        ingestMock.mockReturnValueOnce(pending.promise);
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        // Before the request: the empty state explains itself, nothing is
        // pretending to work.
        expect(screen.queryByTestId('meeting-summary-generating')).toBeNull();
        expect(screen.getByText('summary.noTranscript')).toBeTruthy();

        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: 'Ada: hello.' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        const panel = await screen.findByTestId('meeting-summary-generating');
        // ShinyText renders one span per character, so the label is asserted
        // on the concatenated text rather than as a single text node.
        expect(panel.textContent).toContain('summary.generating');
        expect(panel.getAttribute('role')).toBe('status');
        expect(panel.getAttribute('aria-live')).toBe('polite');
        // The empty-state copy steps aside rather than sitting under a
        // panel that says a summary is coming.
        expect(screen.queryByText('summary.noTranscript')).toBeNull();

        pending.resolve({
            meeting: mkMeeting({
                hasTranscript: true,
                transcriptText: 'Ada: hello.',
                summary: 'They said hello.',
            }),
            summary: 'They said hello.',
            memorySaved: true,
            envelopeEmitted: true,
        });

        expect(await screen.findByText('They said hello.')).toBeTruthy();
        expect(screen.queryByTestId('meeting-summary-generating')).toBeNull();
    });

    it('locks the composer and labels the button while the request is open', async () => {
        const pending = deferred<unknown>();
        ingestMock.mockReturnValueOnce(pending.promise);
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        const composer = screen.getByTestId('meeting-transcript-composer') as HTMLTextAreaElement;
        fireEvent.change(composer, { target: { value: 'Ada: hello.' } });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        await screen.findByTestId('meeting-summary-generating');
        const button = screen.getByTestId('meeting-attach-transcript') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain('actions.attaching');
        expect(composer.disabled).toBe(true);

        pending.resolve({
            meeting: mkMeeting({ hasTranscript: true, transcriptText: 'Ada: hello.' }),
            memorySaved: false,
            envelopeEmitted: false,
        });
        await waitFor(() => expect(screen.queryByTestId('meeting-summary-generating')).toBeNull());
    });

    it('scrolls the Summary card into view when the transcript is submitted', async () => {
        const pending = deferred<unknown>();
        ingestMock.mockReturnValueOnce(pending.promise);
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        // jsdom has no layout, so `scrollIntoView` is absent entirely. Stubbing
        // it on the summary node alone also proves WHICH element is scrolled to.
        const scrollSpy = vi.fn();
        screen.getByTestId('meeting-summary').scrollIntoView = scrollSpy;

        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: 'Ada: hello.' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        // At SUBMIT time, not on completion: what the reader is carried to is
        // the generating state, not a result that has already landed. The
        // scroll runs once that state has committed, so the browser is not
        // animating toward a position the same frame's growth invalidates.
        await screen.findByTestId('meeting-summary-generating');
        await waitFor(() =>
            expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }),
        );
        expect(scrollSpy).toHaveBeenCalledTimes(1);

        pending.resolve({
            meeting: mkMeeting({ hasTranscript: true, transcriptText: 'Ada: hello.' }),
            memorySaved: false,
            envelopeEmitted: false,
        });
        await waitFor(() => expect(screen.queryByTestId('meeting-summary-generating')).toBeNull());
    });

    it('does not scroll when the draft is empty — nothing was submitted', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        const scrollSpy = vi.fn();
        screen.getByTestId('meeting-summary').scrollIntoView = scrollSpy;

        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: '   ' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        expect(scrollSpy).not.toHaveBeenCalled();
        expect(toastErrorMock).toHaveBeenCalledWith('errors.transcriptRequired');
    });

    it('falls back to the not-generated copy when no summary came back', async () => {
        ingestMock.mockResolvedValueOnce({
            meeting: mkMeeting({ hasTranscript: true, transcriptText: 'Ada: hello.' }),
            memorySaved: false,
            envelopeEmitted: false,
        });
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        fireEvent.change(screen.getByTestId('meeting-transcript-composer'), {
            target: { value: 'Ada: hello.' },
        });
        fireEvent.click(screen.getByTestId('meeting-attach-transcript'));

        // The animation must not outlive the request: with no AI provider the
        // panel resolves to the honest explanation, not an endless shimmer.
        expect(await screen.findByText('summary.notGenerated')).toBeTruthy();
        expect(screen.queryByTestId('meeting-summary-generating')).toBeNull();
    });
});
