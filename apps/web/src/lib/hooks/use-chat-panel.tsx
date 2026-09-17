'use client';

import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    type Dispatch,
    type ReactNode,
    type SetStateAction,
} from 'react';

/**
 * Lightweight context exposing the dashboard chat panel's open/close
 * controls so pages can collapse the panel programmatically (e.g.
 * the `/new` page wants the prompt to take the full main column on
 * first land). The provider is mounted by the dashboard layout
 * client; consumers outside the dashboard layout get `null` and can
 * skip the call.
 */
export interface ChatPanelControls {
    open: boolean;
    setOpen: (value: boolean) => void;
}

const ChatPanelContext = createContext<ChatPanelControls | null>(null);

export function ChatPanelProvider({
    open,
    setOpen,
    children,
}: ChatPanelControls & { children: ReactNode }) {
    const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);
    return <ChatPanelContext.Provider value={value}>{children}</ChatPanelContext.Provider>;
}

export function useChatPanel(): ChatPanelControls | null {
    return useContext(ChatPanelContext);
}

/**
 * Whether the docked panel's contents are on screen. On desktop the panel
 * stays mounted while closed or collapsed (so its view stack, drafts and
 * scroll position survive), which means anything inside it that holds a
 * connection open has to ask this instead of relying on unmount. Outside the
 * panel there is no provider and the answer is `true`: a view rendered
 * elsewhere is on screen whenever it is mounted.
 */
const ChatPanelVisibleContext = createContext<boolean>(true);

export function ChatPanelVisibleProvider({
    visible,
    children,
}: {
    visible: boolean;
    children?: ReactNode;
}) {
    return (
        <ChatPanelVisibleContext.Provider value={visible}>
            {children}
        </ChatPanelVisibleContext.Provider>
    );
}

export function useChatPanelVisible(): boolean {
    return useContext(ChatPanelVisibleContext);
}

// ── Resize affordances for the docked panel's drag handle ─────────────────
//
// Pure helpers, so the layout's handle and its spec agree on the numbers. The
// pointer-drag clamp in `layout-client.tsx` is left exactly as it is; these
// only serve the double-click reset and the keyboard (FR-16, FR-17, §6.12).

/** Narrowest the panel may be made. */
export const CHAT_PANEL_MIN_WIDTH = 350;
/** The width a double-click or `Home` restores (FR-17). */
export const CHAT_PANEL_RESET_WIDTH = 420;
/** How far one `←` / `→` press moves the edge. */
export const CHAT_PANEL_KEYBOARD_STEP = 16;
/** Widest the panel may be, as a share of the viewport (FR-16). */
export const CHAT_PANEL_MAX_VIEWPORT_SHARE = 0.5;

/** Bound a width to ≥ 350 px and ≤ half the viewport. */
export function clampChatPanelWidth(width: number, viewportWidth: number): number {
    const max = Math.floor(viewportWidth * CHAT_PANEL_MAX_VIEWPORT_SHARE);
    return Math.max(CHAT_PANEL_MIN_WIDTH, Math.min(max, Math.round(width)));
}

/** The width the reset gestures restore, bounded like every other width. */
export function resetChatPanelWidth(viewportWidth: number): number {
    return clampChatPanelWidth(CHAT_PANEL_RESET_WIDTH, viewportWidth);
}

/**
 * The width a key press on the focused handle asks for, or `null` for a key
 * the handle does not use. The handle sits on the panel's right edge, so `→`
 * widens and `←` narrows.
 */
export function chatPanelWidthForKey(
    key: string,
    width: number,
    viewportWidth: number,
): number | null {
    if (key === 'ArrowRight')
        return clampChatPanelWidth(width + CHAT_PANEL_KEYBOARD_STEP, viewportWidth);
    if (key === 'ArrowLeft')
        return clampChatPanelWidth(width - CHAT_PANEL_KEYBOARD_STEP, viewportWidth);
    if (key === 'Home') return resetChatPanelWidth(viewportWidth);
    return null;
}

// ── Persisted width of the docked panel ───────────────────────────────────

/** The width the panel starts at before anything has been saved. */
export const DEFAULT_CHAT_PANEL_WIDTH = 380;

/** localStorage key the resizable width is remembered under. */
export const CHAT_PANEL_WIDTH_STORAGE_KEY = 'chat-width';

/**
 * The width the previous session saved, or `null` when nothing usable is
 * stored — a first visit, cleared storage, or a corrupted value.
 */
