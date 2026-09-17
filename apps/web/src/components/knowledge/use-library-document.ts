'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KbLibraryDocumentDto } from '@/lib/api/knowledge-library-types';
import { useWorkspaceScope } from '@/lib/hooks/use-workspace-scope';
import { knowledgeLibraryClient } from './library-client';

export type LibraryDocumentState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface UseLibraryDocumentResult {
    state: LibraryDocumentState;
    document: KbLibraryDocumentDto | null;
    /** Re-read the row, e.g. after filing, archiving or restoring. */
    refresh: () => Promise<void>;
}

interface LoadedRow {
    docId: string;
    document: KbLibraryDocumentDto | null;
}

/**
 * The shelf row of one Knowledge Base document, for the per-Work workbench.
 *
 * The library belongs to an Organization, so a tab standing in the personal
 * workspace never asks — the row is `unavailable` straight away, and the
 * controls that need the shelf (File, Export) explain why they are disabled.
 * Any failed read (a document outside the Organization in scope, a transient
 * error) is also `unavailable`: the workbench keeps working, only the shelf
 * controls step back.
 *
 * `enabled: false` defers the read, so a context menu can wait until it is
 * actually opened instead of fetching one row per tree entry.
 */
export function useLibraryDocument(docId: string, enabled = true): UseLibraryDocumentResult {
    const workspace = useWorkspaceScope();
    const inOrganization = workspace?.kind === 'organization';
    const [loaded, setLoaded] = useState<LoadedRow | null>(null);

    useEffect(() => {
        if (!enabled || !inOrganization) return;
        const controller = new AbortController();
        knowledgeLibraryClient.getDocument(docId, controller.signal).then(
            (row) => setLoaded({ docId, document: row }),
            () => {
                if (!controller.signal.aborted) setLoaded({ docId, document: null });
            },
        );
        return () => controller.abort();
    }, [docId, enabled, inOrganization]);

    const refresh = useCallback(async () => {
        if (!inOrganization) return;
        try {
            setLoaded({ docId, document: await knowledgeLibraryClient.getDocument(docId) });
        } catch {
            setLoaded({ docId, document: null });
        }
    }, [docId, inOrganization]);

    const current = loaded?.docId === docId ? loaded : null;
    let state: LibraryDocumentState;
    if (!inOrganization) state = enabled ? 'unavailable' : 'idle';
    else if (current) state = current.document ? 'ready' : 'unavailable';
    else state = enabled ? 'loading' : 'idle';

    return { state, document: current?.document ?? null, refresh };
}
