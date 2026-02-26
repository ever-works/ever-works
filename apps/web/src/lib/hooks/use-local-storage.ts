'use client';

import { useState, useCallback, useEffect } from 'react';

/**
 * SSR-safe hook that syncs a state value with localStorage.
 * The stored string is parsed/serialized via the optional `parse`/`serialize`
 * callbacks; by default values are stored as raw strings.
 */
export function useLocalStorage<T>(
    key: string,
    defaultValue: T,
    options?: {
        serialize?: (value: T) => string;
        deserialize?: (raw: string) => T;
        validate?: (value: T) => boolean;
    },
): [T, (value: T) => void] {
    const serialize = options?.serialize ?? String;
    const deserialize = options?.deserialize ?? ((raw: string) => raw as unknown as T);
    const validate = options?.validate ?? (() => true);

    const [value, setValueState] = useState<T>(() => {
        if (typeof window === 'undefined') return defaultValue;
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) return defaultValue;
            const parsed = deserialize(raw);
            return validate(parsed) ? parsed : defaultValue;
        } catch {
            return defaultValue;
        }
    });

    // Sync with storage changes from other tabs/windows
    useEffect(() => {
        const handler = (e: StorageEvent) => {
            if (e.key !== key) return;
            try {
                if (e.newValue === null) {
                    setValueState(defaultValue);
                } else {
                    const parsed = deserialize(e.newValue);
                    setValueState(validate(parsed) ? parsed : defaultValue);
                }
            } catch {
                setValueState(defaultValue);
            }
        };
        window.addEventListener('storage', handler);
        return () => window.removeEventListener('storage', handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const setValue = useCallback(
        (next: T) => {
            setValueState(next);
            try {
                localStorage.setItem(key, serialize(next));
            } catch {
                // localStorage may be unavailable (e.g. private browsing quota)
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key],
    );

    return [value, setValue];
}
