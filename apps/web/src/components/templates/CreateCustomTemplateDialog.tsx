'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Sparkles, Loader2 } from 'lucide-react';
import type { TemplateCatalogItem, TemplateCustomization } from '@/lib/api/templates';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    customizeTemplateFromBase,
    getTemplateCustomization,
} from '@/app/actions/dashboard/templates';

const POLL_INTERVAL_MS = 4000;
const TERMINAL_STATUSES: TemplateCustomization['status'][] = ['succeeded', 'failed'];

interface CreateCustomTemplateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Customizable built-in templates the user can fork+customize.
    customizableBases: TemplateCatalogItem[];
    // Called when a customization succeeds so the parent can refresh its list.
    onSucceeded?: () => void;
}

export function CreateCustomTemplateDialog({
    open,
    onOpenChange,
    customizableBases,
    onSucceeded,
}: CreateCustomTemplateDialogProps) {
    const t = useTranslations('dashboard.templates.customizeDialog');
    const [baseTemplateId, setBaseTemplateId] = useState<string>(customizableBases[0]?.id ?? '');
    const [prompt, setPrompt] = useState('');
    const [submitting, startSubmitting] = useTransition();
    const [customization, setCustomization] = useState<TemplateCustomization | null>(null);
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopPolling = useCallback(() => {
        if (pollTimer.current) {
            clearTimeout(pollTimer.current);
            pollTimer.current = null;
        }
    }, []);

    useEffect(() => () => stopPolling(), [stopPolling]);

    useEffect(() => {
        if (!open) {
            stopPolling();
            return;
        }

        if (!customization || TERMINAL_STATUSES.includes(customization.status)) {
            return;
        }

        pollTimer.current = setTimeout(async () => {
            const result = await getTemplateCustomization(customization.id);
            if (result.success && result.customization) {
                setCustomization(result.customization);
                if (result.customization.status === 'succeeded') {
                    toast.success(t('toast.success'));
                    onSucceeded?.();
                } else if (result.customization.status === 'failed') {
                    toast.error(result.customization.errorMessage || t('toast.failed'));
                }
            }
        }, POLL_INTERVAL_MS);

        return () => stopPolling();
    }, [open, customization, stopPolling, t, onSucceeded]);

    const reset = () => {
        stopPolling();
        setPrompt('');
        setCustomization(null);
        setBaseTemplateId(customizableBases[0]?.id ?? '');
    };

    const handleClose = (nextOpen: boolean) => {
        if (!nextOpen) {
            reset();
        }
        onOpenChange(nextOpen);
    };

    const handleSubmit = () => {
        if (!baseTemplateId) {
            toast.error(t('messages.baseRequired'));
            return;
        }
        const trimmed = prompt.trim();
        if (trimmed.length < 3) {
            toast.error(t('messages.promptTooShort'));
            return;
        }

        startSubmitting(() => {
            void (async () => {
                const result = await customizeTemplateFromBase({
                    baseTemplateId,
                    prompt: trimmed,
                });
                if (!result.success || !result.customization) {
                    toast.error(result.error || t('toast.startFailed'));
                    return;
                }
                setCustomization(result.customization);
                toast.message(t('toast.started'));
            })();
        });
    };

    const running = customization && !TERMINAL_STATUSES.includes(customization.status);
    const succeeded = customization?.status === 'succeeded';
    const failed = customization?.status === 'failed';

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-2xl">
                <DialogClose onClose={() => handleClose(false)} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        {t('title')}
                    </DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {customizableBases.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-sm text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                        {t('messages.noCustomizableBases')}
                    </p>
                ) : (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <label className="block text-sm font-medium text-text dark:text-text-dark">
                                {t('baseLabel')}
                            </label>
                            <Select
                                value={baseTemplateId}
                                onValueChange={setBaseTemplateId}
                                disabled={submitting || !!running}
                            >
                                {customizableBases.map((base) => (
                                    <option key={base.id} value={base.id}>
                                        {base.name}
                                    </option>
                                ))}
                            </Select>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('baseHelp')}
                            </p>
                        </div>

                        <Textarea
                            label={t('promptLabel')}
                            placeholder={t('promptPlaceholder')}
                            rows={6}
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            disabled={submitting || !!running}
                            helperText={t('promptHelp')}
                        />

                        {customization && (
                            <div
                                className={
                                    'rounded-lg border px-4 py-3 text-sm ' +
                                    (failed
                                        ? 'border-destructive/40 bg-destructive/10 text-destructive'
                                        : succeeded
                                          ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300'
                                          : 'border-border bg-surface text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark')
                                }
                            >
                                <div className="flex items-center gap-2">
                                    {running && <Loader2 className="h-4 w-4 animate-spin" />}
                                    <span className="font-medium">
                                        {t(`status.${customization.status}`)}
                                    </span>
                                </div>
                                {failed && customization.errorMessage && (
                                    <p className="mt-2 text-xs">{customization.errorMessage}</p>
                                )}
                                {succeeded && <p className="mt-2 text-xs">{t('successHelp')}</p>}
                            </div>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant="ghost"
                        onClick={() => handleClose(false)}
                        disabled={submitting}
                    >
                        {succeeded ? t('done') : t('cancel')}
                    </Button>
                    {!succeeded && (
                        <Button
                            onClick={handleSubmit}
                            loading={submitting || !!running}
                            disabled={
                                customizableBases.length === 0 || !baseTemplateId || !!running
                            }
                        >
                            {customization ? t('retry') : t('submit')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
