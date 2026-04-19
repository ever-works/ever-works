'use client';

import {
    useCallback,
    forwardRef,
    TextareaHTMLAttributes,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
} from 'react';
import { Textarea, TextareaProps } from './textarea';

type AutoResizeTextareaProps = TextareaProps &
    TextareaHTMLAttributes<HTMLTextAreaElement> & {
        maxHeight?: number;
        minRows?: number;
        autoResize?: boolean;
    };

export const AutoResizeTextarea = forwardRef<HTMLTextAreaElement, AutoResizeTextareaProps>(
    (
        { value, onChange, maxHeight = 240, minRows = 3, autoResize = true, style, ...props },
        forwardedRef,
    ) => {
        const innerRef = useRef<HTMLTextAreaElement>(null);

        useImperativeHandle(forwardedRef, () => innerRef.current as HTMLTextAreaElement);

        const resize = useCallback(() => {
            if (!autoResize) return;
            const el = innerRef.current;
            if (!el) return;

            el.style.height = 'auto';
            const nextHeight = Math.min(el.scrollHeight, maxHeight);
            el.style.height = `${nextHeight}px`;
            el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
        }, [autoResize, maxHeight]);

        useLayoutEffect(() => {
            resize();
        }, [value, resize]);

        const handleChange: React.ChangeEventHandler<HTMLTextAreaElement> = (event) => {
            if (autoResize) {
                requestAnimationFrame(resize);
            }
            onChange?.(event);
        };

        return (
            <Textarea
                ref={innerRef}
                rows={minRows}
                style={{ maxHeight, ...style }}
                value={value}
                onChange={handleChange}
                {...props}
            />
        );
    },
);

AutoResizeTextarea.displayName = 'AutoResizeTextarea';
