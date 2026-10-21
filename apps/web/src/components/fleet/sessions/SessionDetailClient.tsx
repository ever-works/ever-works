'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, PauseCircle, RotateCw, Timer } from 'lucide-react';
import {
    isFleetSessionAgentProvider,
    isFleetSessionLive,
    type FleetNodeView,
    type FleetSessionAttachRole,
    type FleetSessionView,
} from '@ever-works/contracts';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { SHORTCUT_PRIORITY } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { Button } from '@/components/ui/button';
import type { TerminalRenderer } from '@/components/terminal/terminal-renderer';
import { useNow } from '../health/use-now';
import { relativeTime } from '../fleet-hub.shared';
import { SessionComposer } from './SessionComposer';
import { SessionEndDialog } from './SessionEndDialog';
import { SessionFooter } from './SessionFooter';
import { SessionActionsLedger } from './SessionActionsLedger';
import { SessionActionsMenu } from './SessionActionsMenu';
import { SessionGitPanel } from './SessionGitPanel';
import { SessionHeader } from './SessionHeader';
import { SessionRenameDialog } from './SessionRenameDialog';
import { SessionReplayPlayer } from './SessionReplayPlayer';
import { SessionShortcutSheet } from './SessionShortcutSheet';
import { SessionStartDialog } from './SessionStartDialog';
import { SessionTerminal } from './SessionTerminal';
import { sessionsClient } from './sessions.client';
import { SessionAttentionBox } from './SessionAttentionBox';
import { isAnswerable, isSessionUnread } from './sessions-status.shared';
import { endedLine, providerKey } from './sessions.shared';
import { useSessionAttach } from './use-session-attach';

/** How often a live session's row (state, presence) is re-read. */
const REFRESH_MS = 15_000;

