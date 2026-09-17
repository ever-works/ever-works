import { createElement, StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    adoptableChatPanelWidth,
    CHAT_PANEL_KEYBOARD_STEP,
    CHAT_PANEL_MIN_WIDTH,
    CHAT_PANEL_RESET_WIDTH,
    CHAT_PANEL_WIDTH_STORAGE_KEY,
    ChatPanelVisibleProvider,
    chatPanelWidthForKey,
    clampChatPanelWidth,
    DEFAULT_CHAT_PANEL_WIDTH,
    resetChatPanelWidth,
    useChatPanelVisible,
    useChatPanelWidth,
} from './use-chat-panel';

/**
 * The docked panel's resize handle (FR-16, FR-17, spec §6.12): bounded to at
 * least 350 px and at most half the viewport, double-click or Home resets to
 * 420 px, and ←/→ move the edge by 16 px when the handle has focus.
 */
describe('chat panel resize helpers', () => {
    const viewport = 1600;

    it('bounds every width to 350 px and half the viewport', () => {
        expect(clampChatPanelWidth(100, viewport)).toBe(CHAT_PANEL_MIN_WIDTH);
        expect(clampChatPanelWidth(5000, viewport)).toBe(800);
        expect(clampChatPanelWidth(512.4, viewport)).toBe(512);
    });

    it('resets to 420 px', () => {
        expect(resetChatPanelWidth(viewport)).toBe(CHAT_PANEL_RESET_WIDTH);
        expect(chatPanelWidthForKey('Home', 700, viewport)).toBe(CHAT_PANEL_RESET_WIDTH);
    });

    it('never resets past half of a narrow viewport', () => {
        // Half of 780 is 390; the 350 px floor still wins over anything smaller.
        expect(resetChatPanelWidth(780)).toBe(390);
        expect(resetChatPanelWidth(600)).toBe(CHAT_PANEL_MIN_WIDTH);
    });

    it('moves the edge by 16 px per arrow key, within bounds', () => {
        expect(chatPanelWidthForKey('ArrowRight', 500, viewport)).toBe(
            500 + CHAT_PANEL_KEYBOARD_STEP,
        );
        expect(chatPanelWidthForKey('ArrowLeft', 500, viewport)).toBe(
            500 - CHAT_PANEL_KEYBOARD_STEP,
        );
        expect(chatPanelWidthForKey('ArrowLeft', 352, viewport)).toBe(CHAT_PANEL_MIN_WIDTH);
        expect(chatPanelWidthForKey('ArrowRight', 795, viewport)).toBe(800);
    });

    it('ignores every other key', () => {
        expect(chatPanelWidthForKey('Enter', 500, viewport)).toBeNull();
        expect(chatPanelWidthForKey('a', 500, viewport)).toBeNull();
    });
});

/**
 * The docked panel stays mounted while closed or collapsed; views inside it
 * read this flag to stand down live delivery until it is on screen again.
 */
describe('useChatPanelVisible', () => {
    it('is on screen outside the docked panel', () => {
        const { result } = renderHook(() => useChatPanelVisible());
        expect(result.current).toBe(true);
    });

    it('follows the docked panel open and closed', () => {
        let panelOpen = true;
        const { result, rerender } = renderHook(() => useChatPanelVisible(), {
            wrapper: ({ children }: { children: ReactNode }) =>
                createElement(ChatPanelVisibleProvider, { visible: panelOpen }, children),
        });
        expect(result.current).toBe(true);
        panelOpen = false;
        rerender();
        expect(result.current).toBe(false);
        panelOpen = true;
        rerender();
        expect(result.current).toBe(true);
    });
});

/**
 * EW-817 — the width the user dragged the panel to must survive a reload.
 *
 * The regression this pins: the mount-time read of `chat-width` and the
 * effect that persists `chatWidth` raced. The persist effect ran on the
 * first commit, when `chatWidth` was still the 380 px default, and wrote
 * that over the saved value before the read had been applied — so a
 * resized panel snapped back to the default on every reload, in state and
 * in storage. These drive the real hook the dashboard layout calls, not a
 * transcription of its effects.
 */
