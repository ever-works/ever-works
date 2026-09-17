import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMentionCandidate } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const listMentionCandidates = vi.fn();
vi.mock('@/app/actions/dashboard/conversations', () => ({
    listMentionCandidates: (query: string) => listMentionCandidates(query),
}));

import {
    confirmedMentionCandidates,
    MENTION_PICKER_DEBOUNCE_MS,
    resetMentionCandidateCache,
} from '@/lib/hooks/use-mention-candidates';
import { findActiveMentionToken, MentionPicker, useMentionPicker } from './MentionPicker';

const orion: ConversationMentionCandidate = {
    type: 'agent',
    id: 'a-orion',
    slug: 'orion',
    name: 'Orion',
    status: 'active',
};
const ordering: ConversationMentionCandidate = {
    type: 'agent',
    id: 'a-ordering',
    slug: 'ordering-desk',
    name: 'Ordering desk',
    status: 'paused',
};

/** The composer's wiring in miniature: an uncontrolled textarea that tells the picker where the caret is. */
function Harness({ onInsert = vi.fn() }: { onInsert?: (text: string) => void }) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [inserted, setInserted] = useState('');
    const picker = useMentionPicker({
        textareaRef,
        onInsert: (text) => {
            setInserted(text);
            onInsert(text);
        },
    });
    return (
        <div style={{ position: 'relative' }}>
            <MentionPicker state={picker} />
            <textarea
                aria-label="composer"
                ref={textareaRef}
                defaultValue=""
                onChange={(event) =>
                    picker.update(event.target.value, event.target.selectionStart ?? 0)
                }
                onKeyDown={(event) => {
                    picker.handleKeyDown(event);
                }}
            />
            <output data-testid="inserted">{inserted}</output>
        </div>
    );
}

function type(text: string) {
    const textarea = screen.getByLabelText('composer') as HTMLTextAreaElement;
    // A change event moves the caret to the end of the new value, as typing does.
    fireEvent.change(textarea, { target: { value: text } });
    return textarea;
}

async function settle() {
    await act(async () => {
        vi.advanceTimersByTime(MENTION_PICKER_DEBOUNCE_MS + 1);
    });
    await act(async () => {
        await Promise.resolve();
    });
}

describe('findActiveMentionToken', () => {
    it('finds the @ word the caret is in', () => {
        expect(findActiveMentionToken('get @or', 7)).toEqual({ start: 4, query: 'or' });
    });

    it('ignores an @ inside a word, like an email address', () => {
        expect(findActiveMentionToken('mail me@nova', 12)).toBeNull();
    });

    it('leaves the document-reference syntax alone', () => {
        expect(findActiveMentionToken('read @kb:brand', 14)).toBeNull();
    });

    it('keeps one space for a two-word name and ends at the second', () => {
        expect(findActiveMentionToken('@Nova Pri', 9)).toEqual({ start: 0, query: 'Nova Pri' });
        expect(findActiveMentionToken('@Nova can you', 13)).toBeNull();
    });
});

describe('MentionPicker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetMentionCandidateCache();
        listMentionCandidates.mockReset();
        listMentionCandidates.mockResolvedValue({
            ok: true,
            data: { candidates: [orion, ordering] },
        });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('debounces keystrokes into one request', async () => {
        render(<Harness />);
        type('@o');
        type('@or');
        expect(listMentionCandidates).not.toHaveBeenCalled();
        await settle();
        expect(listMentionCandidates).toHaveBeenCalledTimes(1);
        expect(listMentionCandidates).toHaveBeenCalledWith('or');
    });

    it('lists candidates with the keyboard hint, and remembers them as confirmed', async () => {
        render(<Harness />);
        type('Nova, get @or');
        await settle();
        const options = screen.getAllByRole('option');
        expect(options.map((option) => option.textContent)).toEqual([
            'Orion@orion',
            'Ordering desk@ordering-desk',
        ]);
        expect(options[0]).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText('pickerHint')).toBeInTheDocument();
        expect(confirmedMentionCandidates().map((candidate) => candidate.id)).toEqual([
            'a-orion',
            'a-ordering',
        ]);
    });

    it('moves with ↓ and inserts the highlighted name with Enter', async () => {
        const onInsert = vi.fn();
        render(<Harness onInsert={onInsert} />);
        const textarea = type('Nova, get @or');
        await settle();

        fireEvent.keyDown(textarea, { key: 'ArrowDown' });
        expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
        fireEvent.keyDown(textarea, { key: 'Enter' });

        expect(onInsert).toHaveBeenCalledWith('Nova, get @Ordering desk ');
        expect(textarea.value).toBe('Nova, get @Ordering desk ');
        expect(screen.queryByTestId('conversation-mention-picker')).toBeNull();
    });

    it('inserts with Tab too', async () => {
        const onInsert = vi.fn();
        render(<Harness onInsert={onInsert} />);
        const textarea = type('@or');
        await settle();
        fireEvent.keyDown(textarea, { key: 'Tab' });
        expect(onInsert).toHaveBeenCalledWith('@Orion ');
    });

    it('dismisses with Esc and keeps the text exactly as typed', async () => {
        const onInsert = vi.fn();
        render(<Harness onInsert={onInsert} />);
        const textarea = type('ping @or');
        await settle();
        fireEvent.keyDown(textarea, { key: 'Escape' });
        expect(screen.queryByTestId('conversation-mention-picker')).toBeNull();
        expect(textarea.value).toBe('ping @or');
        expect(onInsert).not.toHaveBeenCalled();
    });

    it('says so when nothing matches', async () => {
        listMentionCandidates.mockResolvedValue({ ok: true, data: { candidates: [] } });
        render(<Harness />);
        type('@zz');
        await settle();
        expect(screen.getByText('noMatch:{"query":"zz"}')).toBeInTheDocument();
        expect(screen.getByText('noMatchHint')).toBeInTheDocument();
    });

    it('treats a failed lookup as no candidates, never an error', async () => {
        listMentionCandidates.mockResolvedValue({
            ok: false,
            status: 500,
            failureCode: null,
            details: {},
        });
        render(<Harness />);
        type('@or');
        await settle();
        expect(screen.queryAllByRole('option')).toHaveLength(0);
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
