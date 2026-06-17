'use client';

import React, {
    useRef,
    useState,
    useCallback,
    useEffect,
    useLayoutEffect,
    type ReactNode,
    type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

interface HoverPopupProps {
    /** The trigger element (badge, button, etc.) */
    trigger: (ref: RefObject<HTMLElement | null>, props: TriggerProps) => ReactNode;
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

interface TriggerProps {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onClick: (e: React.MouseEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    'aria-expanded': boolean;
}

const MARGIN = 8; // minimum gap from viewport edges
const GAP = 6;    // gap between trigger and popup

/**
 * Generic hover/touch popup that renders its content in a React portal so it
 * escapes any overflow:hidden / overflow:auto ancestor (modals, cards, etc.).
 *
 * Positioning: the popup is initially rendered offscreen and invisible.
 * useLayoutEffect measures its real dimensions after mount and sets the final
 * position directly on the DOM node — no estimated height, no visible jump.
 */
export function HoverPopup({
    trigger,
    children,
    popupClassName,
    stopNavigation = false,
}: HoverPopupProps) {
    const triggerRef = useRef<HTMLElement>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    const [isOpen, setIsOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** Recompute and apply popup position directly on the DOM node. */
    const applyPosition = useCallback(() => {
        const popup = popupRef.current;
        const trigger = triggerRef.current;
        if (!popup || !trigger) return;

        const tr = trigger.getBoundingClientRect();
        const pw = popup.offsetWidth;
        const ph = popup.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Prefer above; fall back to below only if not enough room
        let top = tr.top - ph - GAP;
        if (top < MARGIN) {
            top = tr.bottom + GAP;
        }

        // Align left edge with trigger; clamp so popup stays within viewport
        let left = tr.left;
        if (left + pw > vw - MARGIN) {
            left = vw - pw - MARGIN;
        }
        if (left < MARGIN) left = MARGIN;

        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        popup.style.opacity = '1';
    }, []);

    // After the popup mounts, measure it and apply the real position.
    useLayoutEffect(() => {
        if (isOpen) applyPosition();
    }, [isOpen, applyPosition]);

    // Reposition on scroll/resize without triggering a React re-render.
    useEffect(() => {
        if (!isOpen) return;
        const onUpdate = () => applyPosition();
        window.addEventListener('scroll', onUpdate, true);
        window.addEventListener('resize', onUpdate);
        return () => {
            window.removeEventListener('scroll', onUpdate, true);
            window.removeEventListener('resize', onUpdate);
        };
    }, [isOpen, applyPosition]);

    // Outside dismiss
    useEffect(() => {
        if (!isOpen) return;
        const dismiss = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node;
            if (!triggerRef.current?.contains(t) && !popupRef.current?.contains(t)) {
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
        return () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
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

    const handleToggle = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        e.stopPropagation();
        if (stopNavigation) e.preventDefault();
        if (isOpen) { setIsOpen(false); } else { openPopup(); }
    }, [isOpen, openPopup, stopNavigation]);

    const triggerProps: TriggerProps = {
        onMouseEnter: openPopup,
        onMouseLeave: scheduleClose,
        onClick: handleToggle,
        onTouchEnd: handleToggle,
        'aria-expanded': isOpen,
    };

    // Start offscreen + invisible; useLayoutEffect moves it into place before paint.
    const popup = isOpen ? (
        <div
            ref={popupRef}
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
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
            {trigger(triggerRef as React.RefObject<HTMLElement>, triggerProps)}
            {typeof document !== 'undefined' && createPortal(popup, document.body)}
        </>
    );
}
