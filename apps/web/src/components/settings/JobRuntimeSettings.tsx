'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, RotateCw, ShieldOff, Undo2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    JobRuntimeCredentialsForm,
    validateCredentialFields,
} from './JobRuntimeCredentialsForm';
import { PROVIDERS_WITHOUT_CREDENTIALS } from './job-runtime-schemas';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type {
    TenantJobRuntimeConfigResponse,
    TenantJobRuntimeMode,
    TenantJobRuntimeProviderId,
    UpsertTenantJobRuntimeConfigPayload,
} from '@/lib/api/tenant-job-runtime';
import {
    forceInvalidateJobRuntimeAction,
    revertJobRuntimeToInheritAction,
    rotateJobRuntimeAction,
    upsertJobRuntimeConfigAction,
} from '@/app/actions/settings/job-runtime';

interface JobRuntimeSettingsProps {
    initialConfig: TenantJobRuntimeConfigResponse;
    /**
     * EW-742 P5 (T34) — provider ids the operator allow-list permits
     * (server fetched via `/api/account/job-runtime/available-providers`).
     * The picker filters its options against this list; when the
     * tenant's currently saved `providerId` is no longer in the list
     * (operator disabled it after the tenant configured it), the form
     * shows a warning banner pointing the user at an inherit / switch
     * recovery path.
     */
    availableProviders: TenantJobRuntimeProviderId[];
    loadError: string | null;
}

const PROVIDER_LABELS: Record<TenantJobRuntimeProviderId, string> = {
    trigger: 'Trigger.dev',
    temporal: 'Temporal',
    bullmq: 'BullMQ',
    pgboss: 'pg-boss',
    inngest: 'Inngest',
};

const MODE_OPTIONS: { value: TenantJobRuntimeMode; labelKey: string }[] = [
    { value: 'inherit', labelKey: 'mode.inherit' },
    { value: 'byo', labelKey: 'mode.byo' },
    { value: 'override', labelKey: 'mode.override' },
];

