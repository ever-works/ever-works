'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import {
    INTEGRATION_KEY_PRESETS,
    INTEGRATION_SCOPES,
    type IntegrationKeySummary,
    type IntegrationKind,
    type IntegrationScope,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { createIntegrationKey, revokeApiKey, rotateApiKey } from '@/app/actions/api-keys';

/** An organization the key can be pinned to. */
export interface IntegrationKeyOrganizationOption {
    id: string;
    slug: string;
    displayName: string;
}

type PresetChoice = 'ever-gauzy' | 'custom';

interface IntegrationKeysSectionProps {
    initialKeys: IntegrationKeySummary[];
    organizations: IntegrationKeyOrganizationOption[];
    /** `?new=integration` — open the create dialog on arrival. */
    openOnArrival?: boolean;
    /** `?preset=ever-gauzy` — preselect a preset in that dialog. */
    initialPreset?: string | null;
}

const EXPIRATION_DAYS = ['', '30', '90', '365'] as const;
const GRACE_HOURS = ['0', '1', '24', '72', '168'] as const;

function presetScopes(preset: PresetChoice): IntegrationScope[] {
    return preset === 'ever-gauzy' ? [...INTEGRATION_KEY_PRESETS['ever-gauzy'].scopes] : [];
}

/**
 * EW-P1-7 — Settings → API keys → Integration keys.
 *
 * Integration keys (`ew_int_…`) are listed apart from personal keys, with
 * their pins, scopes, last use and Rotate / Revoke. "New integration key"
 * opens a dialog with name, organizations (multi-select), a scope checklist
 * and the "Ever Gauzy" preset; the deep link
 * `/settings/api-keys?new=integration&preset=ever-gauzy` opens it preset.
 * The secret is shown exactly once, on create and on rotate.
 */
