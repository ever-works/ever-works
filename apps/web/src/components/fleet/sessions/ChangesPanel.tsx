'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDiff, Loader2, RefreshCw, X } from 'lucide-react';
import {
    FLEET_CHANGES_REFRESH_MS,
    type FleetCheckoutChangedFile,
    type FleetCheckoutChangesReply,
    type FleetGitLinePullRequest,
} from '@ever-works/contracts';
import { getCheckoutChangesAction } from '@/app/actions/fleet-session-git';
import { cn } from '@/lib/utils/cn';
import { PrPill } from './PrPill';
import {
    changedFileCounts,
    changedFileStatusKey,
    diffLineTone,
    formatBytes,
    sessionGitErrorTitleKey,
} from './session-git.shared';

function ChangedFileRow({ file }: { file: FleetCheckoutChangedFile }) {
    const t = useTranslations('fleet.sessionGit.changes');
    const [open, setOpen] = useState(false);
    const counts = changedFileCounts(file);
    const lines = open && file.patch ? file.patch.split('\n') : [];
    return (
        <li className="rounded-md border border-border/60 dark:border-border-dark/60 overflow-hidden" data-testid="fleet-changes-file">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                disabled={!file.patch}
                className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 text-left',
                    'bg-surface-secondary/60 dark:bg-surface-secondary-dark/40',
                    file.patch ? 'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark' : 'cursor-default',
                )}
            >
                <span className="flex-1 truncate text-[11px] font-mono text-text dark:text-text-dark" title={file.path}>
                    {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                </span>
                <span className="shrink-0 text-[10px] text-text-muted dark:text-text-muted-dark">
                    {t(`status.${changedFileStatusKey(file.status)}`)}
                </span>
                {file.binary ? (
                    <span className="shrink-0 text-[10px] text-text-muted dark:text-text-muted-dark">{t('binary')}</span>
                ) : counts ? (
                    <span className="shrink-0 text-[10px] font-mono text-text-muted dark:text-text-muted-dark">{counts}</span>
                ) : null}
            </button>
            {!file.patch && !file.binary ? (
                <p className="px-2.5 py-1 text-[10px] text-text-muted dark:text-text-muted-dark">{t('noPatch')}</p>
            ) : null}
            {open && file.patch ? (
                // Text only (spec FR-10): every line is a text node inside <pre>; nothing is parsed as markup.
                <pre className="m-0 max-h-[60vh] overflow-auto text-[10px] leading-4 font-mono p-2" data-testid="fleet-changes-patch">
                    {lines.map((line, index) => (
                        <div key={index} className={cn('whitespace-pre', diffLineTone(line))}>
                            {line || ' '}
                        </div>
                    ))}
                    {file.truncated ? <div className="text-text-muted dark:text-text-muted-dark">{t('fileCut')}</div> : null}
                </pre>
            ) : null}
        </li>
    );
}

/**
 * Session git & actions (FL-06, spec FR-9, FR-10, S10, U15, §5.5) — the
 * read-only Changes panel: the checkout's uncommitted diff as the computer
 * reads it — changed files with `+a −d`, each patch behind a disclosure, as
 * text. Refreshed every 10 s while the session works (and the tab is
 * visible), on demand otherwise. Its footer says what the caps left out and
 * offers the pull request when there is one. Esc closes it.
 */
export function ChangesPanel({
    checkoutId,
    open,
    onClose,
    working,
    agentName,
    pr,
}: {
    checkoutId: string;
    open: boolean;
    onClose: () => void;
    /** The session is working: refresh every 10 s. */
    working: boolean;
    /** "while Nina works" — the Agent's name, or null for an owner session. */
    agentName: string | null;
    pr: FleetGitLinePullRequest | null;
}) {
    const t = useTranslations('fleet.sessionGit.changes');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const [data, setData] = useState<FleetCheckoutChangesReply | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<{ code: string | null; hint: string | null } | null>(null);
    const inFlight = useRef(false);

    const load = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        const result = await getCheckoutChangesAction(checkoutId);
        inFlight.current = false;
        setLoading(false);
        if (result.success) {
            setData(result.data);
            setError(null);
        } else {
            setError({ code: result.code, hint: result.hint });
        }
    }, [checkoutId]);

    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    useEffect(() => {
        if (!open || !working) return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, FLEET_CHANGES_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [open, working, load]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const footerParts: string[] = [];
    footerParts.push(
        working
            ? agentName
                ? t('refreshesWhile', { who: agentName })
                : t('refreshesWhileSession')
            : t('refreshOnDemand'),
    );
    if (data && (data.omittedFiles > 0 || data.omittedBytes > 0)) {
        footerParts.push(t('omitted', { files: data.omittedFiles, size: formatBytes(data.omittedBytes) }));
    }

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose} data-testid="fleet-changes-overlay">
            <aside
                role="dialog"
                aria-label={t('title')}
                onClick={(event) => event.stopPropagation()}
                className="w-full max-w-2xl h-full overflow-y-auto bg-card dark:bg-card-primary-dark border-l border-border/60 dark:border-border-dark/60 p-4 space-y-3"
                data-testid="fleet-changes-panel"
            >
                <header className="flex items-center gap-2">
                    <FileDiff className="w-4 h-4 text-text-muted shrink-0" aria-hidden="true" />
                    <h2 className="flex-1 text-sm font-medium text-text dark:text-text-dark">{t('title')}</h2>
                    <button
                        type="button"
                        onClick={() => void load()}
                        aria-label={t('refresh')}
                        className="p-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                        data-testid="fleet-changes-refresh"
                    >
                        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('close')}
                        className="p-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                        data-testid="fleet-changes-close"
                    >
                        <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                </header>

                {loading && !data ? (
                    <p className="flex items-center gap-2 text-xs text-text-muted" role="status">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        {t('loading')}
                    </p>
                ) : null}

                {error ? (
                    <p className="text-xs text-danger" role="alert" data-testid="fleet-changes-error">
                        {tErrors(sessionGitErrorTitleKey(error.code))}
                        {error.hint ? ` — ${error.hint}` : ''}
                    </p>
                ) : null}

                {data ? (
                    data.files.length === 0 ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-changes-clean">
                            {t('clean')}
                        </p>
                    ) : (
                        <>
                            <p className="text-[11px] text-text-muted dark:text-text-muted-dark" data-testid="fleet-changes-summary">
                                {t('summary', { files: data.files.length })}
                            </p>
                            <ul className="space-y-2">
                                {data.files.map((file) => (
                                    <ChangedFileRow key={`${file.previousPath ?? ''}>${file.path}`} file={file} />
                                ))}
                            </ul>
                        </>
                    )
                ) : null}

                <footer className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted dark:text-text-muted-dark" data-testid="fleet-changes-footer">
                    <span>{footerParts.join(' · ')}</span>
                    {data && (data.omittedFiles > 0 || data.omittedBytes > 0) && pr ? (
                        <>
                            <span>{t('seePullRequest')}</span>
                            <PrPill pr={pr} />
                        </>
                    ) : null}
                </footer>
            </aside>
        </div>
    );
}
