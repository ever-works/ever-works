'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
    FLEET_COMMAND_DEFAULT_TIMEOUT_SEC,
    FLEET_COMMAND_RECENT,
    FLEET_COMMAND_TIMEOUT_CHOICES_SEC,
    type FleetCommandConfirmationDetails,
    type FleetCommandRunRequest,
    type FleetCommandView,
} from '@ever-works/contracts';
import { listNodeCheckoutsAction } from '@/app/actions/fleet-checkouts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { FleetHubTabProps } from '../registry';
import { CommandConfirmDialog } from './CommandConfirmDialog';
import { CommandRunCard } from './CommandRunCard';
import { commandsClient } from './commands.client';
import {
    commandIsLive,
    commandPickRows,
    commandPreselection,
    commandSummaryLine,
    readCommandConfirmation,
    type CommandErrorRead,
    type CommandPickRow,
} from './commands.shared';

/** How often a live Command is read again (lane-log decision 1). */
const POLL_MS = 1_000;

/** The timeout menu's choice for a stored timeout: the smallest choice that is not shorter. */
function snapTimeout(seconds: number): number {
    return (
        FLEET_COMMAND_TIMEOUT_CHOICES_SEC.find((choice) => choice >= seconds) ??
        FLEET_COMMAND_TIMEOUT_CHOICES_SEC[FLEET_COMMAND_TIMEOUT_CHOICES_SEC.length - 1]
    );
}

/** Most computers whose checkouts the folder picker reads at once (P3). */
const FOLDER_PICKER_MAX_COMPUTERS = 5;

function agoLabel(iso: string | null, now: number): string | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 90) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

/**
 * Commands on computers (FL-12, spec §0, §5.1, §5.2, FR-15 … FR-18, FR-22) —
 * the hub's Commands tab: one line, the computers it should run on, one
 * output card per computer filling as the machines answer, the summary line,
 * and Recent (the last 8). Registered with `registerHubTab` behind
 * `FLEET_COMMANDS_ENABLED` (`modules/fl-12-commands.server.ts`).
 *
 * Every run goes through the platform's own confirmation: the first call
 * answers 409 `confirmation_required` with one line per computer, the dialog
 * shows it, and only "Run on N" repeats the call with `confirm: true`. Output
 * is read by polling the Command once a second while any run is live.
 */
