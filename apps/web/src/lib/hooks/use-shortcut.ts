'use client';

import { useEffect, useRef } from 'react';
import { registerShortcut, type ShortcutBinding } from '@/lib/keyboard/shortcut-registry';

export interface UseShortcutOptions extends Omit<ShortcutBinding, 'handler' | 'match'> {
    /** Register only while true. Defaults to `true`. */
    enabled?: boolean;
}

/**
 * Bind a keyboard shortcut through the shared registry for the lifetime of the
 * calling component. The latest `match` and `handler` are always used without
 * re-registering, so passing inline functions is fine; changing `id`, `scope`,
 * `priority`, `allowInInput` or `enabled` re-registers.
 */
export function useShortcut(
    options: UseShortcutOptions,
    match: ShortcutBinding['match'],
    handler: ShortcutBinding['handler'],
): void {
    const matchRef = useRef(match);
    const handlerRef = useRef(handler);
    useEffect(() => {
        matchRef.current = match;
        handlerRef.current = handler;
    });

    const { id, scope, priority, allowInInput, preventDefault, enabled = true } = options;

    useEffect(() => {
        if (!enabled) return undefined;
        return registerShortcut({
            id,
            scope,
            priority,
            allowInInput,
            preventDefault,
            match: (event) => matchRef.current(event),
            handler: (event) => handlerRef.current(event),
        });
    }, [id, scope, priority, allowInInput, preventDefault, enabled]);
}
