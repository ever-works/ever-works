import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { KbCitationFooter } from './KbCitationFooter';

describe('KbCitationFooter (row 35e)', () => {
    it('renders nothing when the text has no citations', () => {
        const { container } = render(
            <KbCitationFooter workId="work-1" text="plain text, no kb tokens" />,
        );
        expect(container.firstChild).toBeNull();
        expect(screen.queryByTestId('kb-citation-footer')).toBeNull();
    });

    it('renders nothing for the empty string', () => {
        const { container } = render(<KbCitationFooter workId="work-1" text="" />);
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing for text that only has @kb: user mentions (not citations)', () => {
        const { container } = render(
            <KbCitationFooter workId="work-1" text="the user typed @kb:brand/voice in chat" />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders one chip per unique citation when citations are present', () => {
        render(
            <KbCitationFooter
                workId="work-1"
                text="Per kb:brand/voice we use a friendly tone, and per kb:legal/terms the disclaimer follows."
            />,
        );
        const footer = screen.getByTestId('kb-citation-footer');
        expect(footer.getAttribute('data-citation-count')).toBe('2');
        const chips = screen.getAllByTestId('kb-citation-hover');
        expect(chips).toHaveLength(2);
        expect(chips[0].getAttribute('data-cls')).toBe('brand');
        expect(chips[1].getAttribute('data-cls')).toBe('legal');
    });

    it('deduplicates citations of the same doc within a message', () => {
        render(
            <KbCitationFooter
                workId="work-1"
                text="Discussed kb:brand/voice up top and kb:brand/voice again at the end."
            />,
        );
        // Two textual occurrences → one chip (dedup by cls/slug).
        expect(screen.getByTestId('kb-citation-footer').getAttribute('data-citation-count')).toBe(
            '1',
        );
        expect(screen.getAllByTestId('kb-citation-hover')).toHaveLength(1);
    });

    it('skips hallucinated unknown classes (parser drops them upstream)', () => {
        render(
            <KbCitationFooter
                workId="work-1"
                text="real: kb:brand/voice and fake: kb:unknown/foo and also kb:bogus/bar"
            />,
        );
        const chips = screen.getAllByTestId('kb-citation-hover');
        expect(chips).toHaveLength(1);
        expect(chips[0].getAttribute('data-cls')).toBe('brand');
    });

    it('passes the workId down to each hover (for the future fetch)', () => {
        render(<KbCitationFooter workId="custom-work" text="See kb:legal/terms today." />);
        // The hover wrapper carries data-cls / data-slug, but the
        // workId is consumed at fetch-time inside KbCitationHover —
        // there's no rendered attribute to assert it directly. Spot-
        // check that the data attributes the parser produced reach
        // the hover so the wiring is correct.
        const chip = screen.getByTestId('kb-citation-hover');
        expect(chip.getAttribute('data-cls')).toBe('legal');
        expect(chip.getAttribute('data-slug')).toBe('terms');
    });
});