/** `0:42` — a drain countdown. */
function countdown(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Sessions on computers (FL-04 P1b, spec §5.4, FR-21 … FR-26, FR-58 … FR-61) —
 * one session, live.
 *
 *  - **Live**: the terminal (replay, then live output), the role — the person
 *    who started an owner session drives by default, everyone else watches;
 *    "Take the keyboard" / "Watch only" re-mint in place — the composer for
 *    agent CLIs, the footer (role sentence, watchers, size, bandwidth).
 *  - **Strips**: "Reconnecting to build-01…" (with typed input held and
 *    offered: Send them · Discard), the kill switch ("Paused by the fleet
 *    stop"), the drain countdown, a refusal in words.
 *  - **Ended**: the last screen the computer kept and the ended line in
 *    words ("Ended 14:02 · exited with code 0"), Restart.
 *  - **Keys**: `T W R E N ?` while the terminal does not have the keyboard;
 *    Esc Esc leaves the terminal (the only key kept while driving).
 */
export function SessionDetailClient({
    initial,
    node,
    viewerUserId,
    agentName = null,
}: {
    initial: FleetSessionView;
    node: FleetNodeView | null;
    viewerUserId: string | null;
    /** The Agent of an Agent session (P2), for the isolation sentence and the end dialog. */
    agentName?: string | null;
}) {
    const t = useTranslations('fleet.sessions');
    const tGit = useTranslations('fleet.sessionGit');
    const locale = useLocale();
    const router = useRouter();
    const nowMs = useNow(1_000);
    const now = useMemo(() => new Date(nowMs), [nowMs]);
    const [session, setSession] = useState<FleetSessionView>(initial);
    const nodeName = node?.name ?? '…';
    const live = isFleetSessionLive(session.state);
    // An Agent session waits (its job queued) until the computer has a free slot:
    // there is nothing to attach to until the daemon runs it.
    const waiting = session.kind === 'agent' && session.state === 'starting';
    const startedByMe = session.kind === 'owner' && session.userId === viewerUserId;
    const [role, setRole] = useState<FleetSessionAttachRole>(startedByMe ? 'driver' : 'viewer');
    const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
    const [ending, setEnding] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [sheet, setSheet] = useState(false);
    const [starting, setStarting] = useState(false);
    // FL-06: bumped after an action is sent, so the ledger re-reads.
    const [ledgerKey, setLedgerKey] = useState(0);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    // P3: `?rewatch=1` (the Run receipt's link) opens the player straight away.
    const searchParams = useSearchParams();
    const [rewatch, setRewatch] = useState(searchParams?.get('rewatch') === '1');
    const [recordingBusy, setRecordingBusy] = useState(false);
    const toggleRecording = async () => {
        setRecordingBusy(true);
        const result = await sessionsClient.setRecording(session.id, session.recordingState !== 'recording');
        setRecordingBusy(false);
        if (result.ok) setSession(result.data);
        else toast.error(result.error.hint ? t('actions.failed', { hint: result.error.hint }) : t('actions.failedGeneric'));
    };
    const takeKeyboardRef = useRef<HTMLDivElement | null>(null);

    const refresh = useCallback(async () => {
        const result = await sessionsClient.get(session.id);
        if (result.ok) setSession(result.data);
    }, [session.id]);

    const attach = useSessionAttach(
        {
            sessionId: session.id,
            role,
            enabled: live && !waiting,
            size: () => size ?? { cols: 120, rows: 32 },
        },
        {
            onBytes: (bytes) => rendererRef.current?.write(bytes),
            onClear: () => rendererRef.current?.clear(),
            onExit: () => {
                // The process ended: read the row for its reason, code and last screen.
                window.setTimeout(() => void refresh(), 800);
            },
        },
    );

    useEffect(() => {
        if (attach.state === 'ended') void refresh();
    }, [attach.state, refresh]);

    // FL-05 (FR-26, U18): looking at the session acknowledges what it raised — the
    // unread mark clears, the prompt itself stays until it is answered. Once per key.
    const acknowledgedRef = useRef<string | null>(null);
    useEffect(() => {
        const attention = session.attention;
        if (!attention || !isSessionUnread(session) || acknowledgedRef.current === attention.key) return;
        acknowledgedRef.current = attention.key;
        void sessionsClient.acknowledge(session.id, attention.key).then((result) => {
            if (result.ok) setSession((current) => ({ ...current, attention: result.data.attention ?? null }));
        });
    }, [session]);
    const prompt = live && session.state === 'needs_you' && isAnswerable(session.attention) ? session.attention : null;

    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') void refresh();
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [live, refresh]);

    useEffect(() => {
        if (attach.refusedHint) toast.error(t('detail.inputRefused', { hint: attach.refusedHint }));
    }, [attach.refusedHint, t]);

    const release = () => takeKeyboardRef.current?.focus();
    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(`${window.location.origin}${ROUTES.DASHBOARD_FLEET_SESSION(session.id)}`);
            toast.success(t('actions.linkCopied'));
        } catch {
            toast.error(t('actions.failedGeneric'));
        }
    };
    const restart = async () => {
        const result = await sessionsClient.restart(session.id);
        if (!result.ok) {
            toast.error(result.error.hint ? t('actions.failed', { hint: result.error.hint }) : t('actions.failedGeneric'));
            return;
        }
        router.push(ROUTES.DASHBOARD_FLEET_SESSION(result.data.id));
    };

    const shortcut = (id: string, key: string, run: () => void, enabled = true) => ({
        options: { id: `fleet.session.${id}`, scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen, enabled },
        match: (event: KeyboardEvent) =>
            event.key.toLowerCase() === key && !event.ctrlKey && !event.metaKey && !event.altKey,
        run,
    });
    const keys = [
        shortcut('take', 't', () => setRole('driver'), live),
        shortcut('watch', 'w', () => setRole('viewer'), live),
        shortcut('rename', 'r', () => setRenaming(true)),
        shortcut('end', 'e', () => setEnding(true), live),
        shortcut('new', 'n', () => setStarting(true), node !== null),
    ];
    useShortcut(keys[0].options, keys[0].match, keys[0].run);
    useShortcut(keys[1].options, keys[1].match, keys[1].run);
    useShortcut(keys[2].options, keys[2].match, keys[2].run);
    useShortcut(keys[3].options, keys[3].match, keys[3].run);
    useShortcut(keys[4].options, keys[4].match, keys[4].run);
    useShortcut(
        { id: 'fleet.session.help', scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen },
        (event) => event.key === '?',
        () => setSheet(true),
    );

    const ended = endedLine(session);
    const endedAt = absoluteClock(session.endedAt, locale);
    const agentCli = isFleetSessionAgentProvider(session.provider);
    const providerName = t(`providers.${providerKey(session.provider)}`);
    const roleWords = attach.role === 'driver' ? t('detail.driving') : t('detail.watching');

    return (
        <div className="w-full space-y-4" data-testid="fleet-session-page" data-state={session.state}>
            <SessionHeader
                session={session}
                nodeName={nodeName}
                viewerUserId={viewerUserId}
                now={now}
                role={role}
                canDrive={live}
                onTakeKeyboard={() => setRole('driver')}
                onWatchOnly={() => setRole('viewer')}
                onRename={() => setRenaming(true)}
                onEnd={() => setEnding(true)}
                onRestart={() => void restart()}
                onCopyLink={() => void copyLink()}
                onShortcuts={() => setSheet(true)}
                actionsSlot={
                    // FL-06 (spec FR-12 … FR-18): the Actions menu (A, then 1–7).
                    session.provider !== 'shell' ? (
                        <SessionActionsMenu
                            session={session}
                            nodeName={nodeName}
                            agentName={agentName}
                            onSent={() => {
                                setLedgerKey((key) => key + 1);
                                window.setTimeout(() => void refresh(), 1_500);
                            }}
                        />
                    ) : null
                }
                gitSlot={
                    // FL-06 (spec FR-6 … FR-10): the git line, Changes, refresh.
                    <SessionGitPanel
                        session={session}
                        now={now}
                        offline={
                            node && node.status !== 'online'
                                ? {
                                      hint: tGit('detail.offline', {
                                          node: nodeName,
                                          age: relativeTime(node.lastHeartbeatAt, now, locale) ?? '—',
                                      }),
                                  }
                                : null
                        }
                        agentName={agentName}
                        onRefreshed={() => void refresh()}
                    />
                }
            />

            <div ref={takeKeyboardRef} tabIndex={-1} className="sr-only">
                {t('detail.releaseKeyboard')}
            </div>

            {waiting && (
                <Strip icon={<Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} testId="fleet-session-waiting">
                    {t('detail.waiting', { node: nodeName })}
                </Strip>
            )}
            {session.agentRunId && (
                <Link
                    href={ROUTES.DASHBOARD_AGENT_SESSION(session.agentRunId)}
                    className="inline-block text-xs text-primary hover:underline"
                    data-testid="fleet-session-run-link"
                >
                    {t('detail.openRun')}
                </Link>
            )}
            {live && !waiting && attach.state === 'starting' && (
                <Strip icon={<Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}>
                    {t('detail.starting', { node: nodeName })}
                </Strip>
            )}
            {live && attach.state === 'reconnecting' && (
                <Strip icon={<RotateCw className="w-4 h-4 animate-spin" aria-hidden="true" />} testId="fleet-session-reconnecting">
                    {t('detail.reconnecting', { node: nodeName })}
                </Strip>
            )}
            {attach.heldLines > 0 && (
                <Strip icon={<AlertTriangle className="w-4 h-4 text-warning" aria-hidden="true" />} testId="fleet-session-held">
                    <span>{t('detail.heldInput', { count: attach.heldLines })}</span>
                    <Button size="sm" onClick={attach.sendHeld}>
                        {t('detail.sendHeld')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={attach.discardHeld}>
                        {t('detail.discardHeld')}
                    </Button>
                </Strip>
            )}
            {attach.paused !== null && (
                <Strip icon={<PauseCircle className="w-4 h-4 text-warning" aria-hidden="true" />} testId="fleet-session-kill-switch">
                    {attach.paused
                        ? t('detail.killSwitch', { reason: attach.paused })
                        : t('detail.killSwitchNoReason')}
                </Strip>
            )}
            {attach.drainEndsAt !== null && live && (
                <Strip icon={<Timer className="w-4 h-4 text-warning" aria-hidden="true" />} testId="fleet-session-drain">
                    {t('detail.drainWarning', { countdown: countdown(attach.drainEndsAt - nowMs) })}
                </Strip>
            )}
            {attach.slow && <Strip icon={<AlertTriangle className="w-4 h-4" aria-hidden="true" />}>{t('detail.slowViewer')}</Strip>}
            {attach.state === 'refused' && (
                <Strip icon={<AlertTriangle className="w-4 h-4 text-danger" aria-hidden="true" />} testId="fleet-session-refused">
                    <span>{attach.error?.hint ?? t('detail.refusedGeneric')}</span>
                    <Button size="sm" variant="secondary" onClick={attach.reconnect}>
                        {t('detail.reconnect')}
                    </Button>
                </Strip>
            )}

            {live ? (
                <SessionTerminal
                    rendererRef={rendererRef}
                    onData={attach.sendInput}
                    onResize={(cols, rows) => {
                        setSize({ cols, rows });
                        attach.sendResize(cols, rows);
                    }}
                    onRelease={release}
                    ariaLabel={t('a11y.pane', { title: session.title, node: nodeName, role: roleWords })}
                />
            ) : (
                <section aria-label={t('detail.lastScreen', { node: nodeName })} className="space-y-2" data-testid="fleet-session-last-screen">
                    {session.lastScreen ? (
                        <pre className="max-h-[60vh] overflow-auto rounded-md bg-[#0b0f19] p-3 font-mono text-xs leading-5 text-gray-100 whitespace-pre-wrap">
                            {session.lastScreen}
                        </pre>
                    ) : (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('detail.noLastScreen')}</p>
                    )}
                    {!rewatch && (
                        <Button size="sm" variant="secondary" onClick={() => setRewatch(true)} data-testid="fleet-session-rewatch">
                            {t('detail.rewatch')}
                        </Button>
                    )}
                    {ended && (
                        <p className="text-sm text-text dark:text-text-dark" data-testid="fleet-session-ended-line" data-reason={session.endedReason ?? ''}>
                            {t(`detail.${ended.key}`, {
                                time: endedAt ?? relativeTime(session.endedAt, now, locale) ?? '',
                                node: nodeName,
                                code: 'code' in ended ? ended.code : 0,
                            })}
                        </p>
                    )}
                </section>
            )}

            {rewatch && <SessionReplayPlayer sessionId={session.id} title={session.title} nodeName={nodeName} />}

            {/* FL-05 P2 (FR-31): while it asks, the approval / question card replaces the composer. */}
            {prompt ? (
                <SessionAttentionBox
                    session={session}
                    attention={prompt}
                    nodeName={nodeName}
                    variant="detail"
                    killSwitchOn={attach.paused !== null}
                    onAnswered={() => void refresh()}
                />
            ) : (
                live &&
                agentCli &&
                attach.role === 'driver' && (
                    <SessionComposer providerName={providerName} disabled={attach.state !== 'attached' || attach.paused !== null} onSend={attach.sendInput} />
                )
            )}

            {/* FL-06 (spec FR-22): the actions sent so far, below the terminal. */}
            {session.provider !== 'shell' ? <SessionActionsLedger sessionId={session.id} refreshKey={ledgerKey} /> : null}

            <SessionFooter
                presence={session.presence}
                viewerUserId={viewerUserId}
                role={live ? attach.role : null}
                size={size}
                recordingState={session.recordingState}
                bytesPerSecond={attach.bytesPerSecond}
                nodeName={nodeName}
                isolatedAgentName={session.kind === 'agent' ? (agentName ?? t('kinds.agent')) : null}
                recordingSlot={
                    live ? (
                        <span className="inline-flex items-center gap-2" data-testid="fleet-session-recording">
                            <span>
                                {session.recordingState === 'recording' ? `● ${t('detail.recording')}` : t('detail.notRecordingNow')}
                            </span>
                            <button
                                type="button"
                                onClick={() => void toggleRecording()}
                                disabled={recordingBusy}
                                className="underline hover:no-underline disabled:opacity-50"
                                data-testid="fleet-session-recording-toggle"
                            >
                                {session.recordingState === 'recording' ? t('detail.recordOff') : t('detail.recordOn')}
                            </button>
                        </span>
                    ) : null
                }
            />

            <SessionEndDialog
                open={ending}
                onOpenChange={setEnding}
                session={session}
                nodeName={nodeName}
                agentName={agentName}
                onEnded={(view) => setSession(view)}
            />
            <SessionRenameDialog open={renaming} onOpenChange={setRenaming} session={session} onRenamed={(view) => setSession((current) => ({ ...current, title: view.title }))} />
            <SessionShortcutSheet open={sheet} onOpenChange={setSheet} />
            {node && <SessionStartDialog open={starting} onOpenChange={setStarting} node={node} />}
        </div>
    );
}

/** `14:02` in the reader's locale, or null. */
function absoluteClock(iso: string | null, locale: string): string | null {
    if (!iso) return null;
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return null;
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
}

function Strip({ icon, children, testId }: { icon: ReactNode; children: ReactNode; testId?: string }) {
    return (
        <div
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark px-3 py-2 text-sm text-text dark:text-text-dark"
            data-testid={testId}
        >
            {icon}
            {children}
        </div>
    );
}
