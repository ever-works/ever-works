'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Copy } from 'lucide-react';
import {
    FLEET_ACTIONS_RUNNER_MAX_LABELS,
    FLEET_ACTIONS_RUNNER_SHARE_DOCKER_LABEL,
    FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
    fleetActionsRunnerInstallSummary,
    type FleetActionsRunnerInstallResponse,
    type FleetActionsRunnerMode,
    type FleetActionsRunnerOptionsView,
    type FleetActionsRunnersPermissionView,
    type FleetLinkError,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    fleetActionsRunnerOptionsAction,
    fleetActionsRunnersPermissionAction,
    installFleetActionsRunnersAction,
} from '@/app/actions/fleet/runners';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { rootRequiredFrom } from '../machine/machine-actions.shared';
import { GrantAccessCard } from './GrantAccessCard';
import {
    clampInstallCount,
    defaultRunnerNames,
    defaultTarget,
    groupTargets,
    installRequestFrom,
    isWindowsOs,
    namesForCount,
    namesProblem,
    parseExtraLabels,
    runnerModesFor,
    runnersThatFit,
    targetFromKey,
    targetKey,
    type RunnerInstallForm,
} from './runners.shared';

const FIELD =
    'h-8 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm';

const EMPTY_FORM: RunnerInstallForm = {
    targetKey: '',
    count: 1,
    names: [],
    labelsText: '',
    mode: 'service',
};

/**
 * The names new slots take, in order: the server's suggestions (`<computer>-<n>`
 * for every runner that still fits), then the same rule computed here over the
 * names the computer already has — so a slot never stays empty.
 */
function namePool(
    options: FleetActionsRunnerOptionsView,
    existingNames: readonly string[],
): string[] {
    return [
        ...options.suggestedNames,
        ...defaultRunnerNames(options.nodeName, FLEET_ACTIONS_RUNNERS_MAX_PER_NODE, existingNames),
    ];
}

/** The form once options arrived: a usable target, one runner, its suggested name, the first mode. */
function formFor(
    options: FleetActionsRunnerOptionsView,
    existingNames: readonly string[],
): RunnerInstallForm {
    const target = defaultTarget(options.targets);
    const modes = runnerModesFor(options.os, options.modes);
    return {
        targetKey: target ? targetKey(target) : '',
        count: 1,
        names: namesForCount([], 1, namePool(options, existingNames)),
        labelsText: '',
        mode: modes[0] ?? 'service',
        // P3 (FR-27): never ticked for the person.
        shareDockerDaemon: false,
    };
}

/** A command the person runs once on the machine, with a copy button (U4, U5). */
function CopyableCommand({
    command,
    label,
    copiedLabel,
}: {
    command: string;
    label: string;
    copiedLabel: string;
}) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };
    return (
        <div className="flex items-center gap-2 rounded-md bg-surface-secondary p-2 dark:bg-surface-secondary-dark">
            <code
                className="flex-1 break-all font-mono text-xs"
                data-testid="fleet-runners-install-command"
            >
                {command}
            </code>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={copy}
                aria-label={copied ? copiedLabel : label}
            >
                {copied ? (
                    <Check className="h-4 w-4" aria-hidden />
                ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                )}
            </Button>
        </div>
    );
}

/**
 * Actions runners on computers (FL-18 P1, spec §5.1, FR-2, FR-3, FR-30) —
 * "Install Actions runners on <computer>":
 *
 *  - **Register with** — the repositories and organisations the owner's
 *    GitHub App covers (FR-2); none → "Install the Ever Works GitHub App …
 *    first" with a link to the GitHub App settings; an organisation target
 *    is checked with the API first (P2, FR-26) and, when the App lacks the
 *    permission, shows the **Grant access** card (spec §5.6) instead of
 *    enabling Install — Check again re-asks, Use a repository instead
 *    switches to a repository;
 *  - **How many** — 1 … what still fits of 16 per computer;
 *  - **Names** — prefilled `<computer>-<n>`, editable, unique;
 *  - **Extra labels** — comma-separated, cleaned by the contracts' rule, with
 *    the labels GitHub adds itself shown as fixed chips;
 *  - **Run as** — Service (Windows: the only mode); on a Linux computer that
 *    advertises it, **Container-isolated** (P3, FR-27) with its labelled,
 *    unticked opt-in to share the host's container daemon (runs as root) and a
 *    one-line warning of what that grants;
 *  - the confirmation sentence (target, count, mode, computer, "no credits are
 *    spent", FR-30) — the dialog IS the confirmation: Install sends
 *    `confirm: true`.
 *
 * On 202 the dialog closes and the block re-reads; a refusal shows its hint,
 * and `root_required` the exact command in a copyable block (U4, U5).
 */
