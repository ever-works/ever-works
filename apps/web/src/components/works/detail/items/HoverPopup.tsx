'use client';

import React, {
    useRef,
    useState,
    useCallback,
    useEffect,
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
     * Popup pixel width — must match the CSS width class on the popup so the
     * collision-avoidance logic keeps it inside the viewport. Default 288 (w-72).
     */
    popupWidth?: number;
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

/**
 * Generic hover/touch popup that renders its content in a React portal so it
 * escapes any overflow:hidden / overflow:auto ancestor (modals, cards, etc.).
 *
 * Usage:
 * ```tsx
 * <HoverPopup
 *   trigger={(ref, props) => <span ref={ref} {...props}>Hover me</span>}
 *   popupClassName="w-64"
 * >
 *   <p>Popup content</p>
 * </HoverPopup>
 * ```
 */
export function HoverPopup({ trigger, children, popupClassName, popupWidth = 288, stopNavigation = false }: HoverPopupProps) {
    const triggerRef = useRef<HTMLElement>(null);
    const popupRef = useRef<HTMLDivElement>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const computeCoords = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const popupH = 160;
        const gap = 8;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8));
        const openAbove = rect.top >= popupH + gap;
        return {
            top: openAbove ? rect.top - popupH - gap : rect.bottom + gap,
            left,
        };
    }, [popupWidth]);

    const openPopup = useCallback(() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        const c = computeCoords();
        if (c) { setCoords(c); setIsOpen(true); }
    }, [computeCoords]);

    const scheduleClose = useCallback(() => {
        closeTimer.current = setTimeout(() => setIsOpen(false), 120);
    }, []);

    const cancelClose = useCallback(() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
    }, []);

    const handleToggle = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        e.stopPropagation();
        if (stopNavigation) e.preventDefault();
        if (isOpen) { setIsOpen(false); } else { openPopup(); }
    }, [isOpen, openPopup, stopNavigation]);

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

    // Reposition on scroll/resize
    useEffect(() => {
        if (!isOpen) return;
        const reposition = () => { const c = computeCoords(); if (c) setCoords(c); };
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [isOpen, computeCoords]);

    useEffect(() => {
        return () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
    }, []);

    const triggerProps: TriggerProps = {
        onMouseEnter: openPopup,
        onMouseLeave: scheduleClose,
        onClick: handleToggle,
        onTouchEnd: handleToggle,
        'aria-expanded': isOpen,
    };

    const popup = isOpen && coords ? (
        <div
            ref={popupRef}
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 9999 }}
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
