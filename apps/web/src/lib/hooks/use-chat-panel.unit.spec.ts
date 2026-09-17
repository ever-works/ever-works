import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
    CHAT_PANEL_KEYBOARD_STEP,
    CHAT_PANEL_MIN_WIDTH,
    CHAT_PANEL_RESET_WIDTH,
    ChatPanelVisibleProvider,
    chatPanelWidthForKey,
    clampChatPanelWidth,
    resetChatPanelWidth,
    useChatPanelVisible,
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