export function readSavedChatPanelWidth(): number | null {
    try {
        const raw = localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY);
        if (!raw) return null;
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The width a saved value may actually be adopted at on THIS viewport.
 *
 * A width is clamped when it is dragged, but it is dragged against the
 * viewport of the moment: half of a 3440 px ultrawide is 1720, and that
 * number is what gets saved. Opened later in a 1366 px window it would take
 * more than the whole screen. `layout-client.tsx` used to carry a mount-time
 * effect for exactly this, but with `[]` deps it closed over the first
 * render's width — always the default — so it only ever fired below 760 px.
 * Before EW-817 that did not show, because the race overwrote the saved width
 * anyway; now the saved width is authoritative, so the guard has to live
 * where the value is actually known. FR-16: at most half the viewport.
 *
 * Both bounds, not just the upper one. A viewport narrow enough that half of
 * it is under {@link CHAT_PANEL_MIN_WIDTH} has no valid width left to pick, so
 * there the 240 floor of the effect this replaces is kept — and a 240 saved
 * that way would otherwise be adopted verbatim on the next desktop visit,
 * docking the panel 110 px below the minimum its own handle advertises as
 * `aria-valuemin`. Anywhere else, `clampChatPanelWidth` applies the same
 * [min, half-viewport] bounds the drag and keyboard paths already enforce.
 */
export function adoptableChatPanelWidth(saved: number | null): number {
    const width = saved ?? DEFAULT_CHAT_PANEL_WIDTH;
    try {
        const max = Math.floor(window.innerWidth * CHAT_PANEL_MAX_VIEWPORT_SHARE);
        // Nothing in [CHAT_PANEL_MIN_WIDTH, max] to choose from: this is the
        // mobile-overlay range, where no docked panel renders at all.
        if (max < CHAT_PANEL_MIN_WIDTH) return Math.max(240, max);
        return clampChatPanelWidth(width, window.innerWidth);
    } catch {
        // No window (or a hostile one): the unclamped width is still better
        // than losing the user's preference outright.
        return width;
    }
}

/**
 * The docked panel's resizable width, round-tripped through localStorage.
 *
 * The `savedWidthAdopted` gate between the two effects below is the whole
 * point (EW-817) — the gate alone, not their declaration order, which is not
 * load-bearing: a state flag is only observable in a LATER commit, so putting
 * the persist effect first changes nothing. (Checked, by swapping them: the
 * suite stays green. The claim that the order mattered was in this comment
 * first, and it was wrong in the way that costs the most — it invites the
 * next reader to preserve the order while swapping the state gate for a ref,
 * which is the one substitution that actually breaks this.) Storage may only be written
 * once the saved width has been read *and* committed to state — otherwise the
 * persist effect fires on the first commit, while `chatWidth` is still the
 * default, and overwrites the width the user dragged to last session.
 *
 * The gate is state rather than a ref on purpose, and the difference is not
 * stylistic. A ref flips during the very commit the read happens in, so the
 * persist effect — which runs straight after, still holding the first render's
 * `chatWidth` in its closure — sees an open gate and writes the default to
 * storage. It then corrects itself on the next render, so a single mount ends
 * up looking right; but under React's StrictMode double mount (dev builds) the
 * read effect runs a second time in that same commit, reads the default back,
 * and the panel snaps to 380 again. A state flag cannot do that: it only opens
 * the gate in a later render, one where `chatWidth` is already the adopted
 * width, so the default is never written at all and a second read has nothing
 * stale to find. `use-chat-panel.unit.spec.ts` pins that no-intermediate-write
 * property directly, because jsdom does not reproduce the double invocation.
 *
 * The flag also keeps a first-ever visit persisting the default: it changes
 * even when the width does not, so the persist effect still gets its turn.
 *
 * ## What this hook CANNOT do for you
 *
 * `isChatExpanded` suppresses the write while it is true; it cannot suppress
 * the write on the commit where it goes true → false. On that commit
 * `chatWidth` is whatever the caller left there, and if that is still the
 * expanded width, the expanded width is what gets persisted. The hook has no
 * way to tell "1240 because the panel is expanded" from "1240 because the
 * user dragged there" — expansion sets the flag and the width in one batch,
 * so by the time the hook sees the flag the pre-expand width is already gone.
 *
 * So the contract is on the caller: **every path out of expanded mode must
 * restore the resizable width in the same batch as clearing the flag.**
 * `ensureResizableMode`, `setChatOpen(true, true)`, `startDrag`,
 * `resetChatWidth` and `handleResizeKey` all do. `handleCollapse` did not
 * until EW-817's follow-up, and one click of the collapse chevron therefore
 * wrote the expanded width over the user's saved one.
 */
export function useChatPanelWidth(
    isChatExpanded: boolean,
): readonly [number, Dispatch<SetStateAction<number>>] {
    const [chatWidth, setChatWidth] = useState<number>(DEFAULT_CHAT_PANEL_WIDTH);
    const [savedWidthAdopted, setSavedWidthAdopted] = useState(false);

    // Adopted after mount, never during render: browser storage does not exist
    // on the server, so reading it while rendering would make the server HTML
    // and the hydrated panel disagree on the width.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: the saved width is only knowable after mount.
        setChatWidth(adoptableChatPanelWidth(readSavedChatPanelWidth()));
        // Opens the persist gate below — in a later render, where `chatWidth`
        // is already the adopted width.
        setSavedWidthAdopted(true);
    }, []);

    useEffect(() => {
        if (!savedWidthAdopted) return;
        // Only persist the width in resizable (non-expanded) mode. This keeps
        // the expanded width from overwriting the user's preferred resizable
        // width in localStorage.
        if (isChatExpanded) return;
        try {
            localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, String(chatWidth));
        } catch {}
    }, [chatWidth, isChatExpanded, savedWidthAdopted]);

    return [chatWidth, setChatWidth] as const;
}
