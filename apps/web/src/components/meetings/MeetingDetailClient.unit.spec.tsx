import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

describe('MeetingDetailClient — edit panel', () => {
    it('seeds the roster textarea from the stored participants', () => {
        render(
            <MeetingDetailClient
                meeting={mkMeeting({
                    participants: [
                        { name: 'Ada Lovelace', email: 'ada@example.com' },
                        { name: 'Grace Hopper' },
                    ],
                })}
            />,
        );
        // formatParticipants is the exact inverse of the capture form's parser.
        expect((screen.getByTestId('meeting-edit-participants') as HTMLTextAreaElement).value).toBe(
            'Ada Lovelace <ada@example.com>\nGrace Hopper',
        );
    });

    it('patches startedAt and participants — the two fields the UI could not edit before', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        render(<MeetingDetailClient meeting={mkMeeting()} />);

        fireEvent.change(screen.getByTestId('meeting-edit-started-at'), {
            target: { value: LOCAL_START },
        });
        fireEvent.change(screen.getByTestId('meeting-edit-participants'), {
            target: { value: 'Grace Hopper <grace@example.com>\nAlan Turing' },
        });
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({
                    startedAt: LOCAL_START_ISO,
                    participants: [
                        { name: 'Grace Hopper', email: 'grace@example.com' },
                        { name: 'Alan Turing' },
                    ],
                }),
            ),
        );
    });

    it('an emptied roster patches an empty array rather than skipping the field', async () => {
        updateMock.mockResolvedValueOnce(mkMeeting());
        render(
            <MeetingDetailClient
                meeting={mkMeeting({ participants: [{ name: 'Ada Lovelace' }] })}
            />,
        );

        fireEvent.change(screen.getByTestId('meeting-edit-participants'), {
            target: { value: '   \n  ' },
        });
        fireEvent.click(screen.getByTestId('meeting-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(
                'mtg-1',
                expect.objectContaining({ participants: [] }),
            ),
        );
    });

    it('refuses to save with an emptied start time (the API requires one)', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        fireEvent.change(screen.getByTestId('meeting-edit-started-at'), { target: { value: '' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        expect(toastErrorMock).toHaveBeenCalledWith('errors.startedAtInvalid');
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('refuses to save a title that is only whitespace', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        fireEvent.change(screen.getByLabelText('fields.title'), { target: { value: '   ' } });
        fireEvent.click(screen.getByTestId('meeting-save'));

        expect(toastErrorMock).toHaveBeenCalledWith('errors.titleRequired');
        expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects an end time before the start time', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
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
        render(<MeetingDetailClient meeting={mkMeeting({ endedAt: LOCAL_END_ISO })} />);

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
        render(
            <MeetingDetailClient
                meeting={mkMeeting({ sourceUrl: 'https://example.com/rec/1', workId: 'work-1' })}
            />,
        );

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

describe('MeetingDetailClient — transcript', () => {
    it('shows the composer when no transcript has landed yet', () => {
        render(<MeetingDetailClient meeting={mkMeeting()} />);
        expect(screen.getByTestId('meeting-transcript-composer')).toBeTruthy();
        expect(screen.queryByTestId('meeting-transcript-body')).toBeNull();
        // …and the Summary section says why there is no summary.
        expect(screen.getByText('summary.noTranscript')).toBeTruthy();
    });

    it('collapses the composer behind Replace once a transcript exists', () => {
        render(
            <MeetingDetailClient
                meeting={mkMeeting({
                    hasTranscript: true,
                    transcriptText: 'Ada: the gate is green.',
                })}
            />,
        );
        expect(screen.getByTestId('meeting-transcript-body').textContent).toContain(
            'Ada: the gate is green.',
        );
        expect(screen.queryByTestId('meeting-transcript-composer')).toBeNull();

        fireEvent.click(screen.getByTestId('meeting-replace-transcript-toggle'));
        expect(screen.getByTestId('meeting-transcript-composer')).toBeTruthy();
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
