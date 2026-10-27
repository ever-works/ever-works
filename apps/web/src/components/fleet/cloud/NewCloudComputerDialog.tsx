'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    fleetCloudPriceSentence,
    isFleetCloudName,
    type FleetCloudCreateResponse,
    type FleetCloudOptionsView,
    type FleetCloudProviderView,
    type FleetCloudSoftwareId,
    type FleetLinkError,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { connectOAuthProvider } from '@/app/actions/dashboard/oauth';
import { ROUTES } from '@/lib/constants';
import {
    createFleetCloudAction,
    fleetCloudOptionsAction,
    listFleetCloudProvidersAction,
} from '@/app/actions/fleet/cloud';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    CLOUD_SOFTWARE_KEYS,
    changedPriceOf,
    createLabelPrice,
    formatMemory,
    hourly,
    initialCloudForm,
    money,
    sizesForRegion,
    withOptionDefaults,
    type CloudForm,
} from './cloud.shared';

const FIELD =
    'h-8 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm';

/**
 * Cloud computers (FL-17, spec §0, §5.1, FR-2 – FR-7) — "New cloud computer":
 * provider (with the connected account), name, region, size (a radio group,
 * each with its monthly and hourly list price), software presets (Docker,
 * Node.js, Claude Code, Codex on by default) and, before Create, the price
 * sentence: what it costs, that the provider bills the owner's account from
 * creation until destruction (also while off where it does), and that Ever
 * Works keeps no password or key. The Create button carries the price.
 *
 * Create sends `confirm: true` with the monthly price shown as
 * `acknowledgedPriceCents` (the dialog IS the confirmation; its sentence is
 * the one the API's 409 carries). A price that changed meanwhile comes back
 * `invalid` with the current price: the dialog reloads the prices and asks
 * again (U9). With no provider configured it shows the empty state (U1).
 */
