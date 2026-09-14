import { describe, expect, it } from 'vitest';
import { resolvePaletteKey, type PaletteKeyState } from './use-palette-keyboard';

function key(
    value: string,
    modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {},
) {
    return {
        key: value,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...modifiers,
    };
}

const idle: PaletteKeyState = { query: 'inv', hasFilter: false, retryPending: false };
const filtered: PaletteKeyState = { ...idle, hasFilter: true };

describe('resolvePaletteKey', () => {
    it('Esc removes the filter chip first, then closes', () => {
        expect(resolvePaletteKey(key('Escape'), filtered)).toEqual({ type: 'removeFilter' });
        expect(resolvePaletteKey(key('Escape'), idle)).toEqual({ type: 'close' });
    });

    it('Tab narrows to the selected group; Shift+Tab removes the chip', () => {
        expect(resolvePaletteKey(key('Tab'), idle)).toEqual({ type: 'applyFilter' });
        expect(resolvePaletteKey(key('Tab', { shiftKey: true }), filtered)).toEqual({
            type: 'removeFilter',
        });
        expect(resolvePaletteKey(key('Tab', { shiftKey: true }), idle)).toEqual({ type: 'none' });
    });

    it('Backspace on an empty box removes the chip, else closes; with text it just edits', () => {
        expect(resolvePaletteKey(key('Backspace'), { ...filtered, query: '' })).toEqual({
            type: 'removeFilter',
        });
        expect(resolvePaletteKey(key('Backspace'), { ...idle, query: '' })).toEqual({
            type: 'close',
        });
        expect(resolvePaletteKey(key('Backspace'), idle)).toEqual({ type: 'none' });
    });

    it('Ctrl/Cmd+Enter opens in a new tab; Enter retries only after a failure', () => {
        expect(resolvePaletteKey(key('Enter', { ctrlKey: true }), idle)).toEqual({
            type: 'openInNewTab',
        });
        expect(resolvePaletteKey(key('Enter', { metaKey: true }), idle)).toEqual({
            type: 'openInNewTab',
        });
        expect(resolvePaletteKey(key('Enter'), { ...idle, retryPending: true })).toEqual({
            type: 'retry',
        });
        // A plain Enter is left to the list, which opens the selected row.
        expect(resolvePaletteKey(key('Enter'), idle)).toEqual({ type: 'none' });
    });

    it('Ctrl/Cmd+1..9 activates the nth row, and nothing else does', () => {
        expect(resolvePaletteKey(key('1', { ctrlKey: true }), idle)).toEqual({
            type: 'activateIndex',
            index: 0,
        });
        expect(resolvePaletteKey(key('9', { metaKey: true }), idle)).toEqual({
            type: 'activateIndex',
            index: 8,
        });
        expect(resolvePaletteKey(key('0', { ctrlKey: true }), idle)).toEqual({ type: 'none' });
        expect(resolvePaletteKey(key('3'), idle)).toEqual({ type: 'none' });
    });

    it('leaves arrows, Home and End to the list', () => {
        for (const value of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
            expect(resolvePaletteKey(key(value), idle)).toEqual({ type: 'none' });
        }
    });
});
