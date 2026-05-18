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
    iterateCustomTemplate,
} from '@/app/actions/dashboard/templates';

const TERMINAL_STATUSES: TemplateCustomization['status'][] = ['succeeded', 'failed'];

export interface CustomizationStartedArgs {
    customization: TemplateCustomization;
    template?: {
        id: string;
        name: string;
        repositoryOwner: string;
        repositoryName: string;
        repositoryUrl: string | null;
    };
}

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
    mode?: CustomizeDialogMode;
    targetTemplate?: TemplateCatalogItem | null;
    onCustomizationStarted?: (args: CustomizationStartedArgs) => void;
}

export function CreateCustomTemplateDialog({
    open,
    onOpenChange,
    customizableBases,
    providers,
    aiProviders,
    forkTargets,
    mode = 'new',
    targetTemplate = null,
    onCustomizationStarted,
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
    // Local customization snapshot covers the gap between submit success
    // and the parent picking up the new latestCustomization. After that,
    // the page-level poller is the source of truth via `targetTemplate`.
    const [pendingCustomization, setPendingCustomization] = useState<TemplateCustomization | null>(
        null,
    );
    // Id of the run this dialog instance kicked off. Lets us distinguish
    // "you just submitted and it finished" (show Done, hide submit) from
    // "this template has a prior succeeded run" (keep submit available).
    const [sessionRunId, setSessionRunId] = useState<string | null>(null);

    const customization: TemplateCustomization | TemplateCustomizationSummary | null =
        targetTemplate?.latestCustomization ?? pendingCustomization;

    useEffect(() => {
        if (
            pendingCustomization &&
            targetTemplate?.latestCustomization?.id === pendingCustomization.id
        ) {
            setPendingCustomization(null);
        }
    }, [pendingCustomization, targetTemplate?.latestCustomization?.id]);

    // Seed the prompt with the prior run on iterate-mode open. Only fires
    // on the false→true transition so polling updates don't overwrite
    // whatever the user is typing mid-session. Prefer the most-recent
    // run's prompt; fall back to the last-known-good prompt persisted on
    // template.metadata so prefill works even when the customization
    // summary doesn't carry it.
    const prevOpenRef = useRef(false);
    useEffect(() => {
        if (open && !prevOpenRef.current && mode === 'iterate') {
            const seed =
                targetTemplate?.latestCustomization?.prompt ||
                targetTemplate?.lastCustomizationPrompt ||
                '';
            if (seed) setPrompt(seed);
        }
        prevOpenRef.current = open;
    }, [
        open,
        mode,
        targetTemplate?.latestCustomization?.prompt,
        targetTemplate?.lastCustomizationPrompt,
    ]);

    const reset = useCallback(() => {
        setName('');
        setPrompt('');
        setPendingCustomization(null);
        setSessionRunId(null);
        setBaseTemplateId(customizableBases[0]?.id ?? '');
        setProviderId(defaultProviderId);
        setAiProviderId(defaultAiProviderId);
        setTargetOwner(forkTargets[0]?.login ?? '');
    }, [customizableBases, defaultProviderId, defaultAiProviderId, forkTargets]);

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
                    setPendingCustomization(result.customization);
                    setSessionRunId(result.customization.id);
                    onCustomizationStarted?.({ customization: result.customization });
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
                setPendingCustomization(result.customization);
                setSessionRunId(result.customization.id);
                onCustomizationStarted?.({
                    customization: result.customization,
                    template: result.template ?? undefined,
                });
                toast.message(t('toast.started'));
            })();
        });
    };

    const running = customization && !TERMINAL_STATUSES.includes(customization.status);
    const succeeded = customization?.status === 'succeeded';
    const failed = customization?.status === 'failed';
    const isSessionRun = !!customization && customization.id === sessionRunId;
    const sessionRunSucceeded = isSessionRun && succeeded;
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

                        {customization && (isSessionRun || !!running || failed) && (
                            <StatusBox failed={failed} succeeded={succeeded} running={!!running}>
                                <span className="font-medium">
                                    {t(`status.${customization.status}`)}
                                </span>
                                {failed && customization.errorMessage && (
                                    <p className="mt-2 text-xs">{customization.errorMessage}</p>
                                )}
                                {sessionRunSucceeded && (
                                    <p className="mt-2 text-xs">{t('successHelp')}</p>
                                )}
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
                        {sessionRunSucceeded ? t('done') : t('cancel')}
                    </Button>
                    {mode !== 'status' && !sessionRunSucceeded && !noPrereqs && (
                        <Button onClick={handleSubmit} loading={disabled} disabled={!!running}>
                            {mode === 'iterate'
                                ? t('submitIterate')
                                : failed
                                  ? t('retry')
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