export function InstallRunnersDialog({
    open,
    nodeId,
    computer,
    existingNames,
    onClose,
    onInstalled,
}: {
    open: boolean;
    nodeId: string;
    /** The computer's name, until the options name it. */
    computer: string;
    /** The runners already on the computer, so new default names skip them. */
    existingNames: readonly string[];
    onClose: () => void;
    onInstalled?: (installed: FleetActionsRunnerInstallResponse) => void;
}) {
    const t = useTranslations('fleet.runners.install');
    const [options, setOptions] = useState<FleetActionsRunnerOptionsView | null>(null);
    const [form, setForm] = useState<RunnerInstallForm>(EMPTY_FORM);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<FleetLinkError | null>(null);
    const [error, setError] = useState<FleetLinkError | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [pending, startTransition] = useTransition();
    // P2 (FR-26): the App's permission on the organisation picked, asked when one is picked.
    const [permission, setPermission] = useState<FleetActionsRunnersPermissionView | null>(null);
    const [checkingPermission, setCheckingPermission] = useState(false);
    const [permissionKey, setPermissionKey] = useState(0);
    // Read when the options arrive, without re-reading them each time the list refreshes.
    const existingNamesRef = useRef(existingNames);
    existingNamesRef.current = existingNames;

    // The options, once per opening (and on "Check again").
    useEffect(() => {
        if (!open) return;
        let live = true;
        setLoading(true);
        setLoadError(null);
        setError(null);
        void fleetActionsRunnerOptionsAction(nodeId).then((result) => {
            if (!live) return;
            setLoading(false);
            if (result.ok) {
                setOptions(result.data);
                setForm(formFor(result.data, existingNamesRef.current));
            } else {
                setOptions(null);
                setLoadError(result.error);
            }
        });
        return () => {
            live = false;
        };
    }, [open, nodeId, reloadKey]);

    const name = options?.nodeName ?? computer;
    const fit = options ? runnersThatFit(options) : 0;
    const modes = useMemo(
        () => (options ? runnerModesFor(options.os, options.modes) : []),
        [options],
    );
    const groups = useMemo(() => groupTargets(options?.targets ?? []), [options]);
    const target = options ? targetFromKey(form.targetKey, options.targets) : null;
    const orgToCheck = open && target?.scope === 'org' ? target.target : null;

    // Ask whether the GitHub App may register runners at the organisation picked (FR-26).
    useEffect(() => {
        if (!orgToCheck) return;
        let live = true;
        setCheckingPermission(true);
        void Promise.resolve(fleetActionsRunnersPermissionAction('org', orgToCheck))
            .then((result) => {
                if (!live) return;
                setPermission(result && result.ok ? result.data : null);
            })
            .catch(() => {
                if (live) setPermission(null);
            })
            .finally(() => {
                if (live) setCheckingPermission(false);
            });
        return () => {
            live = false;
        };
    }, [orgToCheck, permissionKey]);
    const labels = parseExtraLabels(form.labelsText, options?.defaultLabels ?? []);
    const names = form.names.slice(0, form.count);
    const nameIssue = namesProblem(names);
    const noApp = Boolean(options && !options.appInstalled);
    const noTargets = Boolean(options && options.appInstalled && options.targets.length === 0);
    // A fresh answer for THIS organisation wins over what the options said when they were read.
    const checked =
        target?.scope === 'org' &&
        permission &&
        permission.target.toLowerCase() === target.target.toLowerCase()
            ? permission
            : null;
    const permissionMissing = checked ? !checked.ok : target?.permission === 'missing';
    const awaitingPermission = target?.scope === 'org' && checkingPermission && !checked;
    const root = rootRequiredFrom(error);
    const canInstall = Boolean(
        options &&
        options.canHost &&
        fit > 0 &&
        target &&
        !permissionMissing &&
        !awaitingPermission &&
        modes.includes(form.mode) &&
        names.length === form.count &&
        !nameIssue &&
        !labels.invalid &&
        !labels.tooMany &&
        !pending &&
        !loading,
    );

    const sentence =
        options && target
            ? fleetActionsRunnerInstallSummary({
                  count: form.count,
                  target: target.target,
                  mode: form.mode,
                  computer: name,
              })
            : null;

    const setCount = (value: unknown) =>
        setForm((previous) => {
            const count = clampInstallCount(value, fit);
            const pool = options ? namePool(options, existingNames) : [];
            return { ...previous, count, names: namesForCount(previous.names, count, pool) };
        });

    const setName = (index: number, value: string) =>
        setForm((previous) => {
            const next = [...previous.names];
            next[index] = value;
            return { ...previous, names: next };
        });

    const install = () => {
        if (!canInstall || !target) return;
        setError(null);
        startTransition(async () => {
            const result = await installFleetActionsRunnersAction(
                nodeId,
                installRequestFrom(form, target, labels.labels),
            );
            if (result.ok) {
                toast.success(t('started', { count: form.count }));
                onInstalled?.(result.data);
                onClose();
                return;
            }
            setError(result.error);
        });
    };

    const modeLabel = (mode: FleetActionsRunnerMode) =>
        mode === 'docker'
            ? t('modes.docker')
            : isWindowsOs(options?.os)
              ? t('modes.serviceWindows')
              : t('modes.service');

    const grantUrl =
        checked?.grantUrl ??
        (target?.permission === 'missing' ? target.grantUrl : null) ??
        (error && typeof error.details?.grantUrl === 'string'
            ? (error.details.grantUrl as string)
            : null);

    return (
        <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
            <DialogContent className="max-w-xl" data-testid="fleet-runners-install-dialog">
                <DialogHeader>
                    <DialogTitle>{t('title', { name })}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {loading && !options ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark" role="status">
                        {t('loading')}
                    </p>
                ) : null}

                {options && !options.canHost ? (
                    <div
                        className="flex flex-col gap-2 text-sm"
                        role="alert"
                        data-testid="fleet-runners-install-cannot"
                    >
                        <p>{t('cannotHost', { name })}</p>
                        {options.hint ? (
                            <p className="text-text-muted dark:text-text-muted-dark">
                                {options.hint}
                            </p>
                        ) : null}
                    </div>
                ) : null}

                {noApp ? (
                    <div
                        className="flex flex-col gap-2 text-sm"
                        data-testid="fleet-runners-install-no-app"
                    >
                        <p>{t('noApp')}</p>
                        <Link
                            href={ROUTES.DASHBOARD_SETTINGS_GITHUB_APP}
                            className="text-primary underline"
                        >
                            {t('openAppSettings')}
                        </Link>
                    </div>
                ) : null}

                {noTargets ? (
                    <div
                        className="flex flex-col gap-2 text-sm"
                        data-testid="fleet-runners-install-no-targets"
                    >
                        <p>{t('noTargets')}</p>
                        <Link
                            href={ROUTES.DASHBOARD_SETTINGS_GITHUB_APP}
                            className="text-primary underline"
                        >
                            {t('openAppSettings')}
                        </Link>
                    </div>
                ) : null}

                {options && options.canHost && !noApp && !noTargets ? (
                    <div className="flex flex-col gap-3 text-sm">
                        <label className="flex flex-col gap-1">
                            <span className="font-medium">{t('target')}</span>
                            <select
                                className={FIELD}
                                value={form.targetKey}
                                onChange={(event) =>
                                    setForm((previous) => ({
                                        ...previous,
                                        targetKey: event.target.value,
                                    }))
                                }
                                data-testid="fleet-runners-install-target"
                            >
                                {form.targetKey === '' ? (
                                    <option value="" disabled>
                                        {t('choose')}
                                    </option>
                                ) : null}
                                {groups.repo.length > 0 ? (
                                    <optgroup label={t('repositories')}>
                                        {groups.repo.map((entry) => (
                                            <option key={targetKey(entry)} value={targetKey(entry)}>
                                                {entry.target}
                                            </option>
                                        ))}
                                    </optgroup>
                                ) : null}
                                {groups.org.length > 0 ? (
                                    <optgroup label={t('organisations')}>
                                        {groups.org.map((entry) => (
                                            <option key={targetKey(entry)} value={targetKey(entry)}>
                                                {entry.target}
                                            </option>
                                        ))}
                                    </optgroup>
                                ) : null}
                            </select>
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('targetHint')}
                            </span>
                        </label>

                        {permissionMissing && target ? (
                            <GrantAccessCard
                                account={target.accountLogin || target.target}
                                permission={checked?.missing ?? null}
                                grantUrl={grantUrl}
                                checking={checkingPermission}
                                onCheckAgain={() =>
                                    target.scope === 'org'
                                        ? setPermissionKey((key) => key + 1)
                                        : setReloadKey((key) => key + 1)
                                }
                                onUseRepository={() =>
                                    setForm((previous) => {
                                        const repo = options ? defaultTarget(groups.repo) : null;
                                        return {
                                            ...previous,
                                            targetKey: repo ? targetKey(repo) : '',
                                        };
                                    })
                                }
                                testId="fleet-runners-install-permission"
                            />
                        ) : awaitingPermission && target ? (
                            <p
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                                role="status"
                                data-testid="fleet-runners-install-checking"
                            >
                                {t('checkingPermission', { target: target.target })}
                            </p>
                        ) : null}

                        <label className="flex flex-col gap-1">
                            <span className="font-medium">{t('count')}</span>
                            <span className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min={1}
                                    max={Math.max(1, fit)}
                                    className={`${FIELD} w-20`}
                                    value={form.count}
                                    onChange={(event) => setCount(event.target.value)}
                                    data-testid="fleet-runners-install-count"
                                />
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('countHint', { max: fit })}
                                </span>
                            </span>
                        </label>

                        <fieldset className="flex flex-col gap-1">
                            <legend className="font-medium">{t('names')}</legend>
                            <div className="flex flex-wrap gap-2">
                                {names.map((value, index) => (
                                    <input
                                        key={index}
                                        className={`${FIELD} w-40`}
                                        value={value}
                                        onChange={(event) => setName(index, event.target.value)}
                                        aria-label={t('nameLabel', { n: index + 1 })}
                                        aria-invalid={nameIssue?.index === index}
                                        maxLength={64}
                                        spellCheck={false}
                                        autoComplete="off"
                                        data-testid={`fleet-runners-install-name-${index}`}
                                    />
                                ))}
                            </div>
                            {nameIssue ? (
                                <span className="text-xs text-danger">
                                    {nameIssue.kind === 'duplicate'
                                        ? t('nameDuplicate')
                                        : t('nameInvalid')}
                                </span>
                            ) : null}
                        </fieldset>

                        <label className="flex flex-col gap-1">
                            <span className="font-medium">{t('labels')}</span>
                            <input
                                className={FIELD}
                                value={form.labelsText}
                                onChange={(event) =>
                                    setForm((previous) => ({
                                        ...previous,
                                        labelsText: event.target.value,
                                    }))
                                }
                                placeholder={t('labelsPlaceholder')}
                                aria-invalid={Boolean(labels.invalid) || labels.tooMany}
                                spellCheck={false}
                                autoComplete="off"
                                data-testid="fleet-runners-install-labels"
                            />
                            <span className="flex flex-wrap items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('labelsAdded')}
                                {options.defaultLabels.map((label) => (
                                    <span
                                        key={label}
                                        className="rounded bg-surface-secondary px-1.5 py-0.5 dark:bg-surface-secondary-dark"
                                    >
                                        {label}
                                    </span>
                                ))}
                            </span>
                            {labels.invalid ? (
                                <span className="text-xs text-danger">
                                    {t('labelInvalid', { label: labels.invalid })}
                                </span>
                            ) : labels.tooMany ? (
                                <span className="text-xs text-danger">
                                    {t('labelsTooMany', { max: FLEET_ACTIONS_RUNNER_MAX_LABELS })}
                                </span>
                            ) : null}
                        </label>

                        <fieldset className="flex flex-col gap-1">
                            <legend className="font-medium">{t('mode')}</legend>
                            {modes.length === 0 ? (
                                <span className="text-xs text-danger">{t('noModes')}</span>
                            ) : (
                                <div
                                    role="radiogroup"
                                    aria-label={t('mode')}
                                    className="flex flex-col gap-1"
                                >
                                    {modes.map((mode) => (
                                        <label
                                            key={mode}
                                            className="inline-flex items-center gap-2"
                                        >
                                            <input
                                                type="radio"
                                                name="fleet-runners-mode"
                                                value={mode}
                                                checked={form.mode === mode}
                                                onChange={() =>
                                                    setForm((previous) => ({ ...previous, mode }))
                                                }
                                                data-testid={`fleet-runners-install-mode-${mode}`}
                                            />
                                            {modeLabel(mode)}
                                        </label>
                                    ))}
                                </div>
                            )}
                            {form.mode === 'docker' && modes.includes('docker') ? (
                                <div
                                    className="mt-1 flex flex-col gap-1 pl-6"
                                    data-testid="fleet-runners-install-share"
                                >
                                    <label className="inline-flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={form.shareDockerDaemon === true}
                                            onChange={(event) =>
                                                setForm((previous) => ({
                                                    ...previous,
                                                    shareDockerDaemon: event.target.checked,
                                                }))
                                            }
                                            data-testid="fleet-runners-install-share-daemon"
                                        />
                                        {FLEET_ACTIONS_RUNNER_SHARE_DOCKER_LABEL}
                                    </label>
                                    <span className="text-xs text-warning">
                                        {t('shareWarning', { name })}
                                    </span>
                                </div>
                            ) : null}
                        </fieldset>

                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('assurance')}
                        </p>
                        {sentence ? (
                            <p
                                className="rounded-md bg-surface-secondary p-2 text-xs dark:bg-surface-secondary-dark"
                                data-testid="fleet-runners-install-summary"
                            >
                                {sentence}
                            </p>
                        ) : null}
                    </div>
                ) : null}

                {loadError ? (
                    <p className="text-sm text-danger" role="alert">
                        {loadError.hint || t('loadFailed')}
                    </p>
                ) : null}
                {root ? (
                    <div
                        className="flex flex-col gap-2 text-sm"
                        role="alert"
                        data-testid="fleet-runners-install-root"
                    >
                        <p>{t('rootRequired', { name })}</p>
                        <CopyableCommand
                            command={root.command}
                            label={t('copy')}
                            copiedLabel={t('copied')}
                        />
                    </div>
                ) : error ? (
                    <p
                        className="text-sm text-danger"
                        role="alert"
                        data-testid="fleet-runners-install-error"
                    >
                        {error.hint || t('failed')}
                    </p>
                ) : null}

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t('cancel')}
                    </Button>
                    {options && options.canHost && !noApp && !noTargets ? (
                        <Button
                            type="button"
                            onClick={install}
                            disabled={!canInstall}
                            loading={pending}
                            data-testid="fleet-runners-install-submit"
                        >
                            {t('submit', { count: form.count })}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
