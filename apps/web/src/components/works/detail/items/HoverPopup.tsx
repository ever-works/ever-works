'use client';

import React, {
    useRef,
    useState,
    useCallback,
    useEffect,
    useLayoutEffect,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface HoverPopupProps {
    /**
     * Render prop for the trigger element.
     * `ref` is a callback ref — attach it via `ref={ref}` on the DOM node.
     */
    trigger: (ref: (el: HTMLElement | null) => void, props: TriggerProps) => ReactNode;
    /** The popup content */
    children: ReactNode;
    /** Extra classes on the popup wrapper */
    popupClassName?: string;
    /**
     * When true, clicking the trigger also calls `e.preventDefault()`.
     * Use this when the trigger lives inside an `<a>` / `<Link>` to prevent
     * card navigation when the user clicks the badge.
     */
    stopNavigation?: boolean;
}

export interface TriggerProps {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onClick: (e: React.MouseEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    /** Enter / Space to open; Escape to close */
    onKeyDown: (e: React.KeyboardEvent) => void;
    'aria-expanded': boolean;
    /** Tells AT the trigger opens a dialog */
    'aria-haspopup': 'dialog';
}

const MARGIN = 8;
const GAP = 6;

/**
 * Generic hover/touch/keyboard popup rendered in a React portal.
 *
 * Positioning: the popup starts offscreen and invisible; useLayoutEffect
 * measures its real size and sets the final position before the browser paints.
 *
 * Accessibility:
 * - The popup uses role="dialog" (not role="tooltip") because it contains
 *   interactive children (links, buttons).
 * - The trigger receives onKeyDown so Enter/Space open it and Escape closes it.
 * - The ref is passed as a callback ref (not a RefObject) to avoid the
 *   react-hooks/refs "cannot access ref during render" rule.
 */
export function HoverPopup({
    trigger,
    children,
    popupClassName,
    stopNavigation = false,
}: HoverPopupProps) {
    // Internal ref storage — written only in the callback ref, never read during render.
    const triggerElRef = useRef<HTMLElement | null>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    const [isOpen, setIsOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Stable callback ref — safe to pass during render (it's a function, not a RefObject).
    const triggerCallbackRef = useCallback((el: HTMLElement | null) => {
        triggerElRef.current = el;
    }, []);

    const applyPosition = useCallback(() => {
        const popup = popupRef.current;
        const trigger = triggerElRef.current;
        if (!popup || !trigger) return;

        const tr = trigger.getBoundingClientRect();
        const pw = popup.offsetWidth;
        const ph = popup.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let top = tr.top - ph - GAP;
        if (top < MARGIN) top = tr.bottom + GAP;

        let left = tr.left;
        if (left + pw > vw - MARGIN) left = vw - pw - MARGIN;
        if (left < MARGIN) left = MARGIN;

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        popup.style.opacity = '1';
    }, []);

    useLayoutEffect(() => {
        if (isOpen) applyPosition();
    }, [isOpen, applyPosition]);

    useEffect(() => {
        if (!isOpen) return;
        const reposition = () => applyPosition();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [isOpen, applyPosition]);

    // Close on outside click/touch
    useEffect(() => {
        if (!isOpen) return;
        const dismiss = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node;
            if (!triggerElRef.current?.contains(t) && !popupRef.current?.contains(t)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', dismiss);
        document.addEventListener('touchstart', dismiss);
        return () => {
            document.removeEventListener('mousedown', dismiss);
            document.removeEventListener('touchstart', dismiss);
        };
    }, [isOpen]);

    useEffect(() => {
        return () => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
        };
    }, []);

    const openPopup = useCallback(() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setIsOpen(true);
    }, []);

    const scheduleClose = useCallback(() => {
        closeTimer.current = setTimeout(() => setIsOpen(false), 150);
    }, []);

    const cancelClose = useCallback(() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
    }, []);

    const handleToggle = useCallback(
        (e: React.MouseEvent | React.TouchEvent) => {
            e.stopPropagation();
            if (stopNavigation) e.preventDefault();
            if (isOpen) {
                setIsOpen(false);
            } else {
                openPopup();
            }
        },
        [isOpen, openPopup, stopNavigation],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                if (isOpen) {
                    setIsOpen(false);
                } else {
                    openPopup();
                }
            } else if (e.key === 'Escape' && isOpen) {
                e.stopPropagation();
                setIsOpen(false);
                triggerElRef.current?.focus();
            }
        },
        [isOpen, openPopup],
    );

    const handlePopupKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            setIsOpen(false);
            triggerElRef.current?.focus();
        }
    }, []);

    const triggerProps: TriggerProps = {
        onMouseEnter: openPopup,
        onMouseLeave: scheduleClose,
        onClick: handleToggle,
        onTouchEnd: handleToggle,
        onKeyDown: handleKeyDown,
        'aria-expanded': isOpen,
        'aria-haspopup': 'dialog',
    };

    const popup = isOpen ? (
        <div
            ref={popupRef}
            role="dialog"
            aria-modal={false}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onKeyDown={handlePopupKeyDown}
            style={{
                position: 'fixed',
                top: '-9999px',
                left: '-9999px',
                zIndex: 9999,
                opacity: 0,
            }}
            className={popupClassName}
        >
            {children}
        </div>
    ) : null;

    return (
        <>
            {/* eslint-disable-next-line react-hooks/refs --
                False positive: triggerCallbackRef is a stable useCallback that only
                WRITES to a ref (assigning the DOM node), and triggerProps contains
                callbacks that only READ closeTimer.current inside event handlers —
                neither touches a ref value during render. */}
            {trigger(triggerCallbackRef, triggerProps)}
            {typeof document !== 'undefined' && createPortal(popup, document.body)}
        </>
    );
}