export function NewCloudComputerDialog({
    open,
    onClose,
    onCreated,
}: {
    open: boolean;
    onClose: () => void;
    onCreated?: (created: FleetCloudCreateResponse) => void;
}) {
    const t = useTranslations('fleet.cloud');
    const [providers, setProviders] = useState<FleetCloudProviderView[] | null>(null);
    const [form, setForm] = useState<CloudForm>(() => initialCloudForm());
    const [options, setOptions] = useState<FleetCloudOptionsView | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<FleetLinkError | null>(null);
    const [error, setError] = useState<FleetLinkError | null>(null);
    const [priceChanged, setPriceChanged] = useState<number | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    // P3 (FR-32): the overlay-VPN client's one-time key — in this dialog's memory
    // only, sent once with Create, never echoed back.
    const [vpnAuthKey, setVpnAuthKey] = useState('');
    const [signingIn, setSigningIn] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // The providers, once per opening.
    useEffect(() => {
        if (!open) return;
        let live = true;
        setForm(initialCloudForm());
        setOptions(null);
        setError(null);
        setPriceChanged(null);
        setProviders(null);
        setVpnAuthKey('');
        void listFleetCloudProvidersAction().then((result) => {
            if (!live) return;
            const list = result.ok ? result.data.providers : [];
            setProviders(list);
            const first = list.find((provider) => provider.configured);
            if (first) setForm((previous) => ({ ...previous, pluginId: first.pluginId }));
            if (!result.ok) setLoadError(result.error);
        });
        return () => {
            live = false;
        };
    }, [open]);

    // The chosen provider's regions, sizes and current prices.
    useEffect(() => {
        if (!open || !form.pluginId) return;
        let live = true;
        setLoading(true);
        setLoadError(null);
        void fleetCloudOptionsAction(form.pluginId).then((result) => {
            if (!live) return;
            setLoading(false);
            if (result.ok) {
                setOptions(result.data);
                setForm((previous) => withOptionDefaults(previous, result.data));
            } else {
                setOptions(null);
                setLoadError(result.error);
            }
        });
        return () => {
            live = false;
        };
    }, [open, form.pluginId, reloadKey]);

    const configured = (providers ?? []).filter((provider) => provider.configured);
    const provider = configured.find((entry) => entry.pluginId === form.pluginId) ?? null;
    const sizes = useMemo(() => sizesForRegion(options, form.regionId), [options, form.regionId]);
    const size = sizes.find((entry) => entry.id === form.sizeId) ?? null;
    const nameValid = isFleetCloudName(form.name);
    const atLimit = Boolean(options && options.limits.used >= options.limits.maxPerOwner);
    const canCreate = Boolean(options && provider && size && nameValid && !atLimit && !pending && !loading);

    const sentence =
        options && size
            ? fleetCloudPriceSentence({
                  providerName: options.providerName,
                  monthlyPriceCents: size.priceMonthlyCents,
                  hourlyRateCents: size.priceHourlyCents,
                  billsWhileOff: options.billsWhileOff,
                  currency: options.currency,
              })
            : null;

    const set = <K extends keyof CloudForm>(key: K, value: CloudForm[K]) =>
        setForm((previous) => ({ ...previous, [key]: value }));

    const toggleSoftware = (id: FleetCloudSoftwareId) =>
        setForm((previous) => ({
            ...previous,
            software: previous.software.includes(id)
                ? previous.software.filter((entry) => entry !== id)
                : [...previous.software, id],
        }));

    const create = () => {
        if (!canCreate || !size || !options) return;
        setError(null);
        startTransition(async () => {
            const result = await createFleetCloudAction({
                providerPluginId: form.pluginId,
                name: form.name,
                regionId: form.regionId,
                sizeId: size.id,
                software: form.software,
                acknowledgedPriceCents: size.priceMonthlyCents,
                confirm: true,
                ...(form.software.includes('overlay-vpn') && vpnAuthKey.trim() ? { vpnAuthKey: vpnAuthKey.trim() } : {}),
            });
            if (result.ok) {
                setVpnAuthKey('');
                toast.success(t('create.created', { name: form.name, provider: options.providerName }));
                onCreated?.(result.data);
                onClose();
                return;
            }
            const current = changedPriceOf(result.error);
            if (current !== null) {
                // U9: reload the prices and ask again.
                setPriceChanged(current);
                setReloadKey((key) => key + 1);
                return;
            }
            setError(result.error);
        });
    };

    const empty = providers !== null && configured.length === 0;
    // P3 (FR-31): providers the owner can sign in to instead of pasting a token.
    const signInable = (providers ?? []).filter((entry) => !entry.configured && entry.oauthAvailable);

    const signIn = (pluginId: string) => {
        setSigningIn(pluginId);
        void connectOAuthProvider(pluginId, `${ROUTES.DASHBOARD_FLEET_COMPUTERS}?add=cloud`).then((result) => {
            if (result.success && 'url' in result && typeof result.url === 'string') {
                window.location.assign(result.url);
                return;
            }
            setSigningIn(null);
            toast.error(t('create.signInFailed'));
        });
    };

    const signInButtons =
        signInable.length > 0 ? (
            <div className="flex flex-wrap gap-2" data-testid="fleet-cloud-sign-in">
                {signInable.map((entry) => (
                    <Button
                        key={entry.pluginId}
                        variant="secondary"
                        size="sm"
                        onClick={() => signIn(entry.pluginId)}
                        loading={signingIn === entry.pluginId}
                        data-testid={`fleet-cloud-sign-in-${entry.pluginId}`}
                    >
                        {t('create.signIn', { provider: entry.providerName })}
                    </Button>
                ))}
            </div>
        ) : null;

    return (
        <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
            <DialogContent className="max-w-xl" data-testid="fleet-cloud-dialog">
                <DialogHeader>
                    <DialogTitle>{t('create.title')}</DialogTitle>
                    <DialogDescription>{t('create.description')}</DialogDescription>
                </DialogHeader>

                {empty ? (
                    <div className="flex flex-col gap-3 text-sm" data-testid="fleet-cloud-empty">
                        <p>{t('create.empty')}</p>
                        {signInButtons}
                        <Link href={ROUTES.DASHBOARD_PLUGINS} className="text-primary underline">
                            {t('create.openPlugins')}
                        </Link>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3 text-sm">
                        <label className="flex flex-col gap-1">
                            <span className="font-medium">{t('create.provider')}</span>
                            <select
                                className={FIELD}
                                value={form.pluginId}
                                onChange={(event) => set('pluginId', event.target.value)}
                                disabled={providers === null}
                                data-testid="fleet-cloud-provider"
                            >
                                {configured.map((entry) => (
                                    <option key={entry.pluginId} value={entry.pluginId}>
                                        {entry.providerName}
                                    </option>
                                ))}
                            </select>
                            {options?.account.label ? (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('create.connectedAs', { account: options.account.label })}
                                </span>
                            ) : null}
                        </label>
                        {signInButtons}

                        <label className="flex flex-col gap-1">
                            <span className="font-medium">{t('create.name')}</span>
                            <input
                                className={FIELD}
                                value={form.name}
                                onChange={(event) => set('name', event.target.value.toLowerCase())}
                                placeholder="nyc-ops"
                                maxLength={39}
                                aria-invalid={form.name.length > 0 && !nameValid}
                                data-testid="fleet-cloud-name"
                            />
                            {form.name.length > 0 && !nameValid ? (
                                <span className="text-xs text-danger">{t('create.nameHint')}</span>
                            ) : null}
                        </label>

                        <label className="flex flex-col gap-1">
                            <span className="font-medium">{t('create.region')}</span>
                            <select
                                className={FIELD}
                                value={form.regionId}
                                onChange={(event) =>
                                    setForm((previous) =>
                                        options
                                            ? withOptionDefaults({ ...previous, regionId: event.target.value }, options)
                                            : { ...previous, regionId: event.target.value },
                                    )
                                }
                                disabled={!options}
                                data-testid="fleet-cloud-region"
                            >
                                {(options?.regions ?? []).map((region) => (
                                    <option key={region.id} value={region.id} disabled={!region.available}>
                                        {region.label}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <fieldset className="flex flex-col gap-1" data-testid="fleet-cloud-sizes">
                            <legend className="font-medium">{t('create.size')}</legend>
                            {loading ? (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('create.loading')}</span>
                            ) : null}
                            <div role="radiogroup" aria-label={t('create.size')} className="flex flex-col gap-1">
                                {sizes.map((entry) => (
                                    <label key={entry.id} className="inline-flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="fleet-cloud-size"
                                            value={entry.id}
                                            checked={form.sizeId === entry.id}
                                            onChange={() => set('sizeId', entry.id)}
                                        />
                                        <span className="flex-1">
                                            {t('create.sizeSpec', {
                                                vcpus: entry.vcpus,
                                                memory: formatMemory(entry.memoryMiB),
                                                disk: entry.diskGiB,
                                            })}
                                        </span>
                                        <span className="tabular-nums">
                                            {t('create.sizePrice', {
                                                month: money(entry.priceMonthlyCents, options?.currency),
                                                hour: hourly(entry.priceHourlyCents, options?.currency),
                                            })}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        <fieldset className="flex flex-col gap-1">
                            <legend className="font-medium">{t('create.software')}</legend>
                            <div className="flex flex-wrap gap-3">
                                {(options?.software ?? []).map((entry) => (
                                    <label key={entry.id} className="inline-flex items-center gap-1">
                                        <input
                                            type="checkbox"
                                            checked={form.software.includes(entry.id)}
                                            onChange={() => toggleSoftware(entry.id)}
                                            data-testid={`fleet-cloud-software-${entry.id}`}
                                        />
                                        {t(`create.softwareNames.${CLOUD_SOFTWARE_KEYS[entry.id]}` as never)}
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        {form.software.includes('overlay-vpn') ? (
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">{t('create.vpnKey')}</span>
                                <input
                                    className={FIELD}
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={vpnAuthKey}
                                    onChange={(event) => setVpnAuthKey(event.target.value)}
                                    maxLength={200}
                                    data-testid="fleet-cloud-vpn-key"
                                />
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('create.vpnKeyHint')}
                                </span>
                            </label>
                        ) : null}

                        {priceChanged !== null ? (
                            <p
                                className="rounded-md bg-warning/10 p-2 text-xs text-warning"
                                role="status"
                                data-testid="fleet-cloud-price-changed"
                            >
                                {t('create.priceChanged', { price: money(priceChanged, options?.currency) })}
                            </p>
                        ) : null}
                        {sentence ? (
                            <p
                                className="rounded-md bg-surface-secondary dark:bg-surface-secondary-dark p-2 text-xs"
                                data-testid="fleet-cloud-price-sentence"
                            >
                                {sentence}
                            </p>
                        ) : null}
                        {options ? (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('create.disclaimer', { provider: options.providerName })}{' '}
                                {t('create.limit', { used: options.limits.used, max: options.limits.maxPerOwner })}
                            </p>
                        ) : null}
                        {loadError ? (
                            <p className="text-sm text-danger" role="alert">
                                {loadError.hint || t('create.loadFailed')}
                            </p>
                        ) : null}
                        {error ? (
                            <p className="text-sm text-danger" role="alert" data-testid="fleet-cloud-error">
                                {error.hint || t('create.failed')}
                            </p>
                        ) : null}
                    </div>
                )}

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t('create.cancel')}
                    </Button>
                    {!empty ? (
                        <Button type="button" onClick={create} disabled={!canCreate} data-testid="fleet-cloud-create">
                            {createLabelPrice(size, options?.currency)
                                ? t('create.createWithPrice', { price: createLabelPrice(size, options?.currency) ?? '' })
                                : t('create.create')}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