describe('useChatPanelWidth', () => {
    const strictMode = ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, children);

    const stored = () => window.localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY);

    beforeEach(() => {
        window.localStorage.clear();
    });

    it('keeps a width saved by the previous session', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');

        const { result } = renderHook(() => useChatPanelWidth(false));

        expect(result.current[0]).toBe(452);
        expect(stored()).toBe('452');
    });

    /**
     * The StrictMode safety net. React double-invokes mount effects in a dev
     * browser build, so the read effect runs twice against whatever storage
     * holds at that moment — but jsdom under `act()` does not reproduce that
     * (StrictMode double-renders here, it does not re-run effects), so mounting
     * inside `<StrictMode>` cannot catch it on its own.
     *
     * What makes the double invocation safe is the property asserted here: while
     * the saved width is being adopted, the default is never written to storage
     * at all. If it were — as it is with a ref-based gate, which opens during the
     * same commit as the read — the second invocation would read that default
     * back and the panel would snap to 380 again.
     */
    it('never writes the default over a saved width while adopting it', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');

        const writes: string[] = [];
        const realSetItem = Storage.prototype.setItem;
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
            this: Storage,
            key: string,
            value: string,
        ) {
            if (key === CHAT_PANEL_WIDTH_STORAGE_KEY) writes.push(value);
            realSetItem.call(this, key, value);
        });

        try {
            const { result } = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });
            expect(result.current[0]).toBe(452);
        } finally {
            spy.mockRestore();
        }

        expect(writes).not.toContain(String(DEFAULT_CHAT_PANEL_WIDTH));
        expect(stored()).toBe('452');
    });

    /**
     * A round-trip smoke test, and deliberately labelled as one: it does NOT
     * pin EW-817. With the persist gate deleted — the pre-fix ordering — this
     * still passes, because the hook self-corrects to 452 within the same
     * mount and the end state is the same either way. The regression is
     * caught only by the `setItem` spy above, which is the awkward-looking
     * test in this file and therefore the one most likely to be tidied away.
     * If you are here to simplify: delete THIS one, not that one.
     */
    it('survives an unmount and remount at the saved width', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');

        const first = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });
        expect(first.result.current[0]).toBe(452);
        first.unmount();

        const second = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });
        expect(second.result.current[0]).toBe(452);
        expect(stored()).toBe('452');
    });

    it('falls back to the default and persists it on a first-ever visit', () => {
        const { result } = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });

        expect(result.current[0]).toBe(DEFAULT_CHAT_PANEL_WIDTH);
        expect(stored()).toBe(String(DEFAULT_CHAT_PANEL_WIDTH));
    });

    it('falls back to the default when the stored value is unusable', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, 'not-a-width');

        const { result } = renderHook(() => useChatPanelWidth(false));

        expect(result.current[0]).toBe(DEFAULT_CHAT_PANEL_WIDTH);
        expect(stored()).toBe(String(DEFAULT_CHAT_PANEL_WIDTH));
    });

    it('persists a width the user drags to', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');
        const { result } = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });

        act(() => {
            result.current[1](600);
        });

        expect(result.current[0]).toBe(600);
        expect(stored()).toBe('600');
    });

    it('writes nothing at all while the panel is expanded', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');

        let isChatExpanded = false;
        const { result } = renderHook(() => useChatPanelWidth(isChatExpanded), {
            wrapper: strictMode,
        });
        expect(stored()).toBe('452');

        // `handleExpand` widens the panel and flips it to expanded in one batch.
        act(() => {
            isChatExpanded = true;
            result.current[1](1240);
        });
        expect(result.current[0]).toBe(1240);
        expect(stored()).toBe('452');

        // Leaving expanded mode resumes persisting — and what it persists is
        // whatever the CALLER left in `chatWidth` on that commit. This models
        // `startDrag`, `resetChatWidth` and `handleResizeKey`, which each set
        // a NEW width alongside the flag. It is NOT `ensureResizableMode`:
        // that one sets the width to the value it just read back out of
        // storage, so it round-trips 452 to 452 and can never persist
        // anything new. Saying otherwise here is what made the gap below
        // invisible.
        act(() => {
            isChatExpanded = false;
            result.current[1](520);
        });
        expect(stored()).toBe('520');
    });

    /**
     * The other half of that story, and the reason this file no longer has a
     * test called "never lets the expanded width overwrite the preferred
     * resizable width": the hook cannot promise that, and the test that
     * claimed to pin it only passed because it also restored a width.
     *
     * On the commit where `isChatExpanded` goes true → false, `chatWidth` is
     * whatever the caller left there. The hook cannot tell the expanded width
     * from a width the user dragged to, so a caller that clears the flag
     * WITHOUT restoring the width persists the expanded one. This asserts the
     * behaviour as it really is, and `layout-client.tsx`'s `handleCollapse`
     * carries the other side of the contract — it was the one path that did
     * not honour it, which is how one click of the collapse chevron replaced
     * a saved 452 with 1240.
     */
    it('persists whatever the caller leaves behind when the expanded flag clears', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');

        let isChatExpanded = false;
        const { result, rerender } = renderHook(() => useChatPanelWidth(isChatExpanded), {
            wrapper: strictMode,
        });

        act(() => {
            isChatExpanded = true;
            result.current[1](1240);
        });
        expect(stored()).toBe('452');

        // Clear the flag and touch nothing else — the shape `handleCollapse`
        // had before EW-817's follow-up.
        act(() => {
            isChatExpanded = false;
            rerender();
        });
        expect(stored()).toBe('1240');
    });

    it('clamps a saved width wider than half the viewport on adoption', () => {
        // A width dragged on a much wider monitor: legal when it was saved,
        // 88% of the viewport here. jsdom reports innerWidth 1024.
        expect(window.innerWidth).toBe(1024);
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '900');

        const { result } = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });

        expect(result.current[0]).toBe(512);
        // And storage self-heals, so the next reload starts from the clamped
        // width rather than clamping again.
        expect(stored()).toBe('512');
    });

    it('leaves a saved width that already fits alone', () => {
        window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, '452');

        const { result } = renderHook(() => useChatPanelWidth(false), { wrapper: strictMode });

        expect(result.current[0]).toBe(452);
    });
});

