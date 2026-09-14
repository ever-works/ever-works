import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    __resetShortcutRegistryForTests,
    dispatchShortcut,
    isEditableTarget,
    isModKey,
    listShortcuts,
    registerShortcut,
    resolveShortcut,
    SHORTCUT_PRIORITY,
    SHORTCUT_SCOPE,
} from './shortcut-registry';

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

const ctrlK = (event: KeyboardEvent) => isModKey(event, 'k');

describe('shortcut registry', () => {
    afterEach(() => {
        __resetShortcutRegistryForTests();
        document.body.innerHTML = '';
    });

    it('runs only the highest-priority binding for a keystroke', () => {
        const global = vi.fn();
        const screen = vi.fn();
        registerShortcut({
            id: 'global',
            scope: SHORTCUT_SCOPE.global,
            match: ctrlK,
            handler: global,
        });
        registerShortcut({
            id: 'kb',
            scope: 'kb-workbench',
            priority: SHORTCUT_PRIORITY.screen,
            allowInInput: true,
            match: ctrlK,
            handler: screen,
        });

        const event = press({ key: 'k', ctrlKey: true });

        expect(screen).toHaveBeenCalledTimes(1);
        expect(global).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    it('hands the keystroke back to the global binding once the screen binding unregisters', () => {
        const global = vi.fn();
        registerShortcut({
            id: 'global',
            scope: SHORTCUT_SCOPE.global,
            match: ctrlK,
            handler: global,
        });
        const release = registerShortcut({
            id: 'kb',
            scope: 'kb-workbench',
            priority: SHORTCUT_PRIORITY.screen,
            match: ctrlK,
            handler: vi.fn(),
        });
        release();

        press({ key: 'K', metaKey: true });
        expect(global).toHaveBeenCalledTimes(1);
    });

    it('breaks a priority tie in favour of the binding registered last', () => {
        const first = vi.fn();
        const second = vi.fn();
        registerShortcut({ id: 'first', scope: 'a', match: ctrlK, handler: first });
        registerShortcut({ id: 'second', scope: 'b', match: ctrlK, handler: second });
        press({ key: 'k', ctrlKey: true });
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
    });

    it('skips plain-key bindings while typing, but not bindings that allow it', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        const slash = vi.fn();
        const chord = vi.fn();
        registerShortcut({
            id: 'slash',
            scope: 'global',
            match: (e) => e.key === '/',
            handler: slash,
        });
        registerShortcut({
            id: 'chord',
            scope: 'global',
            allowInInput: true,
            match: ctrlK,
            handler: chord,
        });

        const typed = press({ key: '/' }, input);
        press({ key: 'k', ctrlKey: true }, input);

        expect(slash).not.toHaveBeenCalled();
        expect(typed.defaultPrevented).toBe(false);
        expect(chord).toHaveBeenCalledTimes(1);
    });

    it('respects a plain key another handler already consumed', () => {
        const handler = vi.fn();
        registerShortcut({ id: 'c', scope: 'global', match: (e) => e.key === 'c', handler });
        const event = new KeyboardEvent('keydown', { key: 'c', cancelable: true });
        event.preventDefault();
        expect(dispatchShortcut(event)).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });

    it('can leave the default action alone when asked', () => {
        registerShortcut({
            id: 'x',
            scope: 'global',
            preventDefault: false,
            match: ctrlK,
            handler: vi.fn(),
        });
        expect(press({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    });

    it('lets an overlay ask who owns a key underneath it', () => {
        registerShortcut({
            id: 'global',
            scope: SHORTCUT_SCOPE.global,
            match: ctrlK,
            handler: vi.fn(),
        });
        registerShortcut({
            id: 'kb',
            scope: 'kb-workbench',
            priority: SHORTCUT_PRIORITY.screen,
            match: ctrlK,
            handler: vi.fn(),
        });
        registerShortcut({
            id: 'overlay',
            scope: SHORTCUT_SCOPE.overlay,
            priority: SHORTCUT_PRIORITY.overlay,
            match: ctrlK,
            handler: vi.fn(),
        });
        const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true });
        expect(resolveShortcut(event)?.id).toBe('overlay');
        expect(resolveShortcut(event, { maxPriority: SHORTCUT_PRIORITY.overlay - 1 })?.id).toBe(
            'kb',
        );
        expect(resolveShortcut(event, { maxPriority: SHORTCUT_PRIORITY.global })?.id).toBe(
            'global',
        );
    });

    it('ignores keystrokes that are part of an IME composition', () => {
        const handler = vi.fn();
        registerShortcut({ id: 'x', scope: 'global', allowInInput: true, match: ctrlK, handler });
        press({ key: 'k', ctrlKey: true, isComposing: true });
        expect(handler).not.toHaveBeenCalled();
    });

    it('lists and detaches bindings', () => {
        const handler = vi.fn();
        const release = registerShortcut({ id: 'x', scope: 'global', match: ctrlK, handler });
        expect(listShortcuts()).toEqual([{ id: 'x', scope: 'global', priority: undefined }]);
        release();
        expect(listShortcuts()).toEqual([]);
        press({ key: 'k', ctrlKey: true });
        expect(handler).not.toHaveBeenCalled();
    });

    it('recognises editable targets', () => {
        const editable = document.createElement('div');
        editable.contentEditable = 'true';
        Object.defineProperty(editable, 'isContentEditable', { value: true });
        expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
        expect(isEditableTarget(document.createElement('select'))).toBe(true);
        expect(isEditableTarget(editable)).toBe(true);
        expect(isEditableTarget(document.createElement('button'))).toBe(false);
        expect(isEditableTarget(window)).toBe(false);
        expect(isEditableTarget(null)).toBe(false);
    });

    it('matches Ctrl or Cmd with the key, but not with Alt', () => {
        expect(isModKey(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }), 'k')).toBe(true);
        expect(isModKey(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), 'k')).toBe(true);
        expect(
            isModKey(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true }), 'k'),
        ).toBe(false);
        expect(isModKey(new KeyboardEvent('keydown', { key: 'k' }), 'k')).toBe(false);
    });
});
