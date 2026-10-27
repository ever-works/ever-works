'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';
import { importAppEnvAction, previewAppEnvImportAction } from '@/app/actions/dashboard/app-env';
import {
    APP_ENV_IMPORT_MAX_BYTES,
    type AppEnvImportPreviewView,
    type AppEnvPatchResponse,
} from '@/lib/api/app-env.types';

export interface AppEnvImportDialogProps {
    workId: string;
    onOpenChange: (open: boolean) => void;
    /** After the import was stored — the card replaces its table with the answer's. */
    onImported: (answer: AppEnvPatchResponse) => void;
}

/** The refusals with their own sentence → `environment.import.refusals.*`. */
const IMPORT_REFUSALS = {
    undeclaredName: 'undeclaredName',
    specUnavailable: 'specUnavailable',
    secureStorageUnavailable: 'secureStorageUnavailable',
    storeUnavailable: 'storeUnavailable',
    valuesTooLarge: 'tooLarge',
    tooManyValues: 'tooMany',
    editAccessRequired: 'forbidden',
    invalidBody: 'invalid',
} as const;
type ImportRefusalLeaf = (typeof IMPORT_REFUSALS)[keyof typeof IMPORT_REFUSALS];

/**
 * Lane aw-ops (APW-07 T28, FR-28…FR-30) — **Import .env**: paste (or pick) a `.env`, see per line
 * what it would change — add, replace, remove, skipped or refused, by NAME — then import.
 *
 * The paste is held in this dialog's memory only and dropped on close; the preview and the
 * import's answer carry names, line numbers and reasons, never a value. A paste that names
 * something the App spec does not declare cannot be imported (the API refuses it whole), so the
 * dialog lists those names and keeps Import disabled.
 */
