'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { configureAppDependencyAction } from '@/app/actions/dashboard/app-dependencies';
import type { AppDependencyEntry } from '@/lib/api/app-dependencies.types';

export interface AppDependencyConfigureDialogProps {
    workId: string;
    entry: AppDependencyEntry;
    kindLabel: string;
    onOpenChange: (open: boolean) => void;
    /** After the API accepted the change — the card re-reads itself. */
    onConfigured: () => void;
}

/** The refusals with their own sentence → `dependencies.configure.refusals.*`. */
const CONFIGURE_REFUSALS: Readonly<Record<string, string>> = {
    providerNotSupported: 'providerNotSupported',
    sizeShrink: 'sizeShrink',
    volumeShrink: 'sizeShrink',
    secureStorageUnavailable: 'secureStorageUnavailable',
    dependencyNotDeclared: 'notDeclared',
    editAccessRequired: 'forbidden',
    invalidBody: 'invalid',
    leaseHeld: 'leaseHeld',
};

/**
 * Lane aw-ops (APW-07 T29) — **Configure** a dependency: pick a provider among the ones this
 * target offers, give its prompted settings, and grow the volume.
 *
 * A secret setting is write-only: the field starts empty and says whether a value is stored, and
 * an empty field leaves the stored value as it is. Only the fields the member filled in are sent,
 * once, and nothing comes back but the card. A size below the current one is not offered (a volume
 * only grows; the API refuses it too).
 */
export function AppDependencyConfigureDialog({
    workId,
    entry,
    kindLabel,
    onOpenChange,
    onConfigured,
}: AppDependencyConfigureDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.dependencies.configure');
    const providerId = useId();
    const sizeId = useId();
    const providers = entry.availableProviders ?? [];
    const [provider, setProvider] = useState<string>(entry.provider.providerId);
    const [values, setValues] = useState<Record<string, string>>({});
    const [size, setSize] = useState<string>(entry.sizeGiB ? String(entry.sizeGiB) : '');
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const inFlight = useRef(false);

    const chosen = providers.find((option) => option.providerId === provider) ?? null;
    const fields = chosen?.promptFields ?? [];
    const minSize = entry.sizeGiB ?? 1;
    const sizeNumber = size.trim() === '' ? null : Number(size);
    const sizeInvalid = sizeNumber !== null && (!Number.isInteger(sizeNumber) || sizeNumber < minSize);
    const missingRequired = fields.some(
        (field) => field.required && !field.set && !(values[field.key] ?? '').trim(),
    );

    const submit = async () => {
        if (inFlight.current || sizeInvalid || missingRequired) return;
        inFlight.current = true;
        setPending(true);
        setMessage(null);
        try {
            const config: Record<string, string> = {};
            for (const field of fields) {
                const value = values[field.key];
                if (typeof value === 'string' && value.length > 0) config[field.key] = value;
            }
            const result = await configureAppDependencyAction(workId, entry.kind, {
                ...(provider !== entry.provider.providerId ? { providerId: provider } : {}),
                ...(Object.keys(config).length > 0 ? { config } : {}),
                ...(sizeNumber !== null && sizeNumber !== entry.sizeGiB ? { sizeGiB: sizeNumber } : {}),
            });
            if (result.success) {
                toast.success(t('saved', { kind: kindLabel }));
                // Drop what was typed at once: a secret must not linger in component state.
                setValues({});
                onConfigured();
                return;
            }
            const leaf = result.code ? CONFIGURE_REFUSALS[result.code] : undefined;
            setMessage(leaf ? t(`refusals.${leaf}`) : t('failed', { reason: result.error ?? result.code ?? '' }));
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    };

    const nothingToSend =
        provider === entry.provider.providerId &&
        Object.values(values).every((value) => !value) &&
        (sizeNumber === null || sizeNumber === entry.sizeGiB);

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-dependency-configure-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title', { kind: kindLabel })}
                        </DialogTitle>
                        <DialogDescription>{t('description')}</DialogDescription>
                    </DialogHeader>

                    {providers.length > 1 && (
                        <label htmlFor={providerId} className="block space-y-1 text-sm">
                            <span className="block text-xs text-text-secondary">{t('provider')}</span>
                            <select
                                id={providerId}
                                className="w-full rounded-md border border-card-border bg-transparent px-2 py-1.5 dark:border-white/9"
                                value={provider}
                                onChange={(event) => {
                                    setProvider(event.target.value);
                                    setValues({});
                                }}
                                data-testid="app-dependency-configure-provider"
                            >
                                {providers.map((option) => (
                                    <option key={option.providerId} value={option.providerId}>
                                        {option.label || option.providerId}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    {fields.map((field) => (
                        <ConfigField
                            key={`${provider}:${field.key}`}
                            label={field.label || field.key}
                            secret={field.secret}
                            required={field.required}
                            stored={field.set}
                            value={values[field.key] ?? ''}
                            onChange={(value) => setValues((previous) => ({ ...previous, [field.key]: value }))}
                        />
                    ))}

                    <label htmlFor={sizeId} className="block space-y-1 text-sm">
                        <span className="block text-xs text-text-secondary">{t('size')}</span>
                        <Input
                            id={sizeId}
                            type="number"
                            min={minSize}
                            step={1}
                            value={size}
                            onChange={(event) => setSize(event.target.value)}
                            data-testid="app-dependency-configure-size"
                        />
                        <span className="block text-xs text-text-muted">
                            {entry.sizeGiB ? t('sizeGrowOnly', { size: entry.sizeGiB }) : t('sizeHint')}
                        </span>
                        {sizeInvalid && (
                            <span className="block text-xs text-red-600 dark:text-red-400">
                                {t('sizeTooSmall', { size: minSize })}
                            </span>
                        )}
                    </label>

                    {message && (
                        <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="app-dependency-configure-error">
                            {message}
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => void submit()}
                            loading={pending}
                            disabled={pending || sizeInvalid || missingRequired || nothingToSend}
                            data-testid="app-dependency-configure-save"
                        >
                            {t('save')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function ConfigField({
    label,
    secret,
    required,
    stored,
    value,
    onChange,
}: {
    label: string;
    secret: boolean;
    required: boolean;
    stored: boolean;
    value: string;
    onChange: (value: string) => void;
}) {
    const t = useTranslations('dashboard.workDetail.appDeploy.dependencies.configure');
    const id = useId();
    return (
        <label htmlFor={id} className="block space-y-1 text-sm" data-testid="app-dependency-configure-field">
            <span className="block text-xs text-text-secondary">
                {label}
                {required ? ` · ${t('required')}` : ''}
            </span>
            <Input
                id={id}
                type={secret ? 'password' : 'text'}
                autoComplete={secret ? 'new-password' : 'off'}
                value={value}
                onChange={(event) => onChange(event.target.value)}
            />
            {stored && (
                <span className="block text-xs text-text-muted">{secret ? t('secretStored') : t('stored')}</span>
            )}
        </label>
    );
}
