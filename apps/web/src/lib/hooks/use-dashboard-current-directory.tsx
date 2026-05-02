'use client';

import { useSyncExternalStore } from 'react';
import type { Directory } from '@/lib/api/types-only';

type Listener = () => void;

const listeners = new Set<Listener>();
let currentDirectory: Directory | null = null;

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
    return currentDirectory;
}

function getServerSnapshot() {
    return null;
}

export function setDashboardCurrentDirectory(directory: Directory) {
    currentDirectory = directory;
    emitChange();
}

export function clearDashboardCurrentDirectory(directoryId: string) {
    if (currentDirectory?.id !== directoryId) {
        return;
    }

    currentDirectory = null;
    emitChange();
}

export function useDashboardCurrentDirectory() {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