export function IntegrationKeysSection({
    initialKeys,
    organizations,
    openOnArrival = false,
    initialPreset = null,
}: IntegrationKeysSectionProps) {
    const t = useTranslations('dashboard.settings.apiKeys.integration');
    const [isPending, startTransition] = useTransition();
    const [keys, setKeys] = useState<IntegrationKeySummary[]>(initialKeys);

    const startPreset: PresetChoice = initialPreset === 'ever-gauzy' ? 'ever-gauzy' : 'custom';
    // `?new=integration` opens the dialog on arrival.
    const [showCreate, setShowCreate] = useState(openOnArrival);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [preset, setPreset] = useState<PresetChoice>(startPreset);
    const [scopes, setScopes] = useState<IntegrationScope[]>(presetScopes(startPreset));
    const [orgIds, setOrgIds] = useState<string[]>(
        organizations.length === 1 ? [organizations[0].id] : [],
    );
    const [expirationDays, setExpirationDays] = useState('');
    const [secret, setSecret] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const [rotateTarget, setRotateTarget] = useState<IntegrationKeySummary | null>(null);
    const [graceHours, setGraceHours] = useState('24');
    const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

    const [revokeTarget, setRevokeTarget] = useState<IntegrationKeySummary | null>(null);

    // Whether a rotation's grace period is still running. Review 2026-10-17 U10: the clock
    // moves (a rotation, and every minute), so a grace that ended while the page is open, or
    // a rotation without one, no longer reads as a previous secret that still works.
    const [renderedAt, setRenderedAt] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setRenderedAt(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);

    const orgById = useMemo(
        () => new Map(organizations.map((org) => [org.id, org])),
        [organizations],
    );

    const formatDate = (iso: string | null) =>
        iso
            ? new Date(iso).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
              })
            : '-';

    const choosePreset = (value: string) => {
        const next: PresetChoice = value === 'ever-gauzy' ? 'ever-gauzy' : 'custom';
        setPreset(next);
        if (next === 'ever-gauzy') setScopes(presetScopes(next));
    };

    const toggle = <T,>(list: T[], value: T): T[] =>
        list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

    const resetCreate = () => {
        // The secret is minted server-side the moment the request lands; closing
        // mid-request would drop the only copy of it. Stay open until it answers.
        if (isPending) return;
        setShowCreate(false);
        setName('');
        setDescription('');
        setPreset(startPreset);
        setScopes(presetScopes(startPreset));
        setOrgIds(organizations.length === 1 ? [organizations[0].id] : []);
        setExpirationDays('');
        setSecret(null);
        setCopied(false);
    };

    const copy = async (value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error(t('messages.copyError'));
        }
    };

    const handleCreate = () => {
        if (!name.trim()) return void toast.error(t('messages.nameRequired'));
        if (orgIds.length === 0) return void toast.error(t('messages.organizationsRequired'));
        if (scopes.length === 0) return void toast.error(t('messages.scopesRequired'));
        const integrationKind: IntegrationKind = preset === 'ever-gauzy' ? 'ever-gauzy' : 'generic';
        startTransition(async () => {
            const expiresAt = expirationDays
                ? new Date(Date.now() + Number(expirationDays) * 86_400_000).toISOString()
                : undefined;
            const result = await createIntegrationKey({
                name: name.trim(),
                description: description.trim() || undefined,
                integrationKind,
                scopes,
                organizationIds: orgIds,
                expiresAt,
            });
            if (result.success && result.data) {
                const { key, ...summary } = result.data;
                setSecret(key);
                setKeys((prev) => [summary, ...prev]);
                toast.success(t('messages.createSuccess'));
            } else {
                toast.error(result.error || t('messages.createError'));
            }
        });
    };

    const handleRotate = () => {
        if (!rotateTarget) return;
        const target = rotateTarget;
        startTransition(async () => {
            const result = await rotateApiKey(target.id, Number(graceHours));
            if (result.success && result.data) {
                const rotated = result.data;
                setRotatedSecret(rotated.key);
                setKeys((prev) =>
                    prev.map((key) =>
                        key.id === target.id
                            ? {
                                  ...key,
                                  prefix: rotated.prefix,
                                  rotatedAt: rotated.rotatedAt,
                                  // U10: "None" stopped the old secret at once.
                                  previousKeyGraceUntil:
                                      Number(graceHours) > 0 ? rotated.previousKeyGraceUntil : null,
                              }
                            : key,
                    ),
                );
                setRenderedAt(Date.now());
                toast.success(t('messages.rotateSuccess'));
            } else {
                toast.error(result.error || t('messages.rotateError'));
            }
        });
    };

    const closeRotate = () => {
        // A rotation in flight replaces the working secret (with no grace period,
        // at once): closing now would hide the only copy of the new one.
        if (isPending) return;
        setRotateTarget(null);
        setRotatedSecret(null);
        setGraceHours('24');
        setCopied(false);
    };

    const handleRevoke = () => {
        if (!revokeTarget) return;
        const targetId = revokeTarget.id;
        startTransition(async () => {
            const result = await revokeApiKey(targetId);
            if (result.success) {
                setKeys((prev) => prev.filter((key) => key.id !== targetId));
                setRevokeTarget(null);
                toast.success(t('messages.revokeSuccess'));
            } else {
                toast.error(result.error || t('messages.revokeError'));
            }
        });
    };

    const secretPanel = (value: string, warning: string) => (
        <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <p className="text-sm text-text dark:text-text-dark">{warning}</p>
            </div>
            <pre
                data-testid="integration-key-secret"
                className="text-xs font-mono bg-surface-secondary dark:bg-surface-secondary-dark p-3 rounded-lg overflow-x-auto break-all whitespace-pre-wrap text-text dark:text-text-dark"
            >
                {value}
            </pre>
            <Button variant="secondary" size="sm" onClick={() => copy(value)} className="w-full">
                <Copy className="w-4 h-4 mr-2" />
                {copied ? t('dialog.copied') : t('dialog.copy')}
            </Button>
        </div>
    );

    return (
        <section className="space-y-4" aria-labelledby="integration-keys-title">
            <div className="flex justify-between items-start gap-4">
                <div>
                    <h3
                        id="integration-keys-title"
                        className="text-lg font-semibold text-text dark:text-text-dark mb-1"
                    >
                        {t('title')}
                    </h3>
                    <p className="text-text-muted dark:text-text-muted-dark text-sm">
                        {t('subtitle')}
                    </p>
                </div>
                <Button
                    onClick={() => setShowCreate(true)}
                    className="text-sm shrink-0"
                    data-testid="new-integration-key"
                >
                    <KeyRound className="w-4 h-4" />
                    {t('create')}
                </Button>
            </div>

            {keys.length === 0 ? (
                <div className="text-center py-8 text-sm text-text-muted dark:text-text-muted-dark border border-dashed border-border dark:border-border-dark rounded-lg">
                    <p>{t('empty')}</p>
                    <p className="mt-1 text-xs">{t('ownerOnly')}</p>
                </div>
            ) : (
                <div className="border border-border dark:border-border-dark rounded-lg overflow-hidden">
                    <table className="w-full" data-testid="integration-keys-table">
                        <thead>
                            <tr className="bg-surface-secondary dark:bg-surface-secondary-dark border-b border-border dark:border-border-dark">
                                {(['name', 'key', 'pins', 'scopes', 'lastUsed'] as const).map(
                                    (column) => (
                                        <th
                                            key={column}
                                            className="text-left px-4 py-3 text-xs font-medium text-text-muted dark:text-text-muted-dark"
                                        >
                                            {t(`columns.${column}`)}
                                        </th>
                                    ),
                                )}
                                <th className="text-right px-4 py-3 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('columns.actions')}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map((key) => (
                                <tr
                                    key={key.id}
                                    className="border-b border-border dark:border-border-dark last:border-b-0 align-top"
                                >
                                    <td className="px-4 py-3 text-xs text-text dark:text-text-dark">
                                        <div className="font-medium">{key.name}</div>
                                        <div className="text-text-muted dark:text-text-muted-dark">
                                            {t(`kinds.${key.integrationKind}`)}
                                            {key.description ? ` — ${key.description}` : ''}
                                        </div>
                                        {key.previousKeyGraceUntil &&
                                        new Date(key.previousKeyGraceUntil).getTime() >
                                            renderedAt ? (
                                            <div className="text-warning mt-1">
                                                {t('graceUntil', {
                                                    date: new Date(
                                                        key.previousKeyGraceUntil,
                                                    ).toLocaleString(),
                                                })}
                                            </div>
                                        ) : null}
                                    </td>
                                    <td className="px-4 py-3">
                                        <code className="text-xs bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 rounded font-mono text-text-muted dark:text-text-muted-dark">
                                            {key.prefix}...
                                        </code>
                                    </td>
                                    <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark">
                                        {(key.organizations.length > 0
                                            ? key.organizations
                                            : key.organizationIds.map(
                                                  (id) =>
                                                      orgById.get(id) ?? {
                                                          id,
                                                          slug: id,
                                                          displayName: id,
                                                      },
                                              )
                                        )
                                            .map((org) => org.displayName)
                                            .join(', ')}
                                    </td>
                                    <td
                                        className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark"
                                        title={key.scopes.join(', ')}
                                    >
                                        {t('scopeCount', { count: key.scopes.length })}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark">
                                        {formatDate(key.lastUsedAt)}
                                    </td>
                                    <td className="px-4 py-3 text-right whitespace-nowrap">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setRotateTarget(key)}
                                            aria-label={`${t('rotate.action')} ${key.name}`}
                                        >
                                            <RefreshCw className="w-4 h-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setRevokeTarget(key)}
                                            className="text-danger hover:text-danger"
                                            aria-label={`${t('revoke.confirm')} ${key.name}`}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Create */}
            {/* Open while the secret is on screen too, whatever closed the form. */}
            {/* Review 2026-10-17 U5: Escape or a click outside never drops a secret on screen
                (it is shown once); only Done / the close button do. */}
            <Dialog
                open={showCreate || secret !== null}
                onOpenChange={() => {
                    if (secret !== null) return;
                    resetCreate();
                }}
            >
                <DialogContent>
                    <DialogClose onClose={resetCreate} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {secret ? t('dialog.keyCreated') : t('dialog.title')}
                        </DialogTitle>
                    </DialogHeader>
                    {secret ? (
                        <>
                            {secretPanel(secret, t('dialog.keyWarning'))}
                            <DialogFooter>
                                <Button onClick={resetCreate}>{t('dialog.done')}</Button>
                            </DialogFooter>
                        </>
                    ) : (
                        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                            <Input
                                label={t('dialog.nameLabel')}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('dialog.namePlaceholder')}
                                maxLength={100}
                            />
                            <Input
                                label={t('dialog.descriptionLabel')}
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                maxLength={500}
                            />

                            <fieldset>
                                <legend className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('dialog.organizationsLabel')}
                                </legend>
                                {organizations.length === 0 ? (
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('dialog.noOrganizations')}
                                    </p>
                                ) : (
                                    <div className="flex flex-wrap gap-2">
                                        {organizations.map((org) => (
                                            <Checkbox
                                                key={org.id}
                                                label={org.displayName}
                                                checked={orgIds.includes(org.id)}
                                                onChange={() =>
                                                    setOrgIds((prev) => toggle(prev, org.id))
                                                }
                                            />
                                        ))}
                                    </div>
                                )}
                                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                    {t('dialog.organizationsHint')}
                                </p>
                            </fieldset>

                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('dialog.presetLabel')}
                                </label>
                                <Select value={preset} onValueChange={choosePreset}>
                                    <option value="ever-gauzy">
                                        {t('dialog.presets.ever-gauzy')}
                                    </option>
                                    <option value="custom">{t('dialog.presets.custom')}</option>
                                </Select>
                                {preset === 'ever-gauzy' ? (
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                        {t('dialog.presetHint')}
                                    </p>
                                ) : null}
                            </div>

                            <fieldset>
                                <legend className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('dialog.scopesLabel')}
                                </legend>
                                <div
                                    className="grid grid-cols-2 gap-1.5"
                                    data-testid="integration-scopes"
                                >
                                    {INTEGRATION_SCOPES.map((scope) => (
                                        <Checkbox
                                            key={scope}
                                            label={scope}
                                            checked={scopes.includes(scope)}
                                            // Ticking an opt-in scope (org:write, email:write) under
                                            // the Ever Gauzy preset keeps the Ever Gauzy kind; only
                                            // the scope set grows.
                                            onChange={() =>
                                                setScopes((prev) => toggle(prev, scope))
                                            }
                                        />
                                    ))}
                                </div>
                            </fieldset>

                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('dialog.expirationLabel')}
                                </label>
                                <Select value={expirationDays} onValueChange={setExpirationDays}>
                                    {EXPIRATION_DAYS.map((days) => (
                                        <option key={days} value={days}>
                                            {days ? `${days} d` : '∞'}
                                        </option>
                                    ))}
                                </Select>
                            </div>

                            <DialogFooter>
                                <Button size="sm" variant="secondary" onClick={resetCreate}>
                                    {t('dialog.cancel')}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleCreate}
                                    loading={isPending}
                                    disabled={organizations.length === 0}
                                >
                                    {t('dialog.createButton')}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Rotate */}
            <Dialog
                open={rotateTarget !== null || rotatedSecret !== null}
                onOpenChange={() => {
                    if (rotatedSecret !== null) return;
                    closeRotate();
                }}
            >
                <DialogContent>
                    <DialogClose onClose={closeRotate} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {rotatedSecret ? t('rotate.rotated') : t('rotate.title')}
                        </DialogTitle>
                    </DialogHeader>
                    {rotatedSecret ? (
                        <>
                            {secretPanel(rotatedSecret, t('rotate.warning'))}
                            <DialogFooter>
                                {/* `closeRotate` ignores a click while the rotation's transition is
                                    still settling; say so instead of swallowing the click. */}
                                <Button onClick={closeRotate} disabled={isPending}>
                                    {t('dialog.done')}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : (
                        <div className="space-y-4">
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('rotate.description', { name: rotateTarget?.name ?? '' })}
                            </p>
                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('rotate.graceLabel')}
                                </label>
                                <Select value={graceHours} onValueChange={setGraceHours}>
                                    {GRACE_HOURS.map((hours) => (
                                        <option key={hours} value={hours}>
                                            {t(`rotate.grace.${hours}`)}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                            <DialogFooter>
                                <Button size="sm" variant="secondary" onClick={closeRotate}>
                                    {t('rotate.cancel')}
                                </Button>
                                <Button size="sm" onClick={handleRotate} loading={isPending}>
                                    {t('rotate.confirm')}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Revoke */}
            <Dialog open={revokeTarget !== null} onOpenChange={() => setRevokeTarget(null)}>
                <DialogContent>
                    <DialogClose onClose={() => setRevokeTarget(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('revoke.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('revoke.description', { name: revokeTarget?.name ?? '' })}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setRevokeTarget(null)}>
                            {t('revoke.cancel')}
                        </Button>
                        <Button variant="danger" onClick={handleRevoke} loading={isPending}>
                            {t('revoke.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
