'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    getAppBuildSettingsAction,
    saveAppBuildSettingsAction,
} from '@/app/actions/dashboard/app-builds';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    APP_BUILD_SETTINGS_DEFAULTS,
    APP_BUILD_SETTINGS_LIMITS,
    appBuildSettingsPatch,
    type AppBuildSettings,
    type AppBuildSettingsError,
} from '@/lib/works/app-build-settings.shared';

/**
 * APW-05 T28 / T46 (lane aw-builds-bindings, 2026-10-27) — **Build settings** (spec §6.1's
 * header button, plan §6.2's `BuildSettingsDialog`).
 *
 * Larger runner (label, memory, vCPU; private repositories), reclaim disk, provenance
 * attestations (public repositories only), and XC-01's two switches: whether stored build values
 * reach pull requests (off by default, with the warning plan §4.7b asks for) and whether a
 * verification needs approval before it uses prompted values (on by default).
 *
 * The plugin id is the Builds list's `provider.pluginId`, passed in — this component never names
 * a plugin. The values are read when the dialog opens and written once on Save; a viewer sees the
 * button disabled (the API refuses a viewer anyway).
 */
export interface AppBuildSettingsDialogProps {
    workId: string;
    pluginId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** From the Builds list's `repository.visibility`; attestations show only when `true`. */
    publicRepository: boolean;
    canEdit: boolean;
}

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error' };

function toNumber(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : Number.NaN;
}

