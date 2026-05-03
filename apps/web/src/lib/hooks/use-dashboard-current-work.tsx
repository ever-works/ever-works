'use client';

import { useSyncExternalStore } from 'react';
import type { Work } from '@/lib/api/types-only';

type Listener = () => void;

const listeners = new Set<Listener>();
let currentWork: Work | null = null;

function emitChange() {
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot() {
    return currentWork;
}

function getServerSnapshot() {
    return null;
}

export function setDashboardCurrentWork(work: Work) {
    currentWork = work;
    emitChange();
}

export function clearDashboardCurrentWork(workId: string) {
    if (currentWork?.id !== workId) {
        return;
    }

    currentWork = null;
    emitChange();
}

export function useDashboardCurrentWork() {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