export function AppEnvImportDialog({ workId, onOpenChange, onImported }: AppEnvImportDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.environment.import');
    const textId = useId();
    const fileId = useId();
    const [text, setText] = useState('');
    const [preview, setPreview] = useState<AppEnvImportPreviewView | null>(null);
    const [pending, setPending] = useState<'preview' | 'import' | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const inFlight = useRef(false);

    const tooLarge = new TextEncoder().encode(text).length > APP_ENV_IMPORT_MAX_BYTES;

    const refusal = (code: string | undefined, error: string | undefined) => {
        const leaf = code
            ? (IMPORT_REFUSALS as Readonly<Record<string, ImportRefusalLeaf>>)[code]
            : undefined;
        return leaf ? t(`refusals.${leaf}`) : t('failed', { reason: error ?? code ?? '' });
    };

    const runPreview = async () => {
        if (inFlight.current || !text.trim() || tooLarge) return;
        inFlight.current = true;
        setPending('preview');
        setMessage(null);
        try {
            const result = await previewAppEnvImportAction(workId, text);
            if (result.success && result.data) setPreview(result.data);
            else setMessage(refusal(result.code, result.error));
        } finally {
            inFlight.current = false;
            setPending(null);
        }
    };

    const runImport = async () => {
        if (inFlight.current || !preview || preview.undeclared.length > 0 || preview.limits) return;
        inFlight.current = true;
        setPending('import');
        setMessage(null);
        try {
            const result = await importAppEnvAction(workId, text);
            if (result.success && result.data) {
                toast.success(t('imported', { count: result.data.changed.length }));
                setText('');
                setPreview(null);
                onImported(result.data);
                return;
            }
            setMessage(refusal(result.code, result.error));
        } finally {
            inFlight.current = false;
            setPending(null);
        }
    };

    const close = () => {
        setText('');
        setPreview(null);
        onOpenChange(false);
    };

    const changeCount = preview
        ? preview.changes.add.length +
          preview.changes.replace.length +
          preview.changes.remove.length
        : 0;

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
            <DialogContent className="max-w-2xl">
                <DialogClose onClose={close} />
                <div className="space-y-4" data-testid="app-env-import-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </DialogTitle>
                        <DialogDescription>{t('description')}</DialogDescription>
                    </DialogHeader>

                    <label htmlFor={textId} className="block space-y-1 text-sm">
                        <span className="block text-xs text-text-secondary">{t('pasteLabel')}</span>
                        <textarea
                            id={textId}
                            className="h-40 w-full rounded-md border border-card-border bg-transparent p-2 font-mono text-xs dark:border-white/9"
                            value={text}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="NAME=value"
                            onChange={(event) => {
                                setText(event.target.value);
                                setPreview(null);
                            }}
                            data-testid="app-env-import-text"
                        />
                    </label>
                    <label
                        htmlFor={fileId}
                        className="flex items-center gap-2 text-xs text-text-secondary"
                    >
                        <span>{t('fileLabel')}</span>
                        <input
                            id={fileId}
                            type="file"
                            accept=".env,text/plain"
                            onChange={async (event) => {
                                const file = event.target.files?.[0];
                                event.target.value = '';
                                if (!file) return;
                                if (file.size > APP_ENV_IMPORT_MAX_BYTES) {
                                    setMessage(t('refusals.tooLarge'));
                                    return;
                                }
                                setText(await file.text());
                                setPreview(null);
                            }}
                            data-testid="app-env-import-file"
                        />
                    </label>
                    {tooLarge && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                            {t('refusals.tooLarge')}
                        </p>
                    )}

                    {preview && <PreviewTable preview={preview} />}

                    {message && (
                        <p
                            className="text-sm text-red-600 dark:text-red-400"
                            role="alert"
                            data-testid="app-env-import-error"
                        >
                            {message}
                        </p>
                    )}

                    <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={close}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => void runPreview()}
                            loading={pending === 'preview'}
                            disabled={pending !== null || !text.trim() || tooLarge}
                            data-testid="app-env-import-preview"
                        >
                            {t('preview')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => void runImport()}
                            loading={pending === 'import'}
                            disabled={
                                pending !== null ||
                                !preview ||
                                preview.undeclared.length > 0 ||
                                preview.limits !== null ||
                                changeCount === 0
                            }
                            data-testid="app-env-import-submit"
                        >
                            {t('import', { count: changeCount })}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function PreviewTable({ preview }: { preview: AppEnvImportPreviewView }) {
    const t = useTranslations('dashboard.workDetail.appDeploy.environment.import');
    if (preview.limits) {
        return (
            <p
                className="text-sm text-red-600 dark:text-red-400"
                data-testid="app-env-import-limits"
            >
                {preview.limits.message}
            </p>
        );
    }
    return (
        <div className="space-y-2" data-testid="app-env-import-preview-table">
            <p className="text-xs text-text-secondary">
                {t('summary', {
                    add: preview.changes.add.length,
                    replace: preview.changes.replace.length,
                    remove: preview.changes.remove.length,
                    refused: preview.refused,
                })}
            </p>
            {preview.undeclared.length > 0 && (
                <p
                    className="text-xs font-medium text-red-700 dark:text-red-400"
                    data-testid="app-env-import-undeclared"
                >
                    {t('undeclared', { names: preview.undeclared.join(', ') })}
                </p>
            )}
            <ul className="max-h-56 divide-y divide-card-border overflow-auto text-xs dark:divide-white/9">
                {preview.lines.map((line) => (
                    <li
                        key={`${line.line}-${line.name ?? ''}`}
                        className="flex flex-wrap items-baseline gap-2 py-1"
                        data-testid="app-env-import-line"
                        data-action={line.action}
                    >
                        <span className="w-10 shrink-0 tabular-nums text-text-muted">
                            {t('line', { line: line.line })}
                        </span>
                        <code className="font-semibold">{line.name ?? '—'}</code>
                        <span
                            className={cn(
                                line.action === 'refused'
                                    ? 'text-red-700 dark:text-red-400'
                                    : line.action === 'skipped'
                                      ? 'text-text-muted'
                                      : 'text-text-secondary',
                            )}
                        >
                            {t(`actions.${line.action}`)}
                            {line.message ? ` — ${line.message}` : ''}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
