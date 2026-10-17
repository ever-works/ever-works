'use client';

import { useMemo, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AppWindow } from 'lucide-react';
import type {
    AppDeployTargetChoice,
    AppRepositoryMode,
    AppSourceInspectResponse,
    AppSourceReasonCode,
} from '@ever-works/contracts';
import { createWork, inspectAppSourceAction } from '@/app/actions/dashboard/works';
import type { AppSourceErrorDetails } from '@/app/actions/dashboard/works';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
    canonicalRepositoryUrl,
    isCanonicalWorkSlug,
    parseRepositoryUrl,
    slugifyForWork,
} from '@/lib/work-kinds/repository-url';
import {
    appSourceReasonParams,
    formatRepositorySizeKb,
    type AppSourceReasonParams,
} from '@/lib/work-kinds/app-source-reasons';
import { AppSourcePreviewCard, isOwnFork } from './AppSourcePreviewCard';
import { AppModeCards } from './AppModeCards';
import { AppTargetOwnerPicker } from './AppTargetOwnerPicker';
import { AppDeployTargetPicker } from './AppDeployTargetPicker';
import { AppBlueprintPrompts, hasMissingRequiredPrompt } from './AppBlueprintPrompts';
import { AppsCatalogBrowser } from './AppsCatalogBrowser';

export interface AppWorkFormProps {
    /** Git provider plugin id selected in the sidebar (inspect + connection gate). */
    gitProvider?: string;
    /** Seed for the URL field — what the member typed into the composer. */
    initialRepositoryUrl?: string;
    /**
     * A Blueprint picked from the Apps catalog (APW-03). Sent on inspect and on
     * create; when it does not match the repository the API answers
     * `blueprint_mismatch`.
     */
    initialBlueprintId?: string;
}

/** A refusal the form shows: a §6.3 code when we have one, otherwise free text. */
interface FormRefusal {
    code?: AppSourceReasonCode;
    details?: AppSourceErrorDetails;
    message?: string;
}

/** The first owner the member can create in — the caller's own account comes first (FR-9). */
function firstAvailableOwner(preview: AppSourceInspectResponse): string {
    return (
        preview.targetOwners.find((owner) => owner.available)?.login ??
        preview.targetOwners[0]?.login ??
        ''
    );
}

