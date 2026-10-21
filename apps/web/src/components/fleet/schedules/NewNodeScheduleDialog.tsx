'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_SCHEDULE_NAME_MAX_LENGTH,
    type FleetNodeView,
    type FleetScheduleConfirmationDetails,
    type FleetScheduleUpdateRequest,
    type FleetScheduleView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { schedulesClient } from './schedules.client';
import {
    cadenceFromDraft,
    DEFAULT_CADENCE_DRAFT,
    draftFromCadence,
    previewFires,
    readScheduleConfirmation,
    viewerTimeZone,
    type CadenceDraft,
} from './schedules.shared';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FORMS: CadenceDraft['form'][] = ['every', 'hourly', 'daily', 'weekdays', 'days', 'cron'];

/**
 * Schedules on computers (FL-13, spec §5.2, S1, FR-5 … FR-10, FR-25) — New
 * schedule (and Edit, Duplicate, Move): a name, the computer, the command and
 * its folder, and When — six forms, with the next three fires previewed on the
 * computer's clock and the viewer's. Saving asks the platform first; its 409
 * `confirmation_required` summary (the shell, the user, the folder, the next
 * fires and "These are real machines, not a sandbox.") is shown, and the save
 * repeats with `confirm: true` only when the person confirms it.
 */
export function NewNodeScheduleDialog({
    node,
    nodes,
    initial,
    mode,
    prefill,
    onSaved,
    onClose,
}: {
    node: FleetNodeView;
    /** Computers it may go on (for Move); the tab's own computer at least. */
    nodes: FleetNodeView[];
    initial?: FleetScheduleView | null;
    mode: 'create' | 'edit' | 'duplicate';
    /** "Schedule this…" from the Commands tab (spec §5.5). */
    prefill?: { command?: string; cwd?: string } | null;
    onSaved: (schedule: FleetScheduleView) => void;
    onClose: () => void;
}) {
    const t = useTranslations('fleet.schedules.dialog');
    const tc = useTranslations('fleet.schedules.cadence');
    const [name, setName] = useState(
        initial ? (mode === 'duplicate' ? t('copyOf', { name: initial.name }) : initial.name) : '',
    );
    const [nodeId, setNodeId] = useState(initial?.nodeId || node.id);
    const [command, setCommand] = useState(initial?.command ?? prefill?.command ?? '');
    const [cwd, setCwd] = useState(initial?.cwd ?? prefill?.cwd ?? '');
    const [draft, setDraft] = useState<CadenceDraft>(initial ? draftFromCadence(initial.cadence) : DEFAULT_CADENCE_DRAFT);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<FleetScheduleConfirmationDetails | null>(null);

    const target = nodes.find((candidate) => candidate.id === nodeId) ?? node;
    const viewerZone = useMemo(() => viewerTimeZone(), []);
    const computerZone = target.timeZone ?? null;
    const built = cadenceFromDraft(draft);
    const preview = previewFires(built.cadence, computerZone, viewerZone, Date.now());
    const ready = name.trim().length > 0 && command.trim().length > 0 && built.cadence !== null;
    const patch = (next: Partial<CadenceDraft>) => setDraft((current) => ({ ...current, ...next }));

    const save = async (confirm: boolean) => {
        if (!ready || !built.cadence) return;
        setBusy(true);
        setError(null);
        const cadence = built.cadence as unknown as Record<string, unknown>;
        const result =
            mode === 'edit' && initial
                ? await schedulesClient.update(initial.id, {
                      name: name.trim(),
                      ...(nodeId !== initial.nodeId ? { nodeId } : {}),
                      command,
                      cwd: cwd.trim() ? cwd.trim() : null,
                      cadence,
                      ...(confirm ? { confirm: true } : {}),
                  } satisfies FleetScheduleUpdateRequest)
                : await schedulesClient.create({
                      name: name.trim(),
                      nodeId,
                      command,
                      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
                      cadence,
                      ...(confirm ? { confirm: true } : {}),
                  });
        setBusy(false);
        if (result.ok) {
            onSaved(result.data);
            onClose();
            return;
        }
        if (result.error.code === 'confirmation_required') {
            const details = readScheduleConfirmation(result.error.details);
            if (details) {
                setConfirmation(details);
                return;
            }
        }
        setError(result.error.hint ?? t('failed'));
    };

    const title = mode === 'edit' ? t('editTitle', { computer: target.name }) : t('title', { computer: target.name });

    return (
        <div
            role="dialog"
            aria-label={title}
            className="space-y-3 rounded-lg border border-border p-4 text-sm dark:border-border-dark"
            data-testid="fleet-new-schedule"
        >
            <h3 className="font-medium">{title}</h3>
            {confirmation ? (
                <div className="space-y-2" data-testid="fleet-schedule-confirm">
                    <p className="font-medium">{t(`confirm.${confirmation.action}`, { name: confirmation.name, computer: confirmation.nodeName })}</p>
                    <pre className="whitespace-pre-wrap rounded bg-surface-secondary px-2 py-1 font-mono text-xs dark:bg-surface-secondary-dark">
                        {confirmation.command}
                    </pre>
                    <p className="text-xs">
                        {t('confirmRunsAs', { shell: confirmation.shell, folder: confirmation.folder })}
                    </p>
                    <p className="text-xs">{t('confirmWhen', { cadence: confirmation.cadenceHuman })}</p>
                    <p className="text-xs font-medium text-warning">⚠ {t('sandbox')}</p>
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setConfirmation(null)} disabled={busy}>
                            {t('back')}
                        </Button>
                        <Button size="sm" onClick={() => void save(true)} disabled={busy} data-testid="fleet-schedule-confirm-yes">
                            {mode === 'edit' ? t('saveConfirmed') : t('createConfirmed')}
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs">{t('name')}</span>
                        <input
                            className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                            value={name}
                            maxLength={FLEET_SCHEDULE_NAME_MAX_LENGTH}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t('namePlaceholder')}
                            data-testid="fleet-schedule-name"
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs">{t('computer')}</span>
                        <select
                            className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                            value={nodeId}
                            onChange={(event) => setNodeId(event.target.value)}
                            data-testid="fleet-schedule-computer"
                        >
                            {nodes.map((candidate) => (
                                <option key={candidate.id} value={candidate.id} disabled={candidate.kind !== 'node'}>
                                    {candidate.name}
                                    {candidate.kind !== 'node' ? ` — ${t('notThisKind')}` : ''}
                                </option>
                            ))}
                        </select>
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {computerZone ? t('keepsTime', { zone: computerZone }) : t('keepsUtc')}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs">{t('command')}</span>
                        <textarea
                            className="min-h-[3rem] rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                            value={command}
                            onChange={(event) => setCommand(event.target.value)}
                            placeholder="pnpm test"
                            data-testid="fleet-schedule-command"
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs">{t('folder')}</span>
                        <input
                            className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                            value={cwd}
                            onChange={(event) => setCwd(event.target.value)}
                            placeholder={t('folderPlaceholder')}
                            data-testid="fleet-schedule-folder"
                        />
                    </label>
                    <fieldset className="space-y-2">
                        <legend className="text-xs">{t('when')}</legend>
                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                                value={draft.form}
                                onChange={(event) => patch({ form: event.target.value as CadenceDraft['form'] })}
                                data-testid="fleet-schedule-form"
                            >
                                {FORMS.map((form) => (
                                    <option key={form} value={form}>
                                        {tc(`forms.${form}`)}
                                    </option>
                                ))}
                            </select>
                            {draft.form === 'every' ? (
                                <label className="inline-flex items-center gap-1">
                                    <input
                                        type="number"
                                        min={1}
                                        max={59}
                                        className="w-16 rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                                        value={draft.minutes}
                                        onChange={(event) => patch({ minutes: Number(event.target.value) })}
                                        data-testid="fleet-schedule-minutes"
                                    />
                                    {tc('minutes')}
                                </label>
                            ) : null}
                            {draft.form === 'daily' || draft.form === 'weekdays' || draft.form === 'days' ? (
                                <label className="inline-flex items-center gap-1">
                                    {tc('at')}
                                    <input
                                        type="time"
                                        className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                                        value={draft.at}
                                        onChange={(event) => patch({ at: event.target.value })}
                                        data-testid="fleet-schedule-at"
                                    />
                                </label>
                            ) : null}
                            {draft.form === 'cron' ? (
                                <input
                                    className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                                    value={draft.expr}
                                    onChange={(event) => patch({ expr: event.target.value })}
                                    placeholder="0 2 * * 1-5"
                                    aria-label={tc('cronLabel')}
                                    data-testid="fleet-schedule-cron"
                                />
                            ) : null}
                        </div>
                        {draft.form === 'days' ? (
                            <div className="flex flex-wrap gap-1" role="group" aria-label={tc('daysLabel')}>
                                {DAY_KEYS.map((key, day) => {
                                    const on = draft.days.includes(day);
                                    return (
                                        <button
                                            key={key}
                                            type="button"
                                            aria-pressed={on}
                                            className={`rounded border px-2 py-0.5 text-xs ${on ? 'border-primary bg-primary/10' : 'border-border dark:border-border-dark'}`}
                                            onClick={() =>
                                                patch({
                                                    days: on ? draft.days.filter((entry) => entry !== day) : [...draft.days, day],
                                                })
                                            }
                                        >
                                            {tc(`days.${key}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                        {built.error ? (
                            <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                                {built.error}
                            </p>
                        ) : (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-schedule-preview">
                                {t('next')}{' '}
                                {preview
                                    .map((entry) =>
                                        entry.viewer ? t('twoZones', { computer: entry.computer, viewer: entry.viewer }) : entry.computer,
                                    )
                                    .join(' · ')}
                            </p>
                        )}
                    </fieldset>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('runsAs')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('noCredits')}</p>
                    <p className="text-xs font-medium text-warning">⚠ {t('sandbox')}</p>
                    {error ? (
                        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
                            {t('cancel')}
                        </Button>
                        <Button size="sm" onClick={() => void save(false)} disabled={!ready || busy} data-testid="fleet-schedule-save">
                            {mode === 'edit' ? t('save') : t('create')}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
