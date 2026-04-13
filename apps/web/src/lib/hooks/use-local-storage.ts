'use client';

import { useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';

// On the server useLayoutEffect is a no-op; on the client it runs synchronously
// after DOM mutations but *before* the browser paints — eliminating any flash.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * SSR-safe hook that syncs a state value with localStorage.
 * The stored string is parsed/serialized via the optional `serialize`/`deserialize`
 * callbacks; by default values are stored as raw strings.
 *
 * Hydration strategy
 * ------------------
 * The hook always initialises with `defaultValue` so the first client render
 * matches the server-rendered HTML (no hydration mismatch). A
 * `useIsomorphicLayoutEffect` then reads localStorage synchronously before the
 * browser paints, so the correct persisted value is applied without any
 * visible flash when the page is refreshed.
 *
 * `serialize`, `deserialize`, and `validate` are stored in refs so that the
 * latest versions are always used inside effects and callbacks without
 * requiring them as dependencies (the "latest ref" pattern). This avoids
 * stale-closure bugs when callers pass inline function literals.
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
    const serialize = useMemo(() => options?.serialize ?? String, [options?.serialize]);
    const deserialize = useMemo(
        () => options?.deserialize ?? ((raw: string) => raw as unknown as T),
        [options?.deserialize],
    );
    const validate = useMemo(() => options?.validate ?? (() => true), [options?.validate]);

    // Always start with defaultValue — safe for SSR and matches server HTML.
    const [value, setValueState] = useState<T>(defaultValue);

    // Read from localStorage before the first paint to apply the persisted
    // value without a visible flash (collapsed → expanded → collapsed).
    useIsomorphicLayoutEffect(() => {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) return;
            const parsed = deserialize(raw);
            if (validate(parsed)) setValueState(parsed);
        } catch {
            // localStorage unavailable — keep defaultValue
        }
    }, [deserialize, key, validate]);

    // Sync with storage changes from other tabs/windows.
    // Only re-registers when `key` changes; refs give access to the latest
    // callbacks without making them dependencies.
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
    }, [defaultValue, deserialize, key, validate]);

    const setValue = useCallback(
        (next: T) => {
            setValueState(next);
            try {
                localStorage.setItem(key, serialize(next));
            } catch {
                // localStorage may be unavailable (e.g. private browsing quota)
            }
        },
        [key, serialize],
    );

    return [value, setValue];
}
