'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { updateAppEnvAction } from '@/app/actions/dashboard/app-env';
import {
    isAppEnvDependencyKindLeaf,
    isAppEnvPlainErrorCode,
    type AppEnvPatchResponse,
    type AppEnvVariableView,
} from '@/lib/api/app-env.types';

export interface AppEnvValueDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workId: string;
    entry: AppEnvVariableView;
    /** Called with the API's answer after a value was stored or removed. */
    onSaved: (answer: AppEnvPatchResponse, action: 'saved' | 'removed') => void;
}

/**
 * Lane aw-env-smtp (APW-07 T24) — set, replace or remove ONE Environment value.
 *
 * A secret's stored value is never shown or pre-filled: the field starts empty and the dialog says a
 * value is stored (FR-5). **Save** sends `{ NAME: value }`, **Remove value** sends `{ NAME: null }` (the
 * entry then follows the App spec again). A per-name refusal (a value that fails the App spec's
 * `validate`, a generated value) is shown inline in our copy, or the API's own words when the copy
 * needs parameters the answer does not carry.
 */
export function AppEnvValueDialog({
    open,
    onOpenChange,
    workId,
    entry,
    onSaved,
}: AppEnvValueDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.environment');
    const tErrors = useTranslations('dashboard.workDetail.appEnv.errors');
    const fieldId = useId();
    const [value, setValue] = useState(entry.masked ? '' : (entry.specValue ?? ''));
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const kind = entry.dependency?.kind;
    const kindLabel = isAppEnvDependencyKindLeaf(kind) ? t(`kinds.${kind}`) : kind;

    const submit = async (next: string | null) => {
        if (pending) return;
        if (next !== null && next.length === 0) {
            setError(t('dialog.empty'));
            return;
        }
        setPending(true);
        setError(null);
        try {
            const result = await updateAppEnvAction(workId, { [entry.name]: next });
            if (!result.success || !result.data) {
                setError(
                    result.code === 'undeclaredName'
                        ? t('errors.undeclaredName')
                        : result.code === 'specUnavailable'
                          ? t('errors.specUnavailable')
                          : result.code === 'secureStorageUnavailable'
                            ? tErrors('secureStorageUnavailable')
                            : t('errors.failed'),
                );
                return;
            }
            const refused = result.data.results.find(
                (item) => item.name === entry.name && item.action === 'refused',
            );
            if (refused) {
                setError(
                    isAppEnvPlainErrorCode(refused.code)
                        ? tErrors(refused.code)
                        : (refused.message ?? t('errors.failed')),
                );
                return;
            }
            onSaved(result.data, next === null ? 'removed' : 'saved');
            onOpenChange(false);
        } catch {
            setError(t('errors.failed'));
        } finally {
            setPending(false);
        }
    };

    const multiline = !entry.masked && value.includes('\n');

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <form
                    className="space-y-4"
                    data-testid="app-env-value-dialog"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit(value);
                    }}
                >
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('dialog.title', { name: entry.name })}
                        </DialogTitle>
                        {(entry.description || entry.dependency) && (
                            <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {entry.description ??
                                    t('dialog.dependencyHint', { kind: kindLabel ?? '' })}
                            </DialogDescription>
                        )}
                    </DialogHeader>

                    {entry.description && entry.dependency && (
                        <p className="text-xs text-text-secondary">
                            {t('dialog.dependencyHint', { kind: kindLabel ?? '' })}
                        </p>
                    )}
                    {entry.masked && (
                        <p
                            className="text-xs text-text-secondary"
                            data-testid="app-env-secret-hint"
                        >
                            {entry.set ? t('dialog.secretStored') : t('dialog.secretHint')}
                        </p>
                    )}

                    <div className="space-y-1">
                        <label
                            htmlFor={fieldId}
                            className="block text-sm font-medium text-text dark:text-text-dark"
                        >
                            {t('dialog.valueLabel')}
                        </label>
                        {multiline ? (
                            <textarea
                                id={fieldId}
                                value={value}
                                onChange={(event) => setValue(event.target.value)}
                                rows={4}
                                className="w-full rounded-lg border border-card-border bg-white px-3 py-2 font-mono text-sm dark:border-white/9 dark:bg-card-primary-dark"
                                data-testid="app-env-value-input"
                            />
                        ) : (
                            <input
                                id={fieldId}
                                type={entry.masked ? 'password' : 'text'}
                                autoComplete="off"
                                spellCheck={false}
                                value={value}
                                onChange={(event) => setValue(event.target.value)}
                                className="w-full rounded-lg border border-card-border bg-white px-3 py-2 font-mono text-sm dark:border-white/9 dark:bg-card-primary-dark"
                                data-testid="app-env-value-input"
                            />
                        )}
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('dialog.redeployHint')}
                        </p>
                    </div>

                    {error && (
                        <p
                            className="text-sm text-red-600 dark:text-red-400"
                            role="alert"
                            data-testid="app-env-value-error"
                        >
                            {error}
                        </p>
                    )}

                    <DialogFooter className="flex flex-wrap justify-end gap-2">
                        {entry.set && entry.origin !== 'generated' && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={pending}
                                onClick={() => void submit(null)}
                                data-testid="app-env-value-remove"
                            >
                                {t('dialog.remove')}
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => onOpenChange(false)}
                        >
                            {t('dialog.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            disabled={pending}
                            data-testid="app-env-value-save"
                        >
                            {pending ? t('dialog.saving') : t('dialog.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
