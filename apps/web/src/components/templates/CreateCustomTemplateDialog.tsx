'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Sparkles, Loader2, ExternalLink } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type {
    CustomizationAiProvider,
    CustomizationProvider,
    TemplateCatalogItem,
    TemplateCustomization,
    TemplateCustomizationSummary,
} from '@/lib/api/templates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { ProviderChoiceButton } from '@/components/works/detail/plugins/ProviderChoiceButton';
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
    iterateCustomTemplate,
} from '@/app/actions/dashboard/templates';

const POLL_INTERVAL_MS = 4000;
const TERMINAL_STATUSES: TemplateCustomization['status'][] = ['succeeded', 'failed'];

interface ForkTarget {
    login: string;
    label: string;
    kind: 'personal' | 'organization';
}

export type CustomizeDialogMode = 'new' | 'iterate' | 'status';

interface CreateCustomTemplateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    customizableBases: TemplateCatalogItem[];
    providers: CustomizationProvider[];
    aiProviders: CustomizationAiProvider[];
    forkTargets: ForkTarget[];
    onSucceeded?: () => void;
    mode?: CustomizeDialogMode;
    targetTemplate?: TemplateCatalogItem | null;
    initialCustomization?: TemplateCustomization | TemplateCustomizationSummary | null;
}