describe('adoptableChatPanelWidth', () => {
    it('clamps to half the viewport, and only then', () => {
        // innerWidth 1024 → half is 512.
        expect(adoptableChatPanelWidth(900)).toBe(512);
        expect(adoptableChatPanelWidth(512)).toBe(512);
        expect(adoptableChatPanelWidth(511)).toBe(511);
    });

    it('falls back to the default when nothing was saved', () => {
        expect(adoptableChatPanelWidth(null)).toBe(DEFAULT_CHAT_PANEL_WIDTH);
    });

    /**
     * The narrow-viewport floor is reachable in the other direction, which is
     * what makes clamping BOTH bounds necessary rather than tidy. A phone-width
     * window adopts and persists 240; widen the same browser to a desktop size
     * and, with only the upper bound clamped, 240 would be adopted verbatim and
     * dock the panel 110px below the `aria-valuemin` its own handle publishes.
     */
    it('raises a width saved on a narrow viewport back to the minimum', () => {
        expect(adoptableChatPanelWidth(240)).toBe(CHAT_PANEL_MIN_WIDTH);
    });

    /**
     * The floor is 240 rather than CHAT_PANEL_MIN_WIDTH (350) — the floor the
     * mount-time effect in layout-client.tsx used before this moved here.
     * It only binds below 480px of viewport, where the layout renders the
     * mobile overlay and no docked panel exists, so this pins the carried-over
     * behaviour rather than a reachable one.
     */
    it('does not go below 240 on a viewport too narrow for anything else', () => {
        const original = window.innerWidth;
        try {
            Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
            expect(adoptableChatPanelWidth(900)).toBe(240);
        } finally {
            Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
        }
    });
});
