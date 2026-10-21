'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_AGENT_SESSION_PROVIDERS,
    FLEET_SCHEDULE_NAME_MAX_LENGTH,
    type FleetAgentSessionScheduleConfirmation,
    type FleetNodeView,
    type FleetScheduleAgentOption,
    type FleetScheduleConfirmationDetails,
    type FleetScheduleUpdateRequest,
    type FleetScheduleView,
} from '@ever-works/contracts';
import { listNodeCheckoutsAction } from '@/app/actions/fleet-checkouts';
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
    /** A Command schedule's view, or nothing for an Agent-session schedule (the panel re-reads its list). */
    onSaved: (schedule: FleetScheduleView | null) => void;
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
    // FL-13 P2 — an Agent-session schedule (create only: the kind never changes, FR-10).
    const [kind, setKind] = useState<'command' | 'agent'>('command');
    const [agents, setAgents] = useState<FleetScheduleAgentOption[] | null>(null);
    const [agentId, setAgentId] = useState('');
    const [prompt, setPrompt] = useState('');
    const [provider, setProvider] = useState<string>(FLEET_AGENT_SESSION_PROVIDERS[0]);
    const [checkouts, setCheckouts] = useState<Array<{ id: string; label: string }>>([]);
    const [checkoutId, setCheckoutId] = useState('');
    const [agentConfirmation, setAgentConfirmation] = useState<FleetAgentSessionScheduleConfirmation | null>(null);
    const tn = useTranslations('fleet.schedules');

    const target = nodes.find((candidate) => candidate.id === nodeId) ?? node;
    const viewerZone = useMemo(() => viewerTimeZone(), []);
    const computerZone = target.timeZone ?? null;
    const built = cadenceFromDraft(draft);
    const preview = previewFires(built.cadence, computerZone, viewerZone, Date.now());
    useEffect(() => {
        if (kind !== 'agent' || agents !== null) return;
        let cancelled = false;
        void schedulesClient.agents(node.id).then((result) => {
            if (cancelled) return;
            const list = result.ok ? result.data.agents : [];
            setAgents(list);
            const pinned = list.find((agent) => agent.pinned);
            if (pinned) setAgentId(pinned.agentId);
        });
        void listNodeCheckoutsAction(node.id, { state: 'ready' })
            .then((result) => {
                if (cancelled || !result.success) return;
                setCheckouts(
                    result.data.data.map((checkout) => ({
                        id: checkout.id,
                        label: checkout.repository ? `${checkout.repository} · ${checkout.path}` : checkout.path,
                    })),
                );
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [kind, agents, node.id]);

    const ready =
        name.trim().length > 0 &&
        built.cadence !== null &&
        (kind === 'agent' ? Boolean(agentId) && prompt.trim().length >= 3 : command.trim().length > 0);

    const saveAgentSession = async (confirm: boolean) => {
        if (!ready || !built.cadence) return;
        setBusy(true);
        setError(null);
        const result = await schedulesClient.createAgentSession(node.id, {
            name: name.trim(),
            agentId,
            prompt,
            provider,
            ...(checkoutId ? { checkoutId } : {}),
            cadence: built.cadence as unknown as Record<string, unknown>,
            ...(confirm ? { confirm: true } : {}),
        });
        setBusy(false);
        if (result.ok) {
            onSaved(null);
            onClose();
            return;
        }
        if (result.error.code === 'confirmation_required' && result.error.details.kind === 'agent-session') {
            setAgentConfirmation(result.error.details as unknown as FleetAgentSessionScheduleConfirmation);
            return;
        }
        setError(result.error.hint ?? t('failed'));
    };
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
            {agentConfirmation ? (
                <div className="space-y-2" data-testid="fleet-schedule-agent-confirm">
                    <p className="font-medium">
                        {t('confirm.create', { name: agentConfirmation.name, computer: agentConfirmation.nodeName })}
                    </p>
                    <p className="text-xs">
                        {agentConfirmation.agentName} · {agentConfirmation.cadenceHuman}
                    </p>
                    <p className="text-xs" data-testid="fleet-schedule-credential-note">
                        {tn('unattendedCredentialNote', { computer: agentConfirmation.nodeName })}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">{tn('agentSessions.costNote')}</p>
                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="sm" onClick={() => setAgentConfirmation(null)} disabled={busy}>
                            {t('back')}
                        </Button>
                        <Button size="sm" onClick={() => void saveAgentSession(true)} disabled={busy}>
                            {t('createConfirmed')}
                        </Button>
                    </div>
                </div>
            ) : confirmation ? (
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
                        <Button variant="secondary" size="sm" onClick={() => setConfirmation(null)} disabled={busy}>
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
                    {mode === 'create' ? (
                        <fieldset className="flex flex-wrap gap-4" data-testid="fleet-schedule-kind">
                            <legend className="mb-1 text-xs">{t('runs')}</legend>
                            <label className="inline-flex items-center gap-1">
                                <input type="radio" name="schedule-kind" checked={kind === 'command'} onChange={() => setKind('command')} />
                                {t('kindCommand')}
                            </label>
                            <label className="inline-flex items-center gap-1">
                                <input type="radio" name="schedule-kind" checked={kind === 'agent'} onChange={() => setKind('agent')} />
                                {t('kindAgent')}
                            </label>
                        </fieldset>
                    ) : null}
                    {kind === 'agent' ? (
                        <>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs">{t('agent')}</span>
                                <select
                                    className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                                    value={agentId}
                                    onChange={(event) => setAgentId(event.target.value)}
                                    data-testid="fleet-schedule-agent"
                                >
                                    {(agents ?? []).map((agent) => (
                                        <option key={agent.agentId} value={agent.agentId} disabled={!agent.pinned}>
                                            {agent.name}
                                            {agent.reason ? ` — ${t(`agentReasons.${agent.reason}`)}` : ''}
                                        </option>
                                    ))}
                                </select>
                                {agents !== null && !agents.some((agent) => agent.pinned) ? (
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('noPinnedAgent', { computer: node.name })}
                                    </span>
                                ) : null}
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs">{t('prompt')}</span>
                                <textarea
                                    className="min-h-[4rem] rounded border border-border bg-transparent px-2 py-1 text-xs dark:border-border-dark"
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    placeholder={t('promptPlaceholder')}
                                    data-testid="fleet-schedule-prompt"
                                />
                            </label>
                            <div className="flex flex-wrap gap-3">
                                <label className="flex flex-col gap-1">
                                    <span className="text-xs">{t('provider')}</span>
                                    <select
                                        className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                                        value={provider}
                                        onChange={(event) => setProvider(event.target.value)}
                                    >
                                        {FLEET_AGENT_SESSION_PROVIDERS.map((value) => (
                                            <option key={value} value={value}>
                                                {value === 'codex' ? 'Codex' : 'Claude Code'}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className="text-xs">{t('checkout')}</span>
                                    <select
                                        className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                                        value={checkoutId}
                                        onChange={(event) => setCheckoutId(event.target.value)}
                                        data-testid="fleet-schedule-checkout"
                                    >
                                        <option value="">{t('checkoutHome')}</option>
                                        {checkouts.map((checkout) => (
                                            <option key={checkout.id} value={checkout.id}>
                                                {checkout.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            <div className="rounded border border-border p-2 text-xs dark:border-border-dark">
                                <p className="font-medium">{t('credentialTitle')}</p>
                                <p>{tn('unattendedCredentialNote', { computer: node.name })}</p>
                            </div>
                        </>
                    ) : null}
                    <label className={kind === 'agent' ? 'hidden' : 'flex flex-col gap-1'}>
                        <span className="text-xs">{t('command')}</span>
                        <textarea
                            className="min-h-[3rem] rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                            value={command}
                            onChange={(event) => setCommand(event.target.value)}
                            placeholder="pnpm test"
                            data-testid="fleet-schedule-command"
                        />
                    </label>
                    <label className={kind === 'agent' ? 'hidden' : 'flex flex-col gap-1'}>
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
                    {kind === 'agent' ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">{tn('agentSessions.costNote')}</p>
                    ) : (
                        <>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('runsAs')}</p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('noCredits')}</p>
                        </>
                    )}
                    <p className="text-xs font-medium text-warning">⚠ {t('sandbox')}</p>
                    {error ? (
                        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                            {t('cancel')}
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => void (kind === 'agent' ? saveAgentSession(false) : save(false))}
                            disabled={!ready || busy}
                            data-testid="fleet-schedule-save"
                        >
                            {mode === 'edit' ? t('save') : t('create')}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
