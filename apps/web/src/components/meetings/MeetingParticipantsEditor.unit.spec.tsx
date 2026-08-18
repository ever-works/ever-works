import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MeetingParticipantsEditor, newParticipantRow } from './MeetingParticipantsEditor';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

/**
 * MeetingParticipantsEditor — the roster editor's own label.
 *
 * The editor is used in two places that need the label to carry different
 * weight in the document outline: inside the `/meetings/[id]` edit dialog it
 * is one field among others (a plain `<span>`), while on the `/meetings/new`
 * capture form its section is a peer of "Where it came from" and
 * "Transcript", both of which are `<h2>`s.
 *
 * That mismatch was a real defect, not a cosmetic one: the capture form's
 * roster section had no heading at all, so the e2e assertion
 * `getByRole('heading', { name: 'Participants' })` had been red on stage for
 * days. These specs pin both renderings so the outline cannot drift back —
 * unit specs run on every PR, the e2e suite only on `stage`.
 */
describe('MeetingParticipantsEditor label', () => {
    const rows = [newParticipantRow('Ada Lovelace', 'ada@example.com')];

    it('renders the label as a non-heading by default (the edit dialog)', () => {
        render(<MeetingParticipantsEditor label="Participants" rows={rows} onChange={() => {}} />);

        expect(screen.getByText('Participants').tagName).toBe('SPAN');
        expect(screen.queryByRole('heading', { name: 'Participants' })).toBeNull();
    });

    it('renders the label as a section heading when asked (the capture form)', () => {
        render(
            <MeetingParticipantsEditor
                label="Participants"
                labelAs="h2"
                rows={rows}
                onChange={() => {}}
            />,
        );

        const heading = screen.getByRole('heading', { name: 'Participants' });
        expect(heading.tagName).toBe('H2');
    });

    it('keeps the capacity counter alongside the heading', () => {
        render(
            <MeetingParticipantsEditor
                label="Participants"
                labelAs="h2"
                rows={rows}
                onChange={() => {}}
            />,
        );

        expect(screen.getByTestId('meeting-edit-participants-count')).toHaveTextContent('1/');
    });
});
