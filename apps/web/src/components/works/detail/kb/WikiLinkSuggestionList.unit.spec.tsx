import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
}));

import {
    WikiLinkSuggestionList,
    type WikiLinkSuggestionListHandle,
} from './WikiLinkSuggestionList';
import type { WikiLinkSuggestionItem } from './extensions/WikiLinkExtension';

const sample: WikiLinkSuggestionItem[] = [
    { id: 'a', path: 'brand/voice.md', title: 'Brand voice', class: 'brand' },
    { id: 'b', path: 'legal/notice.md', title: 'Legal notice', class: 'legal' },
    { id: 'c', path: 'seo/keywords.md', title: 'SEO keywords', class: 'seo' },
];

/**
 * EW-641 Phase 1B/d row 16b — `WikiLinkSuggestionList` is the popover
 * content for the `[[` trigger. The tests pin:
 *
 *  - the empty / hint state (no query yet vs query with zero matches)
 *  - per-row selectors + `data-active` cursor
 *  - hover-to-highlight
 *  - click-to-commit calling `onSelect`
 *  - ArrowDown / ArrowUp / Enter forwarded via the exposed handle
 */
describe('WikiLinkSuggestionList', () => {
    it('renders the hint state when no query and no items', () => {
        render(<WikiLinkSuggestionList items={[]} query="" onSelect={() => undefined} />);
        const root = screen.getByTestId('kb-wikilink-suggestion-list');
        expect(root.getAttribute('data-empty')).toBe('true');
        expect(screen.getByTestId('kb-wikilink-suggestion-empty').textContent).toBe('hint');
    });

    it('renders the empty-for-query state when query is non-empty but items are zero', () => {
        render(<WikiLinkSuggestionList items={[]} query="zzz" onSelect={() => undefined} />);
        expect(screen.getByTestId('kb-wikilink-suggestion-empty').textContent).toBe(
            'empty query=zzz',
        );
    });

    it('renders one row per item with stable data-attrs and an initial active cursor on row 0', () => {
        render(<WikiLinkSuggestionList items={sample} query="b" onSelect={() => undefined} />);
        const rows = screen.getAllByTestId('kb-wikilink-suggestion-item');
        expect(rows.length).toBe(3);
        expect(rows[0].getAttribute('data-doc-id')).toBe('a');
        expect(rows[0].getAttribute('data-doc-path')).toBe('brand/voice.md');
        expect(rows[0].getAttribute('data-kb-class')).toBe('brand');
        expect(rows[0].getAttribute('data-active')).toBe('true');
        expect(rows[1].getAttribute('data-active')).toBe('false');
    });

    it('moves the active cursor on hover', () => {
        render(<WikiLinkSuggestionList items={sample} query="b" onSelect={() => undefined} />);
        const rows = screen.getAllByTestId('kb-wikilink-suggestion-item');
        fireEvent.mouseEnter(rows[2]);
        expect(rows[2].getAttribute('data-active')).toBe('true');
        expect(rows[0].getAttribute('data-active')).toBe('false');
    });

    it('calls onSelect when a row is clicked', () => {
        const onSelect = vi.fn();
        render(<WikiLinkSuggestionList items={sample} query="b" onSelect={onSelect} />);
        fireEvent.click(screen.getAllByTestId('kb-wikilink-suggestion-item')[1]);
        expect(onSelect).toHaveBeenCalledWith(sample[1]);
    });

    it('forwards ArrowDown / ArrowUp / Enter via the imperative handle', () => {
        const onSelect = vi.fn();
        const ref = createRef<WikiLinkSuggestionListHandle>();
        render(<WikiLinkSuggestionList items={sample} query="b" onSelect={onSelect} ref={ref} />);

        let arrowDownResult = false;
        act(() => {
            arrowDownResult =
                ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })) ?? false;
        });
        expect(arrowDownResult).toBe(true);
        expect(
            screen.getAllByTestId('kb-wikilink-suggestion-item')[1].getAttribute('data-active'),
        ).toBe('true');

        let arrowUpResult = false;
        act(() => {
            arrowUpResult =
                ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp' })) ?? false;
        });
        expect(arrowUpResult).toBe(true);
        expect(
            screen.getAllByTestId('kb-wikilink-suggestion-item')[0].getAttribute('data-active'),
        ).toBe('true');

        let enterResult = false;
        act(() => {
            enterResult =
                ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })) ?? false;
        });
        expect(enterResult).toBe(true);
        expect(onSelect).toHaveBeenCalledWith(sample[0]);
    });

    it('returns false for unhandled keys (so the editor handles them)', () => {
        const ref = createRef<WikiLinkSuggestionListHandle>();
        render(
            <WikiLinkSuggestionList
                items={sample}
                query="b"
                onSelect={() => undefined}
                ref={ref}
            />,
        );
        const eventA = new KeyboardEvent('keydown', { key: 'a' });
        expect(ref.current?.onKeyDown(eventA)).toBe(false);
    });

    it('handle gracefully no-ops on empty item list', () => {
        const ref = createRef<WikiLinkSuggestionListHandle>();
        const onSelect = vi.fn();
        render(<WikiLinkSuggestionList items={[]} query="" onSelect={onSelect} ref={ref} />);
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' });
        expect(ref.current?.onKeyDown(enterEvent)).toBe(true);
        expect(onSelect).not.toHaveBeenCalled();
    });
});
