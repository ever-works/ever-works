import { act, cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMentionCandidateSource } from '@ever-works/contracts';

import {
    ComposerHighlightLayer,
    highlightSegments,
    paintComposerText,
    type ComposerHighlightHandle,
} from './ComposerHighlightLayer';

const nova: ConversationMentionCandidateSource = {
    type: 'agent',
    id: 'a-nova',
    slug: 'nova',
    name: 'Nova',
};
const novaPrime: ConversationMentionCandidateSource = {
    type: 'agent',
    id: 'a-prime',
    slug: 'nova-prime',
    name: 'Nova Prime',
};

/**
 * A highlight must always mean the mention lands (FR-29): only a name the
 * server confirmed for this person is painted, a two-word name paints as one
 * unit (FR-28), a plain `@word` stays plain, and the existing `@kb:slug`
 * document syntax is painted as a reference (FR-33).
 */
describe('highlightSegments', () => {
    it('paints a confirmed mention and leaves an unresolved @word plain', () => {
        const segments = highlightSegments('ask @Nova and @someone-else', [nova]);
        expect(segments.filter((segment) => segment.kind === 'mention')).toEqual([
            { text: '@Nova', kind: 'mention' },
        ]);
        expect(segments.map((segment) => segment.text).join('')).toBe(
            'ask @Nova and @someone-else',
        );
    });

    it('paints nothing before the server has confirmed the name', () => {
        expect(highlightSegments('ask @Nova', []).every((s) => s.kind === 'plain')).toBe(true);
    });

    it('paints a two-word name as one unit', () => {
        expect(highlightSegments('@Nova Prime, go', [nova, novaPrime])[0]).toEqual({
            text: '@Nova Prime',
            kind: 'mention',
        });
    });

    it('paints document references in their existing syntax', () => {
        expect(highlightSegments('read @kb:brand/voice', [])).toEqual([
            { text: 'read ', kind: 'plain' },
            { text: '@kb:brand/voice', kind: 'document' },
        ]);
    });

    it('never paints a prefix of a name', () => {
        expect(highlightSegments('@Nov', [nova]).every((s) => s.kind === 'plain')).toBe(true);
    });
});

describe('paintComposerText', () => {
    it('counts mentions past the ten-mention cap so the composer can warn before sending', () => {
        const agents = Array.from({ length: 11 }, (_, index) => ({
            type: 'agent' as const,
            id: `a-${index}`,
            slug: `scout-${index}`,
            name: `Scout${String.fromCharCode(97 + index)}`,
        }));
        const text = agents.map((agent) => `@${agent.name}`).join(' ');
        const painted = paintComposerText(text, agents);
        expect(painted.overLimit).toBe(1);
        expect(painted.segments.filter((segment) => segment.kind === 'mention')).toHaveLength(10);
    });
});

describe('ComposerHighlightLayer', () => {
    afterEach(cleanup);

    it('is hidden from assistive tech and ignores the pointer', () => {
        render(<ComposerHighlightLayer getCandidates={() => [nova]} />);
        const layer = screen.getByTestId('composer-highlight-layer');
        expect(layer).toHaveAttribute('aria-hidden', 'true');
        expect(layer.className).toContain('pointer-events-none');
    });

    it('repaints from the text it is handed, without owning the textarea', () => {
        const ref = createRef<ComposerHighlightHandle>();
        const candidates: ConversationMentionCandidateSource[] = [];
        render(<ComposerHighlightLayer ref={ref} getCandidates={() => candidates} />);

        act(() => ref.current?.update('hi @Nova', 0));
        expect(document.querySelector('mark')).toBeNull();

        // The server confirms Nova later: the same text now resolves.
        candidates.push(nova);
        act(() => ref.current?.repaint());
        const mark = document.querySelector('mark');
        expect(mark).toHaveTextContent('@Nova');
        expect(mark).toHaveAttribute('data-highlight', 'mention');
    });

    it('reports when the text carries more mentions than one message lands', () => {
        const agents = Array.from({ length: 11 }, (_, index) => ({
            type: 'agent' as const,
            id: `a-${index}`,
            slug: `scout-${index}`,
            name: `Scout${String.fromCharCode(97 + index)}`,
        }));
        const onOverLimitChange = vi.fn();
        const ref = createRef<ComposerHighlightHandle>();
        render(
            <ComposerHighlightLayer
                ref={ref}
                getCandidates={() => agents}
                onOverLimitChange={onOverLimitChange}
            />,
        );
        act(() => ref.current?.update(agents.map((agent) => `@${agent.name}`).join(' '), 0));
        expect(onOverLimitChange).toHaveBeenLastCalledWith(true);
        act(() => ref.current?.update('@Scouta', 0));
        expect(onOverLimitChange).toHaveBeenLastCalledWith(false);
    });

    it('follows the textarea scroll offset', () => {
        const ref = createRef<ComposerHighlightHandle>();
        render(<ComposerHighlightLayer ref={ref} getCandidates={() => [nova]} />);
        act(() => ref.current?.update('@Nova', 24));
        const painted = document.querySelector('mark')?.parentElement;
        expect(painted?.style.transform).toBe('translateY(-24px)');
    });
});