export default function CommandsPanel({ nodes, flags }: FleetHubTabProps) {
    const t = useTranslations('fleet.commands');
    const searchParams = useSearchParams();
    const onlyNode = searchParams?.get('node') ?? null;
    const rows = useMemo(() => commandPickRows(nodes), [nodes]);
    const [selected, setSelected] = useState<string[]>(() => commandPreselection(rows, onlyNode));
    const [command, setCommand] = useState('');
    const [cwd, setCwd] = useState('');
    const [timeoutSec, setTimeoutSec] = useState<number>(FLEET_COMMAND_DEFAULT_TIMEOUT_SEC);
    const [confirm, setConfirm] = useState<FleetCommandConfirmationDetails | null>(null);
    /** Exactly the request the confirmation summarised — what "Run on N" sends. */
    const [confirmFor, setConfirmFor] = useState<FleetCommandRunRequest | null>(null);
    const [folders, setFolders] = useState<Array<{ path: string; label: string }>>([]);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<CommandErrorRead | null>(null);
    const [current, setCurrent] = useState<FleetCommandView | null>(null);
    const [recent, setRecent] = useState<FleetCommandView[] | null>(null);
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const inputRef = useRef<HTMLInputElement | null>(null);

    const loadRecent = useCallback(async () => {
        const result = await commandsClient.recent(FLEET_COMMAND_RECENT);
        setRecent(result.ok ? result.data.commands : []);
    }, []);

    useEffect(() => {
        void loadRecent();
    }, [loadRecent]);

    // Poll the open Command while any of its runs is live.
    const currentId = current?.id ?? null;
    const live = current ? commandIsLive(current.runs) : false;
    useEffect(() => {
        if (!currentId || !live) return;
        let cancelled = false;
        const timer = setInterval(async () => {
            const result = await commandsClient.get(currentId);
            if (cancelled || !result.ok) return;
            setCurrent(result.data);
            setNow(Date.now());
            if (!commandIsLive(result.data.runs)) void loadRecent();
        }, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [currentId, live, loadRecent]);

    const selectable = rows.filter((row) => row.selectable);
    const chosen = selected.filter((id) => selectable.some((row) => row.nodeId === id));

    const request = (): FleetCommandRunRequest => ({
        command,
        nodeIds: chosen,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        timeoutSec,
    });

    // Folder picker (P3, T-25): the ready checkouts of the picked computers
    // (FL-14), offered under the folder field; the field still takes any path.
    const checkoutsOn = flags?.FLEET_CHECKOUTS_ENABLED === true;
    const chosenKey = chosen.join(',');
    useEffect(() => {
        const ids = chosenKey ? chosenKey.split(',') : [];
        if (!checkoutsOn || ids.length === 0 || ids.length > FOLDER_PICKER_MAX_COMPUTERS) {
            setFolders([]);
            return;
        }
        let cancelled = false;
        void Promise.all(
            ids.map(async (nodeId) => {
                const result = await listNodeCheckoutsAction(nodeId, { state: 'ready' }).catch(() => null);
                if (!result || !result.success) return [];
                const name = nodes.find((node) => node.id === nodeId)?.name ?? '';
                return result.data.data.map((checkout) => ({
                    path: checkout.path,
                    label: checkout.repository ? `${name} · ${checkout.repository}` : name,
                }));
            }),
        ).then((lists) => {
            if (cancelled) return;
            const seen = new Set<string>();
            const out: Array<{ path: string; label: string }> = [];
            for (const entry of lists.flat()) {
                if (seen.has(entry.path)) continue;
                seen.add(entry.path);
                out.push(entry);
            }
            setFolders(out.slice(0, 100));
        });
        return () => {
            cancelled = true;
        };
    }, [checkoutsOn, chosenKey, nodes]);

    /** Ask the platform: it answers with the confirmation to show (CONTRACTS §2.2). */
    const ask = async (next: FleetCommandRunRequest) => {
        setPending(true);
        setError(null);
        const result = await commandsClient.run(next);
        setPending(false);
        if (result.ok) {
            // A platform that needs no confirmation (never today) ran it already.
            setCurrent(result.data);
            void loadRecent();
            return;
        }
        const details =
            result.error.code === 'confirmation_required' ? readCommandConfirmation(result.error.details) : null;
        if (details) {
            setConfirm(details);
            setConfirmFor(next);
        } else setError(result.error);
    };

    /** "Run on N". */
    const onRun = async () => {
        if (!command.trim() || chosen.length === 0 || pending) return;
        await ask(request());
    };

    /**
     * Re-run from Recent (P3, T-26, spec FR-17): the composer is filled from the
     * stored Command and the confirmation opens. A command line the platform
     * stored redacted is not re-run (it would run the placeholder): the person
     * types it again.
     */
    const onRerun = async (view: FleetCommandView) => {
        if (pending) return;
        if (view.commandRedacted) {
            setError({ code: 'invalid', hint: t('rerun.redacted'), details: {}, status: 400 });
            return;
        }
        const nodeIds = view.nodeIds.filter((id) => selectable.some((row) => row.nodeId === id));
        const snapped = snapTimeout(view.timeoutSec);
        setCommand(view.command);
        setCwd(view.cwd ?? '');
        setTimeoutSec(snapped);
        setSelected(nodeIds);
        if (nodeIds.length === 0) {
            setError({ code: 'unreachable', hint: t('rerun.none'), details: {}, status: 503 });
            return;
        }
        await ask({
            command: view.command,
            nodeIds,
            ...(view.cwd ? { cwd: view.cwd } : {}),
            timeoutSec: snapped,
        });
    };

    const onConfirm = async () => {
        if (!confirmFor) return;
        setPending(true);
        setError(null);
        const result = await commandsClient.run({ ...confirmFor, confirm: true });
        setPending(false);
        setConfirm(null);
        setConfirmFor(null);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setCurrent(result.data);
        setNow(Date.now());
        setHistoryIndex(null);
        void loadRecent();
    };

    const onStop = async () => {
        if (!current) return;
        const result = await commandsClient.cancel(current.id);
        if (result.ok) setCurrent(result.data);
        else setError(result.error);
    };

    const openRecent = async (id: string) => {
        const result = await commandsClient.get(id);
        if (result.ok) {
            setCurrent(result.data);
            setNow(Date.now());
        } else setError(result.error);
    };

    const toggle = (row: CommandPickRow) => {
        if (!row.selectable) return;
        setSelected((list) =>
            list.includes(row.nodeId) ? list.filter((id) => id !== row.nodeId) : [...list, row.nodeId],
        );
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
            event.preventDefault();
            void onRun();
            return;
        }
        const history = (recent ?? []).map((entry) => entry.command);
        if (event.key === 'ArrowUp' && history.length > 0) {
            event.preventDefault();
            const next = historyIndex === null ? 0 : Math.min(history.length - 1, historyIndex + 1);
            setHistoryIndex(next);
            setCommand(history[next]);
        } else if (event.key === 'ArrowDown' && historyIndex !== null) {
            event.preventDefault();
            const next = historyIndex - 1;
            setHistoryIndex(next < 0 ? null : next);
            setCommand(next < 0 ? '' : history[next]);
        }
    };

    if (nodes.length === 0) {
        return (
            <section className="rounded-lg border border-border p-6 text-center dark:border-border-dark" data-testid="fleet-commands-empty">
                <h2 className="text-base font-semibold text-text dark:text-text-dark">{t('empty.title')}</h2>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">{t('empty.body')}</p>
            </section>
        );
    }

    const summary = current ? commandSummaryLine(current.summary) : null;

    return (
        <div className="space-y-4" data-testid="fleet-commands-panel">
            <section className="rounded-lg border border-border bg-surface p-4 dark:border-border-dark dark:bg-surface-dark">
                <h2 className="mb-3 text-sm font-semibold text-text dark:text-text-dark">{t('title')}</h2>
                <label className="sr-only" htmlFor="fleet-command-input">
                    {t('composer.label')}
                </label>
                <input
                    id="fleet-command-input"
                    ref={inputRef}
                    value={command}
                    onChange={(event) => {
                        setCommand(event.target.value);
                        setHistoryIndex(null);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t('composer.placeholder')}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={selectable.length === 0}
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm text-text outline-none focus:border-primary dark:border-border-dark dark:text-text-dark"
                    data-testid="fleet-command-input"
                />

                <fieldset className="mt-3" data-testid="fleet-command-picker">
                    <legend className="mb-1 text-xs font-medium text-text-muted dark:text-text-muted-dark">
                        {t('picker.label')}
                    </legend>
                    {selectable.length === 0 && (
                        <p className="mb-2 text-sm text-warning" role="status">
                            {t('picker.none')}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {rows.map((row) => {
                            const reason = row.reason
                                ? row.reason === 'offline'
                                    ? agoLabel(row.lastHeartbeatAt, now)
                                        ? t('picker.reasons.offline', { time: agoLabel(row.lastHeartbeatAt, now) ?? '' })
                                        : t('picker.reasons.offlineNever')
                                    : t(`picker.reasons.${row.reason}`, { name: row.name })
                                : null;
                            return (
                                <div key={row.nodeId} className="min-w-0" data-testid="fleet-command-picker-row" data-node-id={row.nodeId}>
                                    <Checkbox
                                        checked={row.selectable && chosen.includes(row.nodeId)}
                                        disabled={!row.selectable}
                                        onChange={() => toggle(row)}
                                        label={row.name}
                                        {...(reason ? { description: reason } : {})}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </fieldset>

                <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="flex flex-col text-xs text-text-muted dark:text-text-muted-dark">
                        {t('composer.timeout')}
                        <select
                            value={timeoutSec}
                            onChange={(event) => setTimeoutSec(Number(event.target.value))}
                            className="mt-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-text dark:border-border-dark dark:text-text-dark"
                            data-testid="fleet-command-timeout"
                        >
                            {FLEET_COMMAND_TIMEOUT_CHOICES_SEC.map((seconds) => (
                                <option key={seconds} value={seconds}>
                                    {t('composer.timeoutMinutes', { minutes: Math.round(seconds / 60) })}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex min-w-[12rem] flex-1 flex-col text-xs text-text-muted dark:text-text-muted-dark">
                        {t('composer.folder')}
                        <input
                            value={cwd}
                            onChange={(event) => setCwd(event.target.value)}
                            placeholder={t('composer.folderPlaceholder')}
                            spellCheck={false}
                            list={folders.length > 0 ? 'fleet-command-folders' : undefined}
                            className="mt-1 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-sm text-text dark:border-border-dark dark:text-text-dark"
                            data-testid="fleet-command-folder"
                        />
                        {folders.length > 0 && (
                            <datalist id="fleet-command-folders" data-testid="fleet-command-folder-checkouts">
                                {folders.map((folder) => (
                                    <option key={folder.path} value={folder.path} label={folder.label} />
                                ))}
                            </datalist>
                        )}
                    </label>
                    <Button
                        variant="primary"
                        onClick={() => void onRun()}
                        disabled={pending || !command.trim() || chosen.length === 0}
                        data-testid="fleet-command-run"
                    >
                        {chosen.length > 0 ? t('composer.run', { count: chosen.length }) : t('composer.runNone')}
                    </Button>
                    {/* Schedules on computers (FL-13, spec §5.5): the same command, on a cadence, on ONE computer. */}
                    {chosen.length === 1 && command.trim() ? (
                        <Link
                            href={`/fleet/computers/${encodeURIComponent(chosen[0])}?tab=schedules&command=${encodeURIComponent(command)}${
                                cwd.trim() ? `&cwd=${encodeURIComponent(cwd.trim())}` : ''
                            }`}
                            className="self-center text-xs underline"
                            data-testid="fleet-command-schedule-this"
                        >
                            {t('composer.scheduleThis')}
                        </Link>
                    ) : null}
                </div>

                <p className="mt-3 text-xs text-warning" data-testid="fleet-command-sandbox">
                    {`⚠ ${t('sandbox')}`}
                </p>
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-command-cost">
                    {t('costNote')}
                </p>
                {error && (
                    <p role="alert" className="mt-2 text-sm text-danger" data-testid="fleet-command-error">
                        {error.code === 'network'
                            ? t('errors.network')
                            : error.hint
                              ? t('errors.withHint', { code: error.code, hint: error.hint })
                              : t('errors.generic')}
                    </p>
                )}
            </section>

            {current && (
                <section data-testid="fleet-command-result" data-command-id={current.id}>
                    <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <code className="truncate font-mono text-sm text-text dark:text-text-dark">{`$ ${current.command}`}</code>
                        {commandIsLive(current.runs) ? (
                            <Button variant="secondary" size="sm" onClick={() => void onStop()} data-testid="fleet-command-stop">
                                {t('stop')}
                            </Button>
                        ) : (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void onRerun(current)}
                                disabled={pending}
                                title={current.commandRedacted ? t('rerun.redacted') : undefined}
                                data-testid="fleet-command-rerun"
                            >
                                {t('rerun.action')}
                            </Button>
                        )}
                    </header>
                    <div className="grid gap-3 md:grid-cols-2">
                        {current.runs.map((run) => (
                            <CommandRunCard key={run.id} run={run} />
                        ))}
                    </div>
                    {summary && (
                        <p className="mt-2 text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-command-summary">
                            {t(`summary.${summary.key}`, summary.values)}
                        </p>
                    )}
                </section>
            )}

            <section data-testid="fleet-command-recent">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                    {t('recent.title')}
                </h2>
                {recent === null ? (
                    <div className="flex flex-wrap gap-2" aria-label={t('recent.loading')}>
                        {Array.from({ length: FLEET_COMMAND_RECENT }, (_, index) => (
                            <span key={index} className="h-6 w-24 animate-pulse rounded bg-black/5 dark:bg-white/5" />
                        ))}
                    </div>
                ) : recent.length === 0 ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('recent.empty')}</p>
                ) : (
                    <ul className="flex flex-wrap gap-2">
                        {recent.map((entry) => (
                            <li key={entry.id} className="flex items-stretch">
                                <button
                                    type="button"
                                    onClick={() => void openRecent(entry.id)}
                                    className="max-w-[18rem] truncate rounded-l border border-border px-2 py-1 font-mono text-xs text-text hover:bg-black/5 dark:border-border-dark dark:text-text-dark dark:hover:bg-white/5"
                                    title={entry.command}
                                    data-testid="fleet-command-recent-item"
                                >
                                    {entry.command}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void onRerun(entry)}
                                    disabled={pending}
                                    className="rounded-r border border-l-0 border-border px-1.5 text-xs text-text-muted hover:bg-black/5 disabled:opacity-50 dark:border-border-dark dark:text-text-muted-dark dark:hover:bg-white/5"
                                    aria-label={t('rerun.label', { command: entry.command })}
                                    title={t('rerun.action')}
                                    data-testid="fleet-command-recent-rerun"
                                >
                                    ↻
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <CommandConfirmDialog
                open={confirm !== null}
                details={confirm}
                pending={pending}
                onCancel={() => {
                    setConfirm(null);
                    setConfirmFor(null);
                }}
                onConfirm={() => void onConfirm()}
            />
        </div>
    );
}