function formatTimestamp(value: string | null): string {
    if (!value) return '-';
    try {
        return new Date(value).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

/**
 * EW-742 P2.1 — tenant admin UI for the job-runtime overlay.
 *
 * Renders:
 *   - Provider picker (`trigger | temporal | bullmq | pgboss | inngest`)
 *   - Mode toggle (`inherit | byo | override`)
 *   - Conditional credentials block (only when mode != inherit):
 *       * `credentialsSecretRef` opaque pointer
 *       * `credentialsJson` textarea for the underlying blob — collected
 *         in the UI but NOT yet POSTed (P2.1 scope is the pointer-only
 *         contract per the controller; per-provider schema-driven forms
 *         + secrets-store POST land in P2.2).
 *   - Save / Rotate / Force-invalidate (with confirm) / Revert-to-inherit
 *   - Credential version + updatedAt readout
 *
 * Schema-driven per-provider credentials forms (parsing providers.md
 * JSON Schemas) are explicitly deferred to a follow-up sub-story per
 * the implementing prompt.
 */
export function JobRuntimeSettings({
    initialConfig,
    availableProviders,
    loadError,
}: JobRuntimeSettingsProps) {
    const t = useTranslations('dashboard.settings.jobRuntime');
    const [config, setConfig] = useState<TenantJobRuntimeConfigResponse>(initialConfig);

    // EW-742 P5 (T34) — derive picker options from the operator
    // allow-list. Order follows the operator declaration (the server
    // preserves it). Memoised against the prop so toggling unrelated
    // form state doesn't re-build the array.
    const providerOptions = useMemo(
        () => availableProviders.map((value) => ({ value, label: PROVIDER_LABELS[value] })),
        [availableProviders],
    );

    // Form-local state mirrors the editable shape of the upsert payload.
    // We initialise providerId with a sane default when the row is the
    // synthetic inherit (providerId = null) — the dropdown can't render
    // null so we pre-select the first operator-allowed provider (falling
    // back to `trigger` if the allow-list is empty, which shouldn't
    // happen given the server fail-open default but keeps the UI from
    // rendering an empty Select).
    const defaultPickerValue: TenantJobRuntimeProviderId = availableProviders[0] ?? 'trigger';
    const [providerId, setProviderId] = useState<TenantJobRuntimeProviderId>(
        (initialConfig.providerId ?? defaultPickerValue) as TenantJobRuntimeProviderId,
    );
    const [mode, setMode] = useState<TenantJobRuntimeMode>(initialConfig.mode);
    const [enabled, setEnabled] = useState<boolean>(initialConfig.enabled);
    const [credentialsSecretRef, setCredentialsSecretRef] = useState<string>('');
    // EW-742 P2.2 T17 — schema-driven per-provider credential values.
    // Each provider's field set comes from `job-runtime-schemas.ts`
    // (mirror of the plugin's settingsSchema); values are stored as
    // a flat string map and serialised to JSON on save.
    const [credentialValues, setCredentialValues] = useState<Readonly<Record<string, string>>>({});

    const [confirmInvalidate, setConfirmInvalidate] = useState(false);
    const [confirmRevert, setConfirmRevert] = useState(false);
    const [isPending, startTransition] = useTransition();

    const needsCredentials = mode !== 'inherit';
    const providerHasCredentials = !PROVIDERS_WITHOUT_CREDENTIALS.has(providerId);

    const missingRequiredFields = useMemo(
        () =>
            needsCredentials && providerHasCredentials
                ? validateCredentialFields(providerId, credentialValues)
                : [],
        [needsCredentials, providerHasCredentials, providerId, credentialValues],
    );

    const applyConfig = (next: TenantJobRuntimeConfigResponse) => {
        setConfig(next);
        setProviderId((next.providerId ?? defaultPickerValue) as TenantJobRuntimeProviderId);
        setMode(next.mode);
        setEnabled(next.enabled);
    };

    // EW-742 P5 (T34) — currently-saved provider is no longer in the
    // operator allow-list. Show a warning banner so the user knows the
    // overlay needs to be reconfigured (revert to inherit or switch to
    // an allowed provider). We only flag this for non-inherit rows;
    // inherit-mode rows ignore providerId entirely.
    const savedProviderDisallowed =
        config.mode !== 'inherit' &&
        config.providerId !== null &&
        !availableProviders.includes(config.providerId);
    const noProvidersAvailable = availableProviders.length === 0;

    const handleSave = () => {
        if (needsCredentials && !credentialsSecretRef.trim()) {
            toast.error(t('messages.secretRefRequired'));
            return;
        }
        if (missingRequiredFields.length > 0) {
            toast.error(
                t('messages.requiredFieldsMissing', { fields: missingRequiredFields.join(', ') }),
            );
            return;
        }

        const payload: UpsertTenantJobRuntimeConfigPayload = {
            providerId,
            mode,
            enabled,
        };

        if (needsCredentials) {
            payload.credentialsSecretRef = credentialsSecretRef.trim();
        }

        startTransition(async () => {
            const result = await upsertJobRuntimeConfigAction(payload);
            if (result.success) {
                applyConfig(result.data);
                setCredentialsSecretRef('');
                setCredentialValues({});
                toast.success(t('messages.saveSuccess'));
            } else {
                toast.error(result.error || t('messages.saveError'));
            }
        });
    };

    const handleRotate = () => {
        startTransition(async () => {
            const result = await rotateJobRuntimeAction();
            if (result.success) {
                const { credentialVersion } = result.data;
                setConfig((prev) => ({
                    ...prev,
                    credentialVersion,
                }));
                toast.success(t('messages.rotateSuccess', { version: credentialVersion }));
            } else {
                toast.error(result.error || t('messages.rotateError'));
            }
        });
    };

    const handleForceInvalidate = () => {
        startTransition(async () => {
            const result = await forceInvalidateJobRuntimeAction();
            setConfirmInvalidate(false);
            if (result.success) {
                const { credentialVersion } = result.data;
                setConfig((prev) => ({
                    ...prev,
                    credentialVersion,
                }));
                toast.success(t('messages.invalidateSuccess', { version: credentialVersion }));
            } else {
                toast.error(result.error || t('messages.invalidateError'));
            }
        });
    };

    const handleRevert = () => {
        startTransition(async () => {
            const result = await revertJobRuntimeToInheritAction();
            setConfirmRevert(false);
            if (result.success) {
                applyConfig(result.data);
                setCredentialsSecretRef('');
                setCredentialValues({});
                toast.success(t('messages.revertSuccess'));
            } else {
                toast.error(result.error || t('messages.revertError'));
            }
        });
    };

    const hasOverlayRow = config.credentialVersion !== null;

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {loadError && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">{loadError}</p>
                </div>
            )}

            {savedProviderDisallowed && config.providerId && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('messages.providerNoLongerAllowed', {
                            provider: PROVIDER_LABELS[config.providerId] ?? config.providerId,
                        })}
                    </p>
                </div>
            )}

            {noProvidersAvailable && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('messages.noProvidersAvailable')}
                    </p>
                </div>
            )}

            <div className="grid grid-cols-1 @lg/main:grid-cols-2 gap-4 p-4 rounded-lg border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40">
                <Readout label={t('readout.mode')} value={t(`mode.${config.mode}` as never)} />
                <Readout
                    label={t('readout.provider')}
                    value={config.providerId ?? t('readout.providerNone')}
                />
                <Readout
                    label={t('readout.credentialVersion')}
                    value={
                        config.credentialVersion === null
                            ? t('readout.noOverlay')
                            : `v${config.credentialVersion}`
                    }
                />
                <Readout
                    label={t('readout.credentialsRef')}
                    value={
                        config.hasCredentials && config.credentialsSecretRefRedacted
                            ? config.credentialsSecretRefRedacted
                            : t('readout.noCredentials')
                    }
                />
                <Readout label={t('readout.updatedAt')} value={formatTimestamp(config.updatedAt)} />
                <Readout
                    label={t('readout.enabled')}
                    value={config.enabled ? t('readout.yes') : t('readout.no')}
                />
            </div>

            <div className="space-y-6">
                <div>
                    <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                        {t('fields.providerLabel')}
                    </label>
                    <Select
                        value={providerId}
                        onValueChange={(value) =>
                            setProviderId(value as TenantJobRuntimeProviderId)
                        }
                        disabled={noProvidersAvailable}
                    >
                        {providerOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </Select>
                    <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('fields.providerHelper')}
                    </p>
                </div>

                <div>
                    <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                        {t('fields.modeLabel')}
                    </label>
                    <Select
                        value={mode}
                        onValueChange={(value) => setMode(value as TenantJobRuntimeMode)}
                    >
                        {MODE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {t(opt.labelKey as never)}
                            </option>
                        ))}
                    </Select>
                    <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t(`fields.modeHelper.${mode}` as never)}
                    </p>
                </div>

                <div className="flex items-center justify-between gap-4">
                    <div>
                        <label className="block text-sm font-medium text-text dark:text-text-dark">
                            {t('fields.enabledLabel')}
                        </label>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                            {t('fields.enabledHelper')}
                        </p>
                    </div>
                    <Switch checked={enabled} onChange={setEnabled} />
                </div>

                {needsCredentials && (
                    <div className="space-y-4 p-4 rounded-lg border border-border dark:border-border-dark">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('credentials.title')}
                        </h3>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('credentials.subtitle')}
                        </p>

                        <Input
                            label={t('credentials.secretRefLabel')}
                            value={credentialsSecretRef}
                            onChange={(e) => setCredentialsSecretRef(e.target.value)}
                            placeholder={t('credentials.secretRefPlaceholder')}
                            maxLength={128}
                        />

                        {/*
                          EW-742 P2.2 T17 — per-provider schema-driven form
                          replaces the opaque credentialsJson textarea. Reset
                          state on provider change via `key={providerId}`.
                        */}
                        <div className="pt-2 border-t border-border/40 dark:border-border-dark/40">
                            <JobRuntimeCredentialsForm
                                key={providerId}
                                providerId={providerId}
                                values={credentialValues}
                                onChange={setCredentialValues}
                            />
                        </div>
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-2">
                    <Button onClick={handleSave} loading={isPending}>
                        <Save className="w-4 h-4" />
                        {t('actions.save')}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={handleRotate}
                        disabled={!hasOverlayRow || isPending}
                    >
                        <RotateCw className="w-4 h-4" />
                        {t('actions.rotate')}
                    </Button>
                    <Button
                        variant="danger"
                        onClick={() => setConfirmInvalidate(true)}
                        disabled={!hasOverlayRow || isPending}
                    >
                        <ShieldOff className="w-4 h-4" />
                        {t('actions.forceInvalidate')}
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={() => setConfirmRevert(true)}
                        disabled={!hasOverlayRow || isPending}
                    >
                        <Undo2 className="w-4 h-4" />
                        {t('actions.revert')}
                    </Button>
                </div>
            </div>

            <Dialog open={confirmInvalidate} onOpenChange={setConfirmInvalidate}>
                <DialogContent>
                    <DialogClose onClose={() => setConfirmInvalidate(false)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('forceInvalidate.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('forceInvalidate.description')}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setConfirmInvalidate(false)}>
                            {t('forceInvalidate.cancel')}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleForceInvalidate}
                            loading={isPending}
                        >
                            {t('forceInvalidate.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={confirmRevert} onOpenChange={setConfirmRevert}>
                <DialogContent>
                    <DialogClose onClose={() => setConfirmRevert(false)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('revert.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('revert.description')}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setConfirmRevert(false)}>
                            {t('revert.cancel')}
                        </Button>
                        <Button variant="danger" onClick={handleRevert} loading={isPending}>
                            {t('revert.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function Readout({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{label}</p>
            <p className="text-sm font-medium text-text dark:text-text-dark mt-1 break-all">
                {value}
            </p>
        </div>
    );
}