export function AppBuildSettingsDialog({
    workId,
    pluginId,
    open,
    onOpenChange,
    publicRepository,
    canEdit,
}: AppBuildSettingsDialogProps) {
    const t = useTranslations('dashboard.workDetail.builds.settings');
    const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
    const [values, setValues] = useState<AppBuildSettings>(APP_BUILD_SETTINGS_DEFAULTS);
    const [memoryText, setMemoryText] = useState('');
    const [vcpuText, setVcpuText] = useState('');
    const [error, setError] = useState<AppBuildSettingsError | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoad({ kind: 'loading' });
        setError(null);
        void getAppBuildSettingsAction(workId, pluginId).then((result) => {
            if (cancelled) return;
            if (!result.success || !result.data) {
                setLoad({ kind: 'error' });
                return;
            }
            const settings = result.data.settings;
            setValues(settings);
            setMemoryText(
                settings.largerRunnerMemoryGiB === null
                    ? ''
                    : String(settings.largerRunnerMemoryGiB),
            );
            setVcpuText(
                settings.largerRunnerVcpu === null ? '' : String(settings.largerRunnerVcpu),
            );
            setLoad({ kind: 'ready' });
        });
        return () => {
            cancelled = true;
        };
    }, [open, workId, pluginId]);

    const set = <K extends keyof AppBuildSettings>(key: K, value: AppBuildSettings[K]) =>
        setValues((current) => ({ ...current, [key]: value }));

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canEdit || saving || load.kind !== 'ready') return;
        const patch = appBuildSettingsPatch(
            {
                ...values,
                largerRunnerMemoryGiB: toNumber(memoryText),
                largerRunnerVcpu: toNumber(vcpuText),
            },
            { publicRepository },
        );
        if (!patch.ok) {
            setError(patch.error);
            return;
        }
        setError(null);
        setSaving(true);
        try {
            const result = await saveAppBuildSettingsAction(workId, pluginId, patch.settings);
            if (result.success) {
                toast.success(t('saved'));
                onOpenChange(false);
                return;
            }
            toast.error(result.statusCode === 403 ? t('viewerDisabled') : t('saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    const disabled = !canEdit || load.kind !== 'ready' || saving;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {load.kind === 'loading' && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('loading')}
                    </p>
                )}
                {load.kind === 'error' && (
                    <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                        {t('loadFailed')}
                    </p>
                )}

                {load.kind === 'ready' && (
                    <form
                        id="app-build-settings-form"
                        onSubmit={(event) => void submit(event)}
                        className="space-y-5"
                        data-testid="app-build-settings-form"
                    >
                        <fieldset className="space-y-3" disabled={disabled}>
                            <legend className="text-sm font-medium text-text dark:text-text-dark">
                                {t('largerRunner.title')}
                            </legend>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('largerRunner.help')}
                            </p>
                            <Input
                                label={t('largerRunner.label')}
                                value={values.largerRunnerLabel}
                                onChange={(event) => set('largerRunnerLabel', event.target.value)}
                                maxLength={64}
                                autoComplete="off"
                                error={
                                    error === 'labelInvalid' ? t('errors.labelInvalid') : undefined
                                }
                                data-testid="app-build-settings-runner-label"
                            />
                            <div className="grid grid-cols-2 gap-3">
                                <Input
                                    type="number"
                                    label={t('largerRunner.memory')}
                                    value={memoryText}
                                    onChange={(event) => setMemoryText(event.target.value)}
                                    min={APP_BUILD_SETTINGS_LIMITS.memoryMinGiB}
                                    max={APP_BUILD_SETTINGS_LIMITS.memoryMaxGiB}
                                    error={
                                        error === 'memoryRequired' || error === 'memoryRange'
                                            ? t(`errors.${error}`, {
                                                  min: APP_BUILD_SETTINGS_LIMITS.memoryMinGiB,
                                                  max: APP_BUILD_SETTINGS_LIMITS.memoryMaxGiB,
                                              })
                                            : undefined
                                    }
                                    data-testid="app-build-settings-runner-memory"
                                />
                                <Input
                                    type="number"
                                    label={t('largerRunner.vcpu')}
                                    value={vcpuText}
                                    onChange={(event) => setVcpuText(event.target.value)}
                                    min={APP_BUILD_SETTINGS_LIMITS.vcpuMin}
                                    max={APP_BUILD_SETTINGS_LIMITS.vcpuMax}
                                    error={
                                        error === 'vcpuRange'
                                            ? t('errors.vcpuRange', {
                                                  min: APP_BUILD_SETTINGS_LIMITS.vcpuMin,
                                                  max: APP_BUILD_SETTINGS_LIMITS.vcpuMax,
                                              })
                                            : undefined
                                    }
                                    data-testid="app-build-settings-runner-vcpu"
                                />
                            </div>
                        </fieldset>

                        <Switch
                            checked={values.reclaimDisk}
                            onChange={(checked) => set('reclaimDisk', checked)}
                            disabled={disabled}
                            label={t('reclaimDisk')}
                            helperText={t('reclaimDiskHelp')}
                            data-testid="app-build-settings-reclaim-disk"
                        />

                        {publicRepository && (
                            <Switch
                                checked={values.attestations}
                                onChange={(checked) => set('attestations', checked)}
                                disabled={disabled}
                                label={t('attestations')}
                                helperText={t('attestationsHelp')}
                                data-testid="app-build-settings-attestations"
                            />
                        )}

                        <div>
                            <Switch
                                checked={values.allowBuildValuesOnPullRequests}
                                onChange={(checked) =>
                                    set('allowBuildValuesOnPullRequests', checked)
                                }
                                disabled={disabled}
                                label={t('allowBuildValuesOnPullRequests')}
                                helperText={t('allowBuildValuesOnPullRequestsHelp')}
                                data-testid="app-build-settings-pr-values"
                            />
                            {values.allowBuildValuesOnPullRequests && (
                                <p
                                    className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                                    role="note"
                                    data-testid="app-build-settings-pr-values-warning"
                                >
                                    {t('allowBuildValuesOnPullRequestsWarning')}
                                </p>
                            )}
                        </div>

                        <Switch
                            checked={values.verificationPromptedValuesRequireApproval}
                            onChange={(checked) =>
                                set('verificationPromptedValuesRequireApproval', checked)
                            }
                            disabled={disabled}
                            label={t('verificationPromptedValuesRequireApproval')}
                            helperText={t('verificationPromptedValuesRequireApprovalHelp')}
                            data-testid="app-build-settings-verification-approval"
                        />
                    </form>
                )}

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        form="app-build-settings-form"
                        variant="primary"
                        disabled={disabled}
                        loading={saving}
                        title={canEdit ? undefined : t('viewerDisabled')}
                        data-testid="app-build-settings-save"
                    >
                        {t('save')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
