'use client';

import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/** What a keystroke inside the open palette asks for. */
export type PaletteKeyAction =
    | { type: 'none' }
    | { type: 'close' }
    | { type: 'applyFilter' }
    | { type: 'removeFilter' }
    | { type: 'openInNewTab' }
    | { type: 'activateIndex'; index: number }
    | { type: 'retry' };

export interface PaletteKeyState {
    query: string;
    hasFilter: boolean;
    /** The last search timed out or failed; `Enter` re-issues it instead of opening. */
    retryPending: boolean;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/**
 * The palette's own key map, on top of what the list primitive already does
 * (`↑` `↓` `Home` `End` `Enter`, skipping disabled rows):
 *
 * | Key                      | Action                                   |
 * | ------------------------ | ---------------------------------------- |
 * | `Esc`                    | remove the filter chip, else close       |
 * | `Tab`                    | narrow to the selected row's group       |
 * | `Shift+Tab`              | remove the filter chip                   |
 * | `Backspace` (empty box)  | remove the filter chip, else close       |
 * | `Ctrl/Cmd+Enter`         | open the selected record in a new tab    |
 * | `Enter` after a failure  | retry the search                         |
 * | `Ctrl/Cmd+1..9`          | activate the nth visible row             |
 *
 * Pure, so the whole table is unit-testable without rendering.
 */
export function resolvePaletteKey(event: KeyLike, state: PaletteKeyState): PaletteKeyAction {
    const mod = event.ctrlKey || event.metaKey;

    switch (event.key) {
        case 'Escape':
            return state.hasFilter ? { type: 'removeFilter' } : { type: 'close' };
        case 'Tab':
            if (event.shiftKey)
                return state.hasFilter ? { type: 'removeFilter' } : { type: 'none' };
            return mod || event.altKey ? { type: 'none' } : { type: 'applyFilter' };
        case 'Backspace':
            if (state.query.length > 0 || mod || event.altKey) return { type: 'none' };
            return state.hasFilter ? { type: 'removeFilter' } : { type: 'close' };
        case 'Enter':
            if (mod) return { type: 'openInNewTab' };
            return state.retryPending ? { type: 'retry' } : { type: 'none' };
        default:
            break;
    }

    if (mod && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        return { type: 'activateIndex', index: Number(event.key) - 1 };
    }
    return { type: 'none' };
}

export interface PaletteKeyboardHandlers {
    close: () => void;
    applyFilter: () => void;
    removeFilter: () => void;
    openInNewTab: () => void;
    activateIndex: (index: number) => void;
    retry: () => void;
}

/**
 * `onKeyDown` for the palette root. A handled key is consumed
 * (`preventDefault`), which also stops the dialog from treating `Esc` as
 * "close" while a filter chip is still there to remove.
 */
export function usePaletteKeyboard(state: PaletteKeyState, handlers: PaletteKeyboardHandlers) {
    const { query, hasFilter, retryPending } = state;
    const { close, applyFilter, removeFilter, openInNewTab, activateIndex, retry } = handlers;

    return useCallback(
        (event: ReactKeyboardEvent<HTMLElement>) => {
            if (event.nativeEvent.isComposing) return;
            const action = resolvePaletteKey(event, { query, hasFilter, retryPending });
            if (action.type === 'none') return;
            event.preventDefault();
            switch (action.type) {
                case 'close':
                    close();
                    break;
                case 'applyFilter':
                    applyFilter();
                    break;
                case 'removeFilter':
                    removeFilter();
                    break;
                case 'openInNewTab':
                    openInNewTab();
                    break;
                case 'activateIndex':
                    activateIndex(action.index);
                    break;
                case 'retry':
                    retry();
                    break;
            }
        },
        [
            query,
            hasFilter,
            retryPending,
            close,
            applyFilter,
            removeFilter,
            openInNewTab,
            activateIndex,
            retry,
        ],
    );
}
