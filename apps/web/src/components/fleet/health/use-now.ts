'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `intervalMs`, so "checked 48 s ago" and the
 * stale marker keep up with the clock without a reload. Read in an initializer
 * and a timer callback, never during render.
 */
export function useNow(intervalMs = 15_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}
