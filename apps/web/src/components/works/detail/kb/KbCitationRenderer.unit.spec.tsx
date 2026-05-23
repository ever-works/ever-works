import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { KbCitationRenderer } from './KbCitationRenderer';

const WORK_ID = 'work-1';

describe('KbCitationRenderer (row 35d)', () => {
    it('renders plain text unchanged when there are no citations', () => {
        render(<KbCitationRenderer workId={WORK_ID} text="the assistant says hi, no citations" />);
        const root = screen.getByTestId('kb-citation-renderer');
        expect(root.textContent).toBe('the assistant says hi, no citations');
        expect(root.getAttribute('data-citation-count')).toBe('0');
        expect(screen.queryAllByTestId('kb-citation-hover')).toHaveLength(0);
    });

    it('wraps a single citation in <KbCitationHover>', () => {
        render(<KbCitationRenderer workId={WORK_ID} text="see kb:brand/voice today" />);
        const root = screen.getByTestId('kb-citation-renderer');
        expect(root.getAttribute('data-citation-count')).toBe('1');
        const hover = screen.getByTestId('kb-citation-hover');
        expect(hover.getAttribute('data-cls')).toBe('brand');
        expect(hover.getAttribute('data-slug')).toBe('voice');
        // Inner text of the hover wrapper is the raw citation token.
        expect(hover.textContent).toContain('kb:brand/voice');
        // Surrounding text intact.
        expect(root.textContent).toContain('see ');
        expect(root.textContent).toContain(' today');
    });

    it('wraps every citation in textual order, keeping plain text segments between', () => {
        render(<KbCitationRenderer workId={WORK_ID} text="A kb:brand/voice B kb:legal/terms C" />);
        expect(screen.getByTestId('kb-citation-renderer').getAttribute('data-citation-count')).toBe(
            '2',
        );
        const hovers = screen.getAllByTestId('kb-citation-hover');
        expect(hovers).toHaveLength(2);
        expect(hovers[0].getAttribute('data-cls')).toBe('brand');
        expect(hovers[1].getAttribute('data-cls')).toBe('legal');
        // The full text including the surrounding letters survives.
        expect(screen.getByTestId('kb-citation-renderer').textContent).toBe(
            'A kb:brand/voice B kb:legal/terms C',
        );
    });

    it('skips hallucinated unknown classes (parser drops them)', () => {
        render(
            <KbCitationRenderer
                workId={WORK_ID}
                text="real: kb:brand/voice and fake: kb:unknown/foo"
            />,
        );
        const hovers = screen.getAllByTestId('kb-citation-hover');
        expect(hovers).toHaveLength(1);
        expect(hovers[0].getAttribute('data-cls')).toBe('brand');
        // The hallucinated text is preserved verbatim in surrounding prose.
        expect(screen.getByTestId('kb-citation-renderer').textContent).toContain(
            'fake: kb:unknown/foo',
        );
    });

    it('treats @kb: as plain text (that is mention syntax, not citation)', () => {
        render(<KbCitationRenderer workId={WORK_ID} text="user typed @kb:brand/voice in chat" />);
        // @kb: prefix is rejected by the parser — no hover wrapped.
        expect(screen.queryAllByTestId('kb-citation-hover')).toHaveLength(0);
        expect(screen.getByTestId('kb-citation-renderer').textContent).toBe(
            'user typed @kb:brand/voice in chat',
        );
    });

    it('passes workId down to each hover wrapper (URL constructed in the hover, not here)', () => {
        // Spot-check via DOM: row 35c renders an <a> when resolved, but
        // for an unfetched citation we can at least confirm data-cls /
        // data-slug match what the renderer split out — the workId is
        // used at fetch time by the hover component, not at render.
        render(<KbCitationRenderer workId="custom-work" text="kb:legal/terms" />);
        const hover = screen.getByTestId('kb-citation-hover');
        expect(hover.getAttribute('data-cls')).toBe('legal');
        expect(hover.getAttribute('data-slug')).toBe('terms');
    });

    it('handles back-to-back citations separated only by punctuation', () => {
        render(<KbCitationRenderer workId={WORK_ID} text="kb:brand/voice, kb:legal/terms." />);
        const hovers = screen.getAllByTestId('kb-citation-hover');
        expect(hovers).toHaveLength(2);
        // The trailing period should not be absorbed into the slug.
        expect(hovers[1].getAttribute('data-slug')).toBe('terms');
    });

    it('renders multiline text with citations interleaved', () => {
        const text = ['Brand: kb:brand/voice', '', 'Legal: kb:legal/terms'].join('\n');
        render(<KbCitationRenderer workId={WORK_ID} text={text} />);
        const hovers = screen.getAllByTestId('kb-citation-hover');
        expect(hovers).toHaveLength(2);
        // Plain text preserved verbatim (newlines + leading labels).
        expect(screen.getByTestId('kb-citation-renderer').textContent).toContain('Brand: ');
        expect(screen.getByTestId('kb-citation-renderer').textContent).toContain('\n\nLegal: ');
    });

    it('returns a stable DOM shape even for empty text', () => {
        render(<KbCitationRenderer workId={WORK_ID} text="" />);
        const root = screen.getByTestId('kb-citation-renderer');
        expect(root.getAttribute('data-citation-count')).toBe('0');
        expect(root.textContent).toBe('');
    });
});
