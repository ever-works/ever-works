import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MeetingSummary } from './MeetingSummary';

/**
 * MeetingSummary — the stored AI summary on `/meetings/:id`.
 *
 * The summarizer prompt asks for a few sentences followed by bullet action
 * items, so the stored text is markdown. It used to render as preformatted
 * text, which put the `-` and `**` on screen verbatim. These specs pin that
 * it is parsed, and that a link inside model-written text cannot smuggle a
 * script URL onto the page.
 */

/** The shape the summarizer prompt asks for: a paragraph, then sections. */
const SUMMARY = [
    'The team agreed to ship the meetings surface this week.',
    '',
    '### Decisions',
    '',
    '- Ship behind a **flag** first',
    '',
    '### Action items',
    '',
    '- Ada to finish the transcript editor',
    '- Grace to review the migration',
].join('\n');

describe('MeetingSummary', () => {
    it('renders action items as a real list rather than literal dashes', () => {
        render(<MeetingSummary text={SUMMARY} />);

        const items = screen.getAllByRole('listitem');
        expect(items.map((li) => li.textContent)).toEqual([
            'Ship behind a flag first',
            'Ada to finish the transcript editor',
            'Grace to review the migration',
        ]);
        // The syntax itself must not survive into the rendered text.
        expect(screen.getByTestId('meeting-summary-body').textContent).not.toContain('- Ada');
    });

    it('gives each section a heading of its own', () => {
        render(<MeetingSummary text={SUMMARY} />);

        // The summarizer is asked for `###`, so the sections it produces have
        // to land as real headings a reader (and a screen reader) can scan.
        expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
            'Decisions',
            'Action items',
        ]);
    });

    it('renders emphasis as markup, not asterisks', () => {
        render(<MeetingSummary text={SUMMARY} />);

        expect(screen.getByText('flag').tagName).toBe('STRONG');
        expect(screen.getByTestId('meeting-summary-body').textContent).not.toContain('**');
    });

    it('keeps the prose in a paragraph so the card controls the rhythm', () => {
        render(<MeetingSummary text={SUMMARY} />);

        const body = screen.getByTestId('meeting-summary-body');
        expect(body.querySelector('p')?.textContent).toBe(
            'The team agreed to ship the meetings surface this week.',
        );
    });

    it('opens an http link in a new tab without handing over the opener', () => {
        render(<MeetingSummary text={'See [the notes](https://example.com/notes).'} />);

        const link = screen.getByRole('link', { name: 'the notes' });
        expect(link.getAttribute('href')).toBe('https://example.com/notes');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(link.getAttribute('target')).toBe('_blank');
    });

    it('defuses a script URL instead of rendering it as a link', () => {
        // The summary is model-written from user-pasted text, so a link in it
        // is attacker-influenced: the label survives, the protocol does not.
        render(<MeetingSummary text={'[click me](javascript:alert(1))'} />);

        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByText('click me')).toBeTruthy();
    });
});