/** Format an ISO `retryAfter` as a local time for the `rate_limited` copy. */
function formatRetryAt(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * APW-01 T22 — the create form for an App Work (spec §6.1–§6.3).
 *
 * Paste a GitHub URL → **Check repository** (click or Enter, never on typing) →
 * the preview: repository facts, license, Blueprint, the three modes with their
 * reasons, the target owner, the Blueprint's prompts, the deploy target and the
 * "let an agent work out how to run it" switch → create.
 *
 * What it submits is always the platform's own answer, never a guess:
 *  - `blueprintId` is the preview's matched Blueprint (or the catalog pick);
 *    changing the URL clears the preview and with it the id (ACC-01-21);
 *  - a non-`none` deploy target sends that target's `providerId` from the
 *    preview — the picker never invents one (FR-34, ACC-01-27);
 *  - `autoProvision` is sent only as `false`, only when the member unticked it
 *    (ACC-01-28); `appEnv` carries the typed prompt answers, write-only.
 *
 * Submitting is single-flight (ACC-01-08): a second click while the first create
 * is in flight does nothing.
 */
export function AppWorkForm({
    gitProvider,
    initialRepositoryUrl,
    initialBlueprintId,
}: AppWorkFormProps) {
    const t = useTranslations('dashboard.workCreation.app');
    const tReason = useTranslations('dashboard.workCreation.app.reasons');
    const router = useRouter();
    const [inspecting, startInspect] = useTransition();
    const [submitting, setSubmitting] = useState(false);
    const inFlight = useRef(false);
    // Each inspect gets a ticket; an answer for a URL the member has since
    // changed is dropped instead of overwriting the cleared preview.
    const inspectTicket = useRef(0);

    const seed =
        initialRepositoryUrl && parseRepositoryUrl(initialRepositoryUrl)
            ? initialRepositoryUrl.trim()
            : '';

    const [tab, setTab] = useState<'paste' | 'catalog'>('paste');
    // The Blueprint chosen in the curated catalog (APW-01 T22): carried on
    // inspect and create until the member types a different URL.
    const [pickedBlueprintId, setPickedBlueprintId] = useState<string | undefined>(undefined);
    const chosenBlueprintId = pickedBlueprintId ?? initialBlueprintId;
    const [repositoryUrl, setRepositoryUrl] = useState(seed);
    const [preview, setPreview] = useState<AppSourceInspectResponse | null>(null);
    const [inspectRefusal, setInspectRefusal] = useState<FormRefusal | null>(null);
    const [createRefusal, setCreateRefusal] = useState<FormRefusal | null>(null);
    const [mode, setMode] = useState<AppRepositoryMode | null>(null);
    const [owner, setOwner] = useState('');
    const [deployTarget, setDeployTarget] = useState<AppDeployTargetChoice>('none');
    const [autoProvision, setAutoProvision] = useState(true);
    const [appEnv, setAppEnv] = useState<Record<string, string>>({});
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [description, setDescription] = useState('');
    const [nameDirty, setNameDirty] = useState(false);
    const [slugDirty, setSlugDirty] = useState(false);
    const [descriptionDirty, setDescriptionDirty] = useState(false);

    const parsed = parseRepositoryUrl(repositoryUrl);
    const urlInvalid = repositoryUrl.trim().length > 0 && !parsed;

    const blueprintMatched = preview?.blueprint.status === 'matched';
    // The id the submit carries: the catalog pick, else the preview's match.
    const blueprintId =
        chosenBlueprintId ||
        (blueprintMatched && preview?.blueprint.id ? preview.blueprint.id : undefined);
    const prompts = blueprintMatched ? (preview?.blueprint.prompts ?? []) : [];
    // The provisioning switch is offered only when no Blueprint applies (spec §6.2).
    const showAutoProvision = Boolean(preview) && !blueprintMatched && !chosenBlueprintId;

    const selectedOwner = preview?.targetOwners.find((entry) => entry.login === owner) ?? null;
    const ownerNeeded = mode === 'fork' || mode === 'private-copy';

    const reasonParams: AppSourceReasonParams = useMemo(
        () =>
            appSourceReasonParams({
                owner: (ownerNeeded ? owner : '') || preview?.repository.owner,
                size: formatRepositorySizeKb(preview?.repository.sizeKb),
                name: preview?.repository.repo,
                fullName: preview?.repository.fullName,
                workName: preview?.existingAppWork?.name,
                time: formatRetryAt(preview?.retryAfter),
            }),
        [preview, owner, ownerNeeded],
    );

    const refusalParams = (refusal: FormRefusal): AppSourceReasonParams =>
        appSourceReasonParams({
            ...reasonParams,
            ...(refusal.details?.owner ? { owner: refusal.details.owner } : {}),
            ...(refusal.details?.fullName ? { fullName: refusal.details.fullName } : {}),
            ...(refusal.details?.workName ? { workName: refusal.details.workName } : {}),
            ...(refusal.details?.retryAfter
                ? { time: formatRetryAt(refusal.details.retryAfter) }
                : {}),
        });

    const refusalText = (refusal: FormRefusal | null): string | null => {
        if (!refusal) return null;
        if (refusal.code) return tReason(refusal.code, refusalParams(refusal));
        return refusal.message || t('createFailed');
    };

    const clearPreview = () => {
        inspectTicket.current += 1;
        setPreview(null);
        setInspectRefusal(null);
        setCreateRefusal(null);
        setMode(null);
        setOwner('');
        setDeployTarget('none');
        setAppEnv({});
    };

    const onUrlChange = (next: string) => {
        setRepositoryUrl(next);
        // Drop any in-flight inspect for the previous URL — even the FIRST one,
        // when there is no preview yet — so a late answer can never become the
        // preview (and the submitted repository) for a URL no longer in the field.
        inspectTicket.current += 1;
        // A different URL is a different repository: the preview, the Blueprint
        // it carried and every choice made against it go (ACC-01-21).
        if (preview || inspectRefusal) clearPreview();
    };

    /**
     * Inspect the URL in the field — or, from a catalog pick, the URL it hands
     * over (state has not caught up with it yet inside the same click).
     */
    const inspect = (urlOverride?: string, blueprintOverride?: string) => {
        const target = urlOverride ?? repositoryUrl;
        if (!parseRepositoryUrl(target) || inspecting) return;
        const ticket = ++inspectTicket.current;
        setInspectRefusal(null);
        setCreateRefusal(null);
        startInspect(async () => {
            const result = await inspectAppSourceAction({
                repositoryUrl: canonicalRepositoryUrl(target) ?? target.trim(),
                ...(gitProvider ? { gitProvider } : {}),
                ...((blueprintOverride ?? chosenBlueprintId)
                    ? { blueprintId: blueprintOverride ?? chosenBlueprintId }
                    : {}),
            });
            if (ticket !== inspectTicket.current) return;
            if (!result.success) {
                setPreview(null);
                setInspectRefusal({
                    code: result.code,
                    details: result.details,
                    message: result.error,
                });
                return;
            }
            const next = result.data;
            setPreview(next);
            setMode(next.defaultMode);
            setOwner(firstAvailableOwner(next));
            setDeployTarget('none');
            setAppEnv({});
            if (!nameDirty) setName(next.repository.repo);
            if (!slugDirty) setSlug(slugifyForWork(next.repository.repo));
            if (!descriptionDirty) setDescription(next.repository.fullName);
        });
    };

    const onUrlKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            inspect();
        }
    };

    const slugInvalid = slug.trim().length > 0 && !isCanonicalWorkSlug(slug);
    const promptsIncomplete = hasMissingRequiredPrompt(prompts, appEnv);
    const modeAvailable = Boolean(mode && preview?.modes[mode]?.available);
    const ownerOk = !ownerNeeded || Boolean(selectedOwner?.available);
    const targetOk =
        deployTarget === 'none' ||
        Boolean(
            preview?.deployTargets[deployTarget]?.available &&
            preview.deployTargets[deployTarget].providerId,
        );
    const canSubmit =
        Boolean(preview) &&
        !submitting &&
        modeAvailable &&
        ownerOk &&
        targetOk &&
        !promptsIncomplete &&
        name.trim().length > 0 &&
        isCanonicalWorkSlug(slug);

    const submit = async () => {
        if (!preview || !mode || !canSubmit || inFlight.current) return;
        inFlight.current = true;
        setSubmitting(true);
        setCreateRefusal(null);
        try {
            const providerId =
                deployTarget === 'none'
                    ? undefined
                    : preview.deployTargets[deployTarget]?.providerId;
            const result = await createWork({
                name: name.trim(),
                slug: slug.trim(),
                description: description.trim() || preview.repository.fullName,
                organization: false,
                gitProvider,
                kind: 'app',
                repositoryUrl: preview.repository.url,
                repositoryMode: mode,
                ...(ownerNeeded ? { targetOwner: owner } : {}),
                ...(blueprintId ? { blueprintId } : {}),
                ...(providerId ? { deployProvider: providerId } : {}),
                ...(showAutoProvision && !autoProvision ? { autoProvision: false } : {}),
                ...(prompts.length > 0 ? { appEnv } : {}),
            });
            if (result.success && result.work) {
                toast.success(t(`success.${mode}`));
                router.push(ROUTES.DASHBOARD_WORK(result.work.id));
                return;
            }
            const refusal: FormRefusal = {
                code: result.code,
                details: result.details,
                message: result.error,
            };
            setCreateRefusal(refusal);
            toast.error(refusalText(refusal) ?? t('createFailed'));
        } catch {
            setCreateRefusal({});
            toast.error(t('createFailed'));
        } finally {
            inFlight.current = false;
            setSubmitting(false);
        }
    };

    const setupNote = (() => {
        if (!preview || !mode) return null;
        if (mode === 'private-copy') return t('privateCopyTradeOff');
        if (mode === 'link')
            return blueprintMatched ? t('linkSetupNoteBlueprint') : t('linkSetupNote');
        // A fork that already exists in the chosen account was not created by
        // this Work, so it gets a setup pull request (FR-19).
        if (selectedOwner?.existingFork) {
            return blueprintMatched
                ? t('existingForkSetupNoteBlueprint')
                : t('existingForkSetupNote');
        }
        return null;
    })();

    const busy = inspecting || submitting;

    return (
        <div className="space-y-6" data-testid="app-work-form">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                    {t('formTitle')}
                </h1>
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    {t('formSubtitle')}
                </p>
            </div>

            <div
                role="tablist"
                className="flex gap-2 border-b border-border dark:border-border-dark"
            >
                {(['paste', 'catalog'] as const).map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={tab === value}
                        onClick={() => setTab(value)}
                        data-testid={`app-work-tab-${value}`}
                        className={cn(
                            'px-3 py-2 text-sm font-medium border-b-2 -mb-px',
                            tab === value
                                ? 'border-primary text-primary dark:border-gray-100 dark:text-text-dark'
                                : 'border-transparent text-text-secondary dark:text-text-secondary-dark',
                        )}
                    >
                        {value === 'paste' ? t('tabPaste') : t('tabCatalog')}
                    </button>
                ))}
            </div>

            {tab === 'catalog' ? (
                <div data-testid="app-work-catalog">
                    {/* APW-01 T22 — a pick fills the URL and inspects it exactly once;
                        the Blueprint match comes from inspect, never from the card. */}
                    <AppsCatalogBrowser
                        disabled={busy}
                        onPick={(pick) => {
                            onUrlChange(pick.url);
                            setPickedBlueprintId(pick.blueprintId);
                            setTab('paste');
                            inspect(pick.url, pick.blueprintId);
                        }}
                    />
                </div>
            ) : (
                <div
                    className={cn(
                        'p-6 rounded-lg space-y-5',
                        'bg-card dark:bg-transparent',
                        'border border-card-border dark:border-border-secondary-dark',
                    )}
                >
                    <div className="flex flex-col gap-2 @md/main:flex-row @md/main:items-end">
                        <div className="flex-1">
                            <Input
                                label={`${t('urlLabel')} *`}
                                type="url"
                                name="repositoryUrl"
                                value={repositoryUrl}
                                onChange={(event) => {
                                    // A typed URL is no longer the catalog pick.
                                    setPickedBlueprintId(undefined);
                                    onUrlChange(event.target.value);
                                }}
                                onKeyDown={onUrlKeyDown}
                                placeholder={t('urlPlaceholder')}
                                helperText={t('urlHelp')}
                                error={
                                    urlInvalid ? tReason('invalid_url', reasonParams) : undefined
                                }
                                variant="form"
                                autoFocus
                                data-testid="app-work-url"
                            />
                        </div>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => inspect()}
                            disabled={!parsed || busy}
                            loading={inspecting}
                            data-testid="app-work-check"
                        >
                            {inspecting ? t('checking') : t('checkButton')}
                        </Button>
                    </div>

                    {inspectRefusal && (
                        <p
                            role="alert"
                            className="text-sm text-red-600 dark:text-red-400"
                            data-testid="app-work-inspect-error"
                        >
                            {refusalText(inspectRefusal)}
                        </p>
                    )}

                    {preview && (
                        <>
                            <AppSourcePreviewCard preview={preview} />
                            {preview.repository.visibility === 'public' && mode === 'fork' && (
                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                    ⓘ {t('publicForkNote')}
                                </p>
                            )}

                            <AppModeCards
                                modes={preview.modes}
                                value={mode}
                                onChange={setMode}
                                reasonParams={reasonParams}
                                ownFork={isOwnFork(preview)}
                                disabled={submitting}
                            />

                            {ownerNeeded && (
                                <AppTargetOwnerPicker
                                    owners={preview.targetOwners}
                                    value={owner}
                                    onChange={setOwner}
                                    mode={mode as 'fork' | 'private-copy'}
                                    reasonParams={reasonParams}
                                    disabled={submitting}
                                />
                            )}

                            {setupNote && (
                                <p
                                    className="text-sm text-text-secondary dark:text-text-secondary-dark"
                                    data-testid="app-work-setup-note"
                                >
                                    {setupNote}
                                </p>
                            )}

                            {prompts.length > 0 && (
                                <AppBlueprintPrompts
                                    blueprintName={
                                        preview.blueprint.name ?? preview.blueprint.id ?? ''
                                    }
                                    prompts={prompts}
                                    values={appEnv}
                                    onChange={(key, value) =>
                                        setAppEnv((prev) => ({ ...prev, [key]: value }))
                                    }
                                    disabled={submitting}
                                />
                            )}

                            <AppDeployTargetPicker
                                targets={preview.deployTargets}
                                value={deployTarget}
                                onChange={setDeployTarget}
                                reasonParams={reasonParams}
                                disabled={submitting}
                            />

                            {showAutoProvision && (
                                <label className="flex items-start gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={autoProvision}
                                        onChange={(event) => setAutoProvision(event.target.checked)}
                                        disabled={submitting}
                                        data-testid="app-work-auto-provision"
                                        className="mt-1"
                                    />
                                    <span>
                                        <span className="block font-medium text-text dark:text-text-dark">
                                            {t('autoProvision')}
                                        </span>
                                        <span className="block text-xs text-text-secondary dark:text-text-secondary-dark">
                                            {t('autoProvisionHelp')}
                                        </span>
                                    </span>
                                </label>
                            )}

                            <div className="grid gap-4 @lg/main:grid-cols-2">
                                <Input
                                    label={`${t('nameLabel')} *`}
                                    type="text"
                                    name="name"
                                    value={name}
                                    onChange={(event) => {
                                        setName(event.target.value);
                                        setNameDirty(true);
                                        if (!slugDirty) setSlug(slugifyForWork(event.target.value));
                                    }}
                                    variant="form"
                                    data-testid="app-work-name"
                                />
                                <Input
                                    label={`${t('slugLabel')} *`}
                                    type="text"
                                    name="slug"
                                    value={slug}
                                    onChange={(event) => {
                                        setSlug(event.target.value);
                                        setSlugDirty(true);
                                    }}
                                    error={slugInvalid ? t('invalidSlug') : undefined}
                                    helperText={t('slugHelp')}
                                    variant="form"
                                    data-testid="app-work-slug"
                                />
                            </div>
                            <Textarea
                                label={t('descriptionLabel')}
                                name="description"
                                value={description}
                                onChange={(event) => {
                                    setDescription(event.target.value);
                                    setDescriptionDirty(true);
                                }}
                                rows={2}
                                variant="form"
                            />
                        </>
                    )}
                </div>
            )}

            {createRefusal && (
                <p
                    role="alert"
                    className="text-sm text-red-600 dark:text-red-400"
                    data-testid="app-work-create-error"
                >
                    {refusalText(createRefusal)}
                </p>
            )}
            {preview && promptsIncomplete && (
                <p
                    className="text-sm text-text-secondary dark:text-text-secondary-dark"
                    data-testid="app-work-prompts-incomplete"
                >
                    {t('promptsIncomplete')}
                </p>
            )}

            <div className="flex gap-3">
                <Button
                    onClick={submit}
                    disabled={!canSubmit}
                    loading={submitting}
                    variant="primary"
                    size="lg"
                    fullWidth
                    data-testid="app-work-submit"
                >
                    {submitting ? (
                        t('submitPending')
                    ) : (
                        <>
                            <AppWindow className="w-5 h-5" />
                            {t(`submit.${mode ?? 'fork'}`)}
                        </>
                    )}
                </Button>
                <Button
                    onClick={() => router.back()}
                    disabled={submitting}
                    variant="secondary"
                    size="lg"
                    className="px-6"
                >
                    {t('cancel')}
                </Button>
            </div>
        </div>
    );
}
