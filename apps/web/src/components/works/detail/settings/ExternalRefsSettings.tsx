'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
    INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_EXTERNAL_REF_KINDS,
    type WorkExternalRefKind,
    type WorkExternalRefs,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from '@/i18n/navigation';
import { updateWorkExternalRefs } from '@/app/actions/dashboard/works';
import { useSettings } from './SettingsContext';

/** Editor state: one row list per kind, always present (possibly empty). */
type RefRows = Record<WorkExternalRefKind, string[]>;

function toRows(refs?: WorkExternalRefs | null): RefRows {
    return WORK_EXTERNAL_REF_KINDS.reduce((acc, kind) => {
        const claimed = refs?.[kind];
        acc[kind] = Array.isArray(claimed) ? [...claimed] : [];
        return acc;
    }, {} as RefRows);
}

/** Drop blanks + case-insensitive duplicates; `null` when nothing is left. */
export function rowsToExternalRefs(rows: RefRows): WorkExternalRefs | null {
    const out: WorkExternalRefs = {};
    let kept = 0;
    for (const kind of WORK_EXTERNAL_REF_KINDS) {
        const seen = new Set<string>();
        const ids: string[] = [];
        for (const raw of rows[kind] ?? []) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            const key = trimmed.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            ids.push(trimmed);
        }
        if (ids.length > 0) {
            out[kind] = ids;
            kept += ids.length;
        }
    }
    return kept > 0 ? out : null;
}

/**
 * Ingest routing claims editor (`works.externalRefs`).
 *
 * `works.externalRefs` is the claim map the ingest spine reads to route an
 * ingested event to a Work: a Slack channel id, a tracker team key, a doc
 * database id, a meeting id. Repositories are deliberately absent — repo
 * hints already resolve through the repositories the Work declares.
 *
 * Saves through the existing Work update path. The server re-validates and
 * rejects an identifier another Work you own already claims (two Works
 * claiming one channel is ambiguous); that message is surfaced as-is.
 */
export function ExternalRefsSettings() {
    const t = useTranslations('dashboard.workDetail.settings.externalRefs');
    const router = useRouter();
    const { context } = useSettings();
    const { work } = context;

    const [rows, setRows] = useState<RefRows>(() => toRows(work.externalRefs));
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [pending, startTransition] = useTransition();

    const initial = useMemo(() => JSON.stringify(toRows(work.externalRefs)), [work.externalRefs]);
    const dirty = JSON.stringify(rows) !== initial;

    const addRow = (kind: WorkExternalRefKind) => {
        const value = (drafts[kind] ?? '').trim();
        if (!value) return;
        if (value.length > INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS) {
            toast.error(t('errors.tooLong', { max: INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS }));
            return;
        }
        const existing = rows[kind] ?? [];
        if (existing.length >= WORK_EXTERNAL_REFS_MAX_PER_KIND) {
            toast.error(t('errors.tooMany', { max: WORK_EXTERNAL_REFS_MAX_PER_KIND }));
            return;
        }
        if (existing.some((entry) => entry.trim().toLowerCase() === value.toLowerCase())) {
            toast.error(t('errors.duplicate'));
            return;
        }
        setRows({ ...rows, [kind]: [...existing, value] });
        setDrafts({ ...drafts, [kind]: '' });
    };

    const removeRow = (kind: WorkExternalRefKind, index: number) => {
        setRows({ ...rows, [kind]: (rows[kind] ?? []).filter((_, i) => i !== index) });
    };

    const handleSave = () => {
        startTransition(async () => {
            const result = await updateWorkExternalRefs(work.id, rowsToExternalRefs(rows));
            if (result.success) {
                toast.success(t('saved'));
                router.refresh();
            } else {
                toast.error(result.error || t('saveFailed'));
            }
        });
    };

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
            data-testid="work-external-refs-card"
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
            </div>

            <div className="px-5 py-4 space-y-5">
                {WORK_EXTERNAL_REF_KINDS.map((kind) => {
                    const entries = rows[kind] ?? [];
                    const atCap = entries.length >= WORK_EXTERNAL_REFS_MAX_PER_KIND;
                    return (
                        <div key={kind} className="space-y-2" data-testid={`external-ref-${kind}`}>
                            <div>
                                <h4 className="text-xs font-medium text-text dark:text-text-dark">
                                    {t(`kinds.${kind}.label`)}
                                </h4>
                                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t(`kinds.${kind}.helper`)}
                                </p>
                            </div>

                            {entries.length > 0 && (
                                <ul className="space-y-1.5">
                                    {entries.map((entry, index) => (
                                        <li
                                            key={`${kind}-${entry}-${index}`}
                                            className={cn(
                                                'flex items-center justify-between gap-2 rounded-md border px-3 py-1.5',
                                                'border-border dark:border-border-dark',
                                            )}
                                        >
                                            <span className="truncate font-mono text-xs text-text dark:text-text-dark">
                                                {entry}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => removeRow(kind, index)}
                                                disabled={pending}
                                                aria-label={t('remove', { id: entry })}
                                                className="shrink-0 rounded p-1 text-text-muted hover:text-error disabled:opacity-50"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="flex items-center gap-2">
                                <Input
                                    value={drafts[kind] ?? ''}
                                    onChange={(event) =>
                                        setDrafts({ ...drafts, [kind]: event.target.value })
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            addRow(kind);
                                        }
                                    }}
                                    placeholder={t(`kinds.${kind}.placeholder`)}
                                    aria-label={t(`kinds.${kind}.label`)}
                                    disabled={pending || atCap}
                                    maxLength={INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS}
                                />
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    className="gap-1.5 shrink-0"
                                    onClick={() => addRow(kind)}
                                    disabled={pending || atCap}
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    {t('add')}
                                </Button>
                            </div>

                            {atCap && (
                                <p className="text-xs text-warning">
                                    {t('errors.tooMany', { max: WORK_EXTERNAL_REFS_MAX_PER_KIND })}
                                </p>
                            )}
                        </div>
                    );
                })}

                <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                        type="button"
                        size="sm"
                        onClick={handleSave}
                        disabled={pending || !dirty}
                        data-testid="external-refs-save"
                    >
                        {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        {t('save')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
