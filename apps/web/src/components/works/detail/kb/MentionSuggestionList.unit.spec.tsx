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

import { MentionSuggestionList, type MentionSuggestionListHandle } from './MentionSuggestionList';
import type { MentionItem } from './extensions/MentionExtension';

const mixed: MentionItem[] = [
    { id: 'doc-a', path: 'brand/voice.md', title: 'Brand voice', class: 'brand', kind: 'doc' },
    { id: 'doc-b', path: 'legal/notice.md', title: 'Legal notice', class: 'legal', kind: 'doc' },
    { id: 'claude-code', name: 'Claude Code', kind: 'agent' },
];

/**
 * EW-641 Phase 1B/d row 17 — sectioned mention picker tests.
 *
 * The list is rendered as two sections (Documents / Agents) over a
 * single flat suggestion list. The keyboard cursor is global and walks
 * through both sections in order. Items expose their kind via
 * `data-kind` and either `data-doc-path` or `data-agent-id`.
 */
describe('MentionSuggestionList', () => {
    it('renders the hint state when no query and no items', () => {
        render(<MentionSuggestionList items={[]} query="" onSelect={() => undefined} />);
        const root = screen.getByTestId('kb-mention-suggestion-list');
        expect(root.getAttribute('data-empty')).toBe('true');
        expect(screen.getByTestId('kb-mention-suggestion-empty').textContent).toBe('hint');
    });

    it('renders the empty-for-query state when no items match a non-empty query', () => {
        render(<MentionSuggestionList items={[]} query="zzz" onSelect={() => undefined} />);
        expect(screen.getByTestId('kb-mention-suggestion-empty').textContent).toBe(
            'empty query=zzz',
        );
    });

    it('renders one Documents section and one Agents section with data-kind + data-count', () => {
        render(<MentionSuggestionList items={mixed} query="b" onSelect={() => undefined} />);
        const sections = screen.getAllByTestId('kb-mention-suggestion-section');
        expect(sections.length).toBe(2);
        expect(sections[0].getAttribute('data-kind')).toBe('doc');
        expect(sections[0].getAttribute('data-count')).toBe('2');
        expect(sections[1].getAttribute('data-kind')).toBe('agent');
        expect(sections[1].getAttribute('data-count')).toBe('1');
    });

    it('omits the Agents section when no agent items are present', () => {
        const docsOnly = mixed.filter((i) => i.kind === 'doc');
        render(<MentionSuggestionList items={docsOnly} query="b" onSelect={() => undefined} />);
        const sections = screen.getAllByTestId('kb-mention-suggestion-section');
        expect(sections.length).toBe(1);
        expect(sections[0].getAttribute('data-kind')).toBe('doc');
    });

    it('renders rows with the right per-kind data-attrs', () => {
        render(<MentionSuggestionList items={mixed} query="b" onSelect={() => undefined} />);
        const rows = screen.getAllByTestId('kb-mention-suggestion-item');
        expect(rows.length).toBe(3);
        expect(rows[0].getAttribute('data-kind')).toBe('doc');
        expect(rows[0].getAttribute('data-doc-path')).toBe('brand/voice.md');
        expect(rows[0].getAttribute('data-kb-class')).toBe('brand');
        expect(rows[0].getAttribute('data-active')).toBe('true');
        expect(rows[2].getAttribute('data-kind')).toBe('agent');
        expect(rows[2].getAttribute('data-agent-id')).toBe('claude-code');
        expect(rows[2].getAttribute('data-doc-path')).toBeNull();
    });

    it('moves the active cursor on hover (across sections)', () => {
        render(<MentionSuggestionList items={mixed} query="b" onSelect={() => undefined} />);
        const rows = screen.getAllByTestId('kb-mention-suggestion-item');
        fireEvent.mouseEnter(rows[2]);
        expect(rows[2].getAttribute('data-active')).toBe('true');
        expect(rows[0].getAttribute('data-active')).toBe('false');
    });

    it('calls onSelect with the right kind when a row is clicked', () => {
        const onSelect = vi.fn();
        render(<MentionSuggestionList items={mixed} query="b" onSelect={onSelect} />);
        fireEvent.click(screen.getAllByTestId('kb-mention-suggestion-item')[2]);
        expect(onSelect).toHaveBeenCalledWith(mixed[2]);
    });

    it('keyboard nav walks across both sections via the global cursor', () => {
        const onSelect = vi.fn();
        const ref = createRef<MentionSuggestionListHandle>();
        render(<MentionSuggestionList items={mixed} query="b" onSelect={onSelect} ref={ref} />);

        // Two ArrowDowns: doc-a (0) → doc-b (1) → claude-code (2).
        act(() => {
            ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        });
        act(() => {
            ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        });
        const rows = screen.getAllByTestId('kb-mention-suggestion-item');
        expect(rows[2].getAttribute('data-active')).toBe('true');

        act(() => {
            ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
        });
        expect(onSelect).toHaveBeenCalledWith(mixed[2]);
    });

    it('returns false for unhandled keys', () => {
        const ref = createRef<MentionSuggestionListHandle>();
        render(
            <MentionSuggestionList items={mixed} query="b" onSelect={() => undefined} ref={ref} />,
        );
        expect(ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
    });
});
