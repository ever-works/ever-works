'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { updateKbDocumentAction } from '@/app/actions/works/kb-document';
import type { KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 slice A — slim title row above the workbench editor.
 *
 * Renders the editable title, class chip, status chip, an icon-only
 * lock badge when the document is locked, and the language code. Title
 * edits are inline (a one-line `<input>`) and autosave on blur via the
 * shared `updateKbDocumentAction` server action used by the editor body.
 * Local state is optimistic — the input mirrors what the user typed,
 * and the upstream server-confirmed title only overrides when the
 * action succeeds.
 *
 * Out of scope (deliberately): tags editor, description editor, lock
 * toggle. Those land in the slice-B metadata side panel.
 */
export interface KbDocumentHeaderProps {
    workId: string;
    document: KbDocumentDto;
}

export function KbDocumentHeader({ workId, document }: KbDocumentHeaderProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const [title, setTitle] = useState(document.title || document.path);
    const [savedTitle, setSavedTitle] = useState(document.title || document.path);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();
    const lastDocIdRef = useRef(document.id);

    // When the parent swaps to a different document (route change), reset
    // the local optimistic state so the input doesn't carry stale text
    // from the previous doc.
    useEffect(() => {
        if (lastDocIdRef.current === document.id) return;
        lastDocIdRef.current = document.id;
        const next = document.title || document.path;
        setTitle(next);
        setSavedTitle(next);
        setError(null);
    }, [document.id, document.title, document.path]);

    const onBlur = () => {
        const trimmed = title.trim();
        if (trimmed.length === 0) {
            // Don't persist an empty title — revert to the last saved
            // value. Matches the editor's "no-op when nothing meaningful
            // changed" pattern.
            setTitle(savedTitle);
            return;
        }
        if (trimmed === savedTitle) return;
        setError(null);
        startTransition(async () => {
            const result = await updateKbDocumentAction({
                workId,
                docId: document.id,
                body: { title: trimmed },
            });
            if (result.success) {
                const next = result.data?.title ?? trimmed;
                setTitle(next);
                setSavedTitle(next);
            } else {
                setError(result.error ?? 'Failed to save title');
                setTitle(savedTitle);
            }
        });
    };

    return (
        <header
            data-testid="kb-workbench-document-header"
            data-doc-id={document.id}
            data-doc-path={document.path}
            className={cn(
                'flex flex-wrap items-center gap-2 border-b border-border px-4 py-2',
                'dark:border-border-dark',
            )}
        >
            <input
                type="text"
                data-testid="kb-workbench-document-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={onBlur}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.currentTarget as HTMLInputElement).blur();
                    }
                }}
                aria-label={t('panes.editor.title')}
                className={cn(
                    'min-w-0 flex-1 bg-transparent text-base font-semibold outline-none',
                    'text-text dark:text-text-dark',
                    'focus:ring-2 focus:ring-primary/40 focus:rounded',
                    'px-1 py-0.5',
                )}
            />

            <span
                data-testid="kb-workbench-class-chip"
                data-kb-class={document.class}
                className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
                    'bg-primary/10 text-primary dark:bg-primary/20',
                )}
            >
                {t(`classes.${document.class}`)}
            </span>

            <span
                data-testid="kb-workbench-status-chip"
                data-kb-status={document.status}
                className={cn(
                    'rounded-full px-2 py-0.5 text-[11px]',
                    document.status === 'active'
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : document.status === 'archived'
                          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                          : 'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70',
                )}
            >
                {t(`status.${document.status}`)}
            </span>

            {document.locked ? (
                <span
                    data-testid="kb-workbench-lock-badge"
                    data-kb-lock-mode={document.lockMode ?? 'full'}
                    aria-label={t(`lock.${document.lockMode ?? 'full'}`)}
                    title={t(`lock.${document.lockMode ?? 'full'}`)}
                    className={cn(
                        'inline-flex items-center justify-center rounded-full p-1',
                        'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                    )}
                >
                    <Lock className="h-3 w-3" aria-hidden="true" />
                </span>
            ) : null}

            <span
                data-testid="kb-workbench-language-badge"
                className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-mono uppercase',
                    'bg-card-hover text-text-muted dark:bg-card-primary-dark/40 dark:text-text-muted-dark/70',
                )}
            >
                {document.language || 'en'}
            </span>

            {error ? (
                <span
                    data-testid="kb-workbench-header-error"
                    role="status"
                    className="w-full text-[11px] text-red-600 dark:text-red-400"
                >
                    {error}
                </span>
            ) : null}
        </header>
    );
}