export function CreateCustomTemplateDialog({
    open,
    onOpenChange,
    customizableBases,
    providers,
    aiProviders,
    forkTargets,
    onSucceeded,
    mode = 'new',
    targetTemplate = null,
    initialCustomization = null,
}: CreateCustomTemplateDialogProps) {
    const t = useTranslations('dashboard.templates.customizeDialog');
    const enabledProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);
    const enabledAiProviders = useMemo(() => aiProviders.filter((p) => p.enabled), [aiProviders]);
    const defaultProviderId = useMemo(
        () => enabledProviders.find((p) => p.isDefault)?.id ?? enabledProviders[0]?.id ?? '',
        [enabledProviders],
    );
    const defaultAiProviderId = useMemo(
        () => enabledAiProviders.find((p) => p.isDefault)?.id ?? enabledAiProviders[0]?.id ?? '',
        [enabledAiProviders],
    );

    const [baseTemplateId, setBaseTemplateId] = useState<string>(customizableBases[0]?.id ?? '');
    const [providerId, setProviderId] = useState<string>(defaultProviderId);
    const [aiProviderId, setAiProviderId] = useState<string>(defaultAiProviderId);
    const [targetOwner, setTargetOwner] = useState<string>(forkTargets[0]?.login ?? '');
    const [name, setName] = useState('');
    const [prompt, setPrompt] = useState('');
    const [submitting, startSubmitting] = useTransition();
    const [customization, setCustomization] = useState<
        TemplateCustomization | TemplateCustomizationSummary | null
    >(initialCustomization);
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopPolling = useCallback(() => {
        if (pollTimer.current) {
            clearTimeout(pollTimer.current);
            pollTimer.current = null;
        }
    }, []);

    useEffect(() => () => stopPolling(), [stopPolling]);

    // Sync the polled customization when the dialog opens with a fresh
    // `initialCustomization` (e.g. user clicked another card while the
    // dialog was still mounted).
    useEffect(() => {
        if (open) setCustomization(initialCustomization);
    }, [open, initialCustomization]);

    useEffect(() => {
        if (!open) {
            stopPolling();
            return;
        }
        if (!customization || TERMINAL_STATUSES.includes(customization.status)) return;

        pollTimer.current = setTimeout(async () => {
            const result = await getTemplateCustomization(customization.id);
            if (!result.success || !result.customization) return;
            setCustomization(result.customization);
            if (result.customization.status === 'succeeded') {
                toast.success(t('toast.success'));
                onSucceeded?.();
            } else if (result.customization.status === 'failed') {
                toast.error(result.customization.errorMessage || t('toast.failed'));
            }
        }, POLL_INTERVAL_MS);

        return () => stopPolling();
    }, [open, customization, stopPolling, t, onSucceeded]);

    const reset = useCallback(() => {
        stopPolling();
        setName('');
        setPrompt('');
        setCustomization(null);
        setBaseTemplateId(customizableBases[0]?.id ?? '');
        setProviderId(defaultProviderId);
        setAiProviderId(defaultAiProviderId);
        setTargetOwner(forkTargets[0]?.login ?? '');
    }, [stopPolling, customizableBases, defaultProviderId, defaultAiProviderId, forkTargets]);

    const handleClose = (nextOpen: boolean) => {
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
    };

    const selectedProvider = useMemo(
        () => providers.find((p) => p.id === providerId) ?? null,
        [providers, providerId],
    );
    const requiresAiProvider =
        selectedProvider?.selectableProviderCategories?.includes('ai-provider') ?? false;

    const handleSubmit = () => {
        const trimmedPrompt = prompt.trim();
        if (trimmedPrompt.length < 3) return toast.error(t('messages.promptTooShort'));
        if (!providerId) return toast.error(t('messages.providerRequired'));
        if (requiresAiProvider && !aiProviderId) {
            return toast.error(t('messages.aiProviderRequired'));
        }

        if (mode === 'iterate') {
            if (!targetTemplate?.id) return;
            startSubmitting(() => {
                void (async () => {
                    const result = await iterateCustomTemplate(targetTemplate.id, {
                        prompt: trimmedPrompt,
                        providerId,
                        aiProviderId: requiresAiProvider ? aiProviderId : undefined,
                    });
                    if (!result.success || !result.customization) {
                        toast.error(result.error || t('toast.startFailed'));
                        return;
                    }
                    setCustomization(result.customization);
                    toast.message(t('toast.started'));
                })();
            });
            return;
        }

        const trimmedName = name.trim();
        if (!trimmedName) return toast.error(t('messages.nameRequired'));
        if (!baseTemplateId) return toast.error(t('messages.baseRequired'));

        startSubmitting(() => {
            void (async () => {
                const result = await customizeTemplateFromBase({
                    baseTemplateId,
                    name: trimmedName,
                    prompt: trimmedPrompt,
                    providerId,
                    aiProviderId: requiresAiProvider ? aiProviderId : undefined,
                    targetOwner: targetOwner || undefined,
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
    const disabled = submitting || !!running;
    const missingAiProvider = requiresAiProvider && enabledAiProviders.length === 0;
    const noPrereqs =
        mode === 'new'
            ? customizableBases.length === 0 ||
              enabledProviders.length === 0 ||
              forkTargets.length === 0 ||
              missingAiProvider
            : mode === 'iterate'
              ? enabledProviders.length === 0 || missingAiProvider
              : false;

    const titleKey =
        mode === 'iterate' ? 'titleIterate' : mode === 'status' ? 'titleStatus' : 'title';
    const descriptionKey =
        mode === 'iterate'
            ? 'descriptionIterate'
            : mode === 'status'
              ? 'descriptionStatus'
              : 'description';

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-2xl">
                <DialogClose onClose={() => handleClose(false)} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        {t(titleKey, { name: targetTemplate?.name ?? '' })}
                    </DialogTitle>
                    <DialogDescription>
                        {t(descriptionKey, { name: targetTemplate?.name ?? '' })}
                    </DialogDescription>
                </DialogHeader>

                {noPrereqs ? (
                    <div className="space-y-3 rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-sm text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                        <ul className="space-y-2">
                            {mode === 'new' && customizableBases.length === 0 && (
                                <li>• {t('messages.noCustomizableBases')}</li>
                            )}
                            {enabledProviders.length === 0 && (
                                <li>• {t('messages.noProviders')}</li>
                            )}
                            {missingAiProvider && (
                                <li>
                                    •{' '}
                                    {t('messages.noAiProviders', {
                                        plugin: selectedProvider?.name ?? '',
                                    })}
                                </li>
                            )}
                            {mode === 'new' && forkTargets.length === 0 && (
                                <li>• {t('messages.noTargets')}</li>
                            )}
                        </ul>
                        {(enabledProviders.length === 0 || missingAiProvider) && (
                            <Link
                                href={ROUTES.DASHBOARD_PLUGINS}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                            >
                                {t('messages.browsePlugins')}
                                <ExternalLink className="h-3 w-3" />
                            </Link>
                        )}
                    </div>
                ) : mode === 'status' ? (
                    <CustomizationStatusPanel
                        t={t}
                        customization={customization}
                        running={!!running}
                        succeeded={succeeded}
                        failed={failed}
                    />
                ) : (
                    <div className="space-y-4">
                        {mode === 'new' && (
                            <Input
                                label={t('nameLabel')}
                                placeholder={t('namePlaceholder')}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={disabled}
                                helperText={t('nameHelp')}
                            />
                        )}

                        <div className="grid gap-4 md:grid-cols-2">
                            {mode === 'new' ? (
                                <Field label={t('baseLabel')} hint={t('baseHelp')}>
                                    <Select
                                        value={baseTemplateId}
                                        onValueChange={setBaseTemplateId}
                                        disabled={disabled}
                                    >
                                        {customizableBases.map((base) => (
                                            <option key={base.id} value={base.id}>
                                                {base.name}
                                            </option>
                                        ))}
                                    </Select>
                                </Field>
                            ) : (
                                <Field label={t('templateLabel')} hint={t('templateIterateHelp')}>
                                    <div className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text dark:border-border-dark dark:bg-white/4 dark:text-text-dark">
                                        {targetTemplate?.name ?? '—'}
                                    </div>
                                </Field>
                            )}

                            <Field label={t('providerLabel')} hint={t('providerHelp')}>
                                <Select
                                    value={providerId}
                                    onValueChange={setProviderId}
                                    disabled={disabled}
                                >
                                    {providers.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.providerName || p.name}
                                        </option>
                                    ))}
                                </Select>
                            </Field>
                        </div>

                        {requiresAiProvider && (
                            <Field
                                label={t('aiProviderLabel')}
                                hint={t('aiProviderHelp', {
                                    plugin: selectedProvider?.name ?? '',
                                })}
                            >
                                <div className="flex flex-wrap gap-1.5">
                                    {enabledAiProviders.map((provider) => (
                                        <ProviderChoiceButton
                                            key={provider.id}
                                            name={provider.providerName || provider.name}
                                            icon={provider.icon}
                                            isActive={aiProviderId === provider.id}
                                            disabled={disabled}
                                            onSelect={() => setAiProviderId(provider.id)}
                                        />
                                    ))}
                                </div>
                            </Field>
                        )}

                        {mode === 'new' && (
                            <Field label={t('targetLabel')} hint={t('targetHelp')}>
                                <Select
                                    value={targetOwner}
                                    onValueChange={setTargetOwner}
                                    disabled={disabled || forkTargets.length === 0}
                                >
                                    {forkTargets.map((target) => (
                                        <option key={target.login} value={target.login}>
                                            {target.kind === 'personal'
                                                ? t('personalTarget', { login: target.login })
                                                : t('organizationTarget', {
                                                      login: target.login,
                                                  })}
                                        </option>
                                    ))}
                                </Select>
                            </Field>
                        )}

                        <Textarea
                            label={t('promptLabel')}
                            placeholder={
                                mode === 'iterate'
                                    ? t('promptIteratePlaceholder')
                                    : t('promptPlaceholder')
                            }
                            rows={6}
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            disabled={disabled}
                            helperText={t('promptHelp')}
                        />

                        {customization && (
                            <StatusBox failed={failed} succeeded={succeeded} running={!!running}>
                                <span className="font-medium">
                                    {t(`status.${customization.status}`)}
                                </span>
                                {failed && customization.errorMessage && (
                                    <p className="mt-2 text-xs">{customization.errorMessage}</p>
                                )}
                                {succeeded && <p className="mt-2 text-xs">{t('successHelp')}</p>}
                            </StatusBox>
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
                    {mode !== 'status' && !succeeded && !noPrereqs && (
                        <Button onClick={handleSubmit} loading={disabled} disabled={!!running}>
                            {customization
                                ? t('retry')
                                : mode === 'iterate'
                                  ? t('submitIterate')
                                  : t('submit')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CustomizationStatusPanel({
    t,
    customization,
    running,
    succeeded,
    failed,
}: {
    t: ReturnType<typeof useTranslations>;
    customization: TemplateCustomization | TemplateCustomizationSummary | null;
    running: boolean;
    succeeded: boolean;
    failed: boolean;
}) {
    if (!customization) {
        return (
            <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-sm text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                {t('messages.noRuns')}
            </div>
        );
    }
    return (
        <StatusBox failed={failed} succeeded={succeeded} running={running}>
            <span className="font-medium">{t(`status.${customization.status}`)}</span>
            {failed && customization.errorMessage && (
                <p className="mt-2 text-xs">{customization.errorMessage}</p>
            )}
            {succeeded && <p className="mt-2 text-xs">{t('successHelp')}</p>}
        </StatusBox>
    );
}

function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="space-y-2">
            <label className="block text-sm font-medium text-text dark:text-text-dark">
                {label}
            </label>
            {children}
            {hint && <p className="text-xs text-text-muted dark:text-text-muted-dark">{hint}</p>}
        </div>
    );
}

function StatusBox({
    failed,
    succeeded,
    running,
    children,
}: {
    failed: boolean;
    succeeded: boolean;
    running: boolean;
    children: React.ReactNode;
}) {
    const tone = failed
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
        : succeeded
          ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300'
          : 'border-border bg-surface text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark';
    return (
        <div className={`rounded-lg border px-4 py-3 text-sm ${tone}`}>
            <div className="flex items-center gap-2">
                {running && <Loader2 className="h-4 w-4 animate-spin" />}
                {children}
            </div>
        </div>
    );
}
