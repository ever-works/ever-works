'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WorkAppSpecStateDto } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    applyBlueprintAction,
    dismissBlueprintUpgradeAction,
    upgradeBlueprintAction,
    type BlueprintRefusalCode,
} from '@/app/actions/dashboard/app-spec';
import { AppBlueprintUpgradeDialog } from './AppBlueprintUpgradeDialog';
import { safeHttpsUrl } from '@/lib/utils/safe-link';

/**
 * APW-03 T31 (lane aw-blueprints) — the Blueprint card on the App spec settings tab
 * (plan §5.2:621-622, spec §6.2).
 *
 * What the App Work follows (id, version, repository, how it was matched), whether a
 * newer version is out (the hourly notice: `blueprintLatestVersion`, a **Breaking**
 * badge on a `MAJOR` bump, hidden for a dismissed version only), and where the latest
 * apply / upgrade run is: preparing, a pull request with its conflicts listed, nothing
 * to change, or failed.
 *
 * Edit access gets the actions (**Review upgrade**, **Dismiss**, **Apply a Blueprint**);
 * a viewer gets the facts only — never a control the API would refuse (FR-76).
 *
 * The card never decides anything the API decides: the version comparison here only
 * chooses what to SHOW, and every action is the API's to accept or refuse.
 */

export interface AppBlueprintCardProps {
    workId: string;
    state: WorkAppSpecStateDto;
    canEdit: boolean;
    /** Merge an optimistic change into the page's state (the page's poll then follows the run). */
    onStateChange: (patch: Partial<WorkAppSpecStateDto>) => void;
}

interface ParsedVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly pre: string | null;
}

function parseVersion(value: string | null | undefined): ParsedVersion | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        (value ?? '').trim(),
    );
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] ?? null,
    };
}

/** `a` is newer than `b` (semver order; a pre-release sorts before its release). */
export function isNewerVersion(
    a: string | null | undefined,
    b: string | null | undefined,
): boolean {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return false;
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (x[key] !== y[key]) return x[key] > y[key];
    }
    if (x.pre === y.pre) return false;
    if (x.pre === null) return true;
    if (y.pre === null) return false;
    return x.pre > y.pre;
}

/** The upgrade notice the card shows, or `null` (none, dismissed, or already proposed). */
export function blueprintUpgradeNotice(
    state: WorkAppSpecStateDto,
): { version: string; breaking: boolean } | null {
    const latest = state.blueprintLatestVersion;
    const current = state.blueprintVersion;
    if (!state.blueprintId || !latest || !current) return null;
    if (!isNewerVersion(latest, current)) return null;
    if (state.blueprintUpgradeDismissedVersion === latest) return null;
    if (
        state.blueprintUpgradeStatus === 'proposed' &&
        state.blueprintUpgradePr?.version === latest
    ) {
        return null;
    }
    const from = parseVersion(current);
    const to = parseVersion(latest);
    return { version: latest, breaking: Boolean(from && to && to.major > from.major) };
}

/** A run is queued or running — the page keeps polling while this holds. */
export function blueprintRunActive(
    state: Pick<WorkAppSpecStateDto, 'blueprintUpgradeStatus'>,
): boolean {
    return state.blueprintUpgradeStatus === 'queued' || state.blueprintUpgradeStatus === 'running';
}

const BLUEPRINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

type DialogState =
    | { variant: 'apply'; blueprintId: string }
    | { variant: 'upgrade'; version: string; breaking: boolean }
    | null;

export function AppBlueprintCard({ workId, state, canEdit, onStateChange }: AppBlueprintCardProps) {
    const t = useTranslations('dashboard.workDetail.settings.appSpec.blueprint');
    const inputId = useId();
    const [dialog, setDialog] = useState<DialogState>(null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<BlueprintRefusalCode | null>(null);
    const [chosenId, setChosenId] = useState('');

    const notice = blueprintUpgradeNotice(state);
    const proposal = state.blueprintUpgradePr;
    const runStatus = state.blueprintUpgradeStatus ?? null;
    const running = blueprintRunActive(state);

    // Message leaves are camelCase (plan §8), so the API's `not_found` reads `notFound`.
    const refusalText = (code: BlueprintRefusalCode) => {
        const leaf = code === 'not_found' ? 'notFound' : code;
        return t.has(`refusal.${leaf}`) ? t(`refusal.${leaf}`) : t('refusal.unknown');
    };

    const onConfirm = async () => {
        if (!dialog) return;
        setBusy(true);
        setRefusal(null);
        try {
            const result =
                dialog.variant === 'apply'
                    ? await applyBlueprintAction(workId, dialog.blueprintId)
                    : await upgradeBlueprintAction(workId, dialog.version);
            if (!result.success) {
                setRefusal(result.code);
                return;
            }
            setDialog(null);
            if (result.data.status === 'existing' && result.data.pullRequest) {
                onStateChange({
                    blueprintUpgradeStatus: 'proposed',
                    blueprintUpgradePr: result.data.pullRequest,
                });
                return;
            }
            onStateChange({
                blueprintUpgradeStatus: 'queued',
                blueprintUpgradeError: null,
                ...(dialog.variant === 'apply'
                    ? {
                          blueprintId: result.data.blueprintId,
                          blueprintApplyStatus: 'applying' as const,
                      }
                    : {}),
            });
        } finally {
            setBusy(false);
        }
    };

    const onDismiss = async (version: string) => {
        setBusy(true);
        setRefusal(null);
        try {
            const result = await dismissBlueprintUpgradeAction(workId, version);
            if (!result.success) {
                setRefusal(result.code);
                return;
            }
            onStateChange({ blueprintUpgradeDismissedVersion: result.data.version });
        } finally {
            setBusy(false);
        }
    };

    const matchChip = state.blueprintMatchSource
        ? t.has(`match.${state.blueprintMatchSource}`)
            ? t(`match.${state.blueprintMatchSource}`)
            : null
        : null;

    return (
        <section
            data-testid="app-blueprint-card"
            aria-labelledby={`${inputId}-title`}
            className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
        >
            <h2 id={`${inputId}-title`} className="text-base font-semibold">
                {t('title')}
            </h2>

            {state.blueprintId ? (
                <div className="mt-2 space-y-1 text-sm" data-testid="app-blueprint-current">
                    <p>
                        {t('follows', {
                            id: state.blueprintId,
                            version: state.blueprintVersion ?? '—',
                        })}
                        {matchChip && (
                            <span
                                data-testid="app-blueprint-match"
                                className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800"
                            >
                                {matchChip}
                            </span>
                        )}
                    </p>
                    {state.blueprintRepo && (
                        <p>
                            <a
                                href={`https://github.com/${state.blueprintRepo}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-600 underline dark:text-blue-400"
                            >
                                {state.blueprintRepo}
                            </a>
                        </p>
                    )}
                    {state.blueprintApplyStatus === 'failed' && state.blueprintApplyError && (
                        <p
                            className="text-red-600 dark:text-red-400"
                            data-testid="app-blueprint-apply-failed"
                        >
                            {t('applyFailed', { code: state.blueprintApplyError })}
                        </p>
                    )}
                </div>
            ) : (
                <div className="mt-2 space-y-2 text-sm" data-testid="app-blueprint-none">
                    <p>{t('none')}</p>
                    {canEdit && (
                        <form
                            className="flex flex-wrap items-end gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                const id = chosenId.trim().toLowerCase();
                                if (BLUEPRINT_ID_PATTERN.test(id))
                                    setDialog({ variant: 'apply', blueprintId: id });
                            }}
                        >
                            <label htmlFor={inputId} className="flex flex-col gap-1">
                                <span>{t('applyLabel')}</span>
                                <input
                                    id={inputId}
                                    data-testid="app-blueprint-apply-id"
                                    value={chosenId}
                                    onChange={(event) => setChosenId(event.target.value)}
                                    placeholder="umami"
                                    className="rounded-md border border-gray-300 px-2 py-1 dark:border-gray-700 dark:bg-gray-900"
                                />
                            </label>
                            <Button
                                type="submit"
                                size="sm"
                                disabled={
                                    busy ||
                                    running ||
                                    !BLUEPRINT_ID_PATTERN.test(chosenId.trim().toLowerCase())
                                }
                                data-testid="app-blueprint-apply"
                            >
                                {t('apply')}
                            </Button>
                        </form>
                    )}
                </div>
            )}

            {notice && (
                <div
                    data-testid="app-blueprint-notice"
                    className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-blue-50 p-3 text-sm dark:bg-blue-950"
                >
                    <span>{t('upgradeAvailable', { version: notice.version })}</span>
                    {notice.breaking && (
                        <span
                            data-testid="app-blueprint-breaking"
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
                        >
                            {t('breaking')}
                        </span>
                    )}
                    {canEdit && (
                        <span className="ml-auto flex gap-2">
                            <Button
                                size="sm"
                                disabled={busy || running}
                                onClick={() =>
                                    setDialog({
                                        variant: 'upgrade',
                                        version: notice.version,
                                        breaking: notice.breaking,
                                    })
                                }
                                data-testid="app-blueprint-review-upgrade"
                            >
                                {t('reviewUpgrade')}
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() => onDismiss(notice.version)}
                                data-testid="app-blueprint-dismiss"
                            >
                                {t('dismiss')}
                            </Button>
                        </span>
                    )}
                </div>
            )}

            {running && (
                <p className="mt-3 text-sm" data-testid="app-blueprint-run-pending" role="status">
                    {t('runPending')}
                </p>
            )}

            {runStatus === 'proposed' && proposal && (
                <div className="mt-3 space-y-1 text-sm" data-testid="app-blueprint-proposal">
                    <p>
                        <a
                            href={safeHttpsUrl(proposal.url) ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 underline dark:text-blue-400"
                            data-testid="app-blueprint-pr"
                        >
                            {proposal.mode === 'apply'
                                ? t('proposalApply', {
                                      number: proposal.number,
                                      version: proposal.version,
                                  })
                                : t('proposalUpgrade', {
                                      number: proposal.number,
                                      version: proposal.version,
                                  })}
                        </a>
                        {proposal.breaking && (
                            <span className="ml-2 text-xs font-medium">{t('breaking')}</span>
                        )}
                    </p>
                    {proposal.baseKnown === false && <p>{t('baseUnknown')}</p>}
                    {(proposal.conflictCount ?? 0) > 0 ? (
                        <>
                            <p data-testid="app-blueprint-conflict-count">
                                {t('conflicts', { count: proposal.conflictCount ?? 0 })}
                            </p>
                            <ul className="list-disc pl-5" data-testid="app-blueprint-conflicts">
                                {(proposal.conflicts ?? []).map((conflict) => (
                                    <li key={conflict.path}>
                                        <code>{conflict.path}</code>
                                        {conflict.proposed
                                            ? ` — ${t('proposed', { value: conflict.proposed })}`
                                            : ''}
                                    </li>
                                ))}
                            </ul>
                        </>
                    ) : (
                        <p>{t('noConflicts')}</p>
                    )}
                </div>
            )}

            {runStatus === 'unchanged' && (
                <p className="mt-3 text-sm" data-testid="app-blueprint-unchanged">
                    {t('unchanged')}
                </p>
            )}

            {runStatus === 'failed' && (
                <p
                    className="mt-3 text-sm text-red-600 dark:text-red-400"
                    data-testid="app-blueprint-run-failed"
                >
                    {t('runFailed', { code: state.blueprintUpgradeError ?? 'unknown' })}
                </p>
            )}

            {refusal && (
                <p
                    className="mt-3 text-sm text-red-600 dark:text-red-400"
                    data-testid="app-blueprint-refusal"
                    role="alert"
                >
                    {refusalText(refusal)}
                </p>
            )}

            {dialog && (
                <AppBlueprintUpgradeDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setDialog(null);
                    }}
                    variant={dialog.variant}
                    blueprintId={
                        dialog.variant === 'apply' ? dialog.blueprintId : (state.blueprintId ?? '')
                    }
                    version={dialog.variant === 'upgrade' ? dialog.version : null}
                    fromVersion={dialog.variant === 'upgrade' ? state.blueprintVersion : null}
                    breaking={dialog.variant === 'upgrade' ? dialog.breaking : false}
                    busy={busy}
                    onConfirm={onConfirm}
                />
            )}
        </section>
    );
}
