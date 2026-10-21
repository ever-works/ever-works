'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FastForward, Pause, Play, Rewind, SkipBack } from 'lucide-react';
import type { FleetSessionRecordingManifest } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import type { TerminalRenderer } from '@/components/terminal/terminal-renderer';
import { createTerminalRenderer } from '@/components/terminal/create-terminal-renderer';
import { sessionsClient } from './sessions.client';
import {
    buildTimeline,
    clampPosition,
    formatPosition,
    printedBy,
    REPLAY_JUMP_MS,
    REPLAY_SPEEDS,
    REPLAY_STEP_MS,
    spanMarks,
    timelineDuration,
    type ReplaySpeed,
    type TimedChunk,
} from './replay.shared';

/** Pages read at most (200 chunks each): a recording longer than this plays its first part. */
const MAX_PAGES = 50;
/** The player's tick. */
const TICK_MS = 100;

/**
 * Sessions on computers (FL-04 P3, spec FR-56, AW-11 P3) — re-watch a
 * recorded session: the stored terminal text replayed into the same renderer
 * the live pane uses, on a clock (idle gaps shortened to 3 s), with play /
 * pause, a 1 s slider, 10 s jumps, speeds 1× 2× 4×, and the driver spans
 * marked on the slider ("Nina drove 14:02–14:09").
 *
 * The "nothing to play" variants say why: not recorded, storage stopped it,
 * removed after 14 days, nothing recorded yet.
 */
export function SessionReplayPlayer({
    sessionId,
    title,
    nodeName,
    createRenderer,
}: {
    sessionId: string;
    title: string;
    nodeName: string;
    createRenderer?: () => Promise<TerminalRenderer>;
}) {
    const t = useTranslations('fleet.sessions.replay');
    const locale = useLocale();
    const hostRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const [manifest, setManifest] = useState<FleetSessionRecordingManifest | null>(null);
    const [timeline, setTimeline] = useState<TimedChunk[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState<ReplaySpeed>(1);
    const [position, setPosition] = useState(0);
    /** How many chunks the renderer shows right now. */
    const printedRef = useRef(0);

    // Load the manifest, then every page.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const head = await sessionsClient.recording(sessionId);
            if (cancelled) return;
            if (!head.ok) {
                setFailed(true);
                return;
            }
            setManifest(head.data);
            if (head.data.chunks === 0) {
                setTimeline([]);
                return;
            }
            const chunks = [];
            let from = 0;
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await sessionsClient.recordingPage(sessionId, from);
                if (cancelled) return;
                if (!result.ok) break;
                chunks.push(...result.data.chunks);
                if (!result.data.hasMore || result.data.lastSeq === null) break;
                from = result.data.lastSeq + 1;
            }
            setTimeline(buildTimeline(chunks));
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    // The renderer, mounted once into a React-child-free host.
    useEffect(() => {
        let disposed = false;
        void (createRenderer ?? createTerminalRenderer)().then((renderer) => {
            if (disposed || !hostRef.current) {
                renderer.dispose();
                return;
            }
            rendererRef.current = renderer;
            renderer.mount(hostRef.current);
            renderer.fit();
        });
        return () => {
            disposed = true;
            rendererRef.current?.dispose();
            rendererRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const duration = timeline ? timelineDuration(timeline) : 0;
    const encoder = useMemo(() => new TextEncoder(), []);

    /** Bring the renderer to `positionMs`: forward by writing what follows, backward by clearing and rewriting. */
    const render = useCallback(
        (positionMs: number) => {
            const renderer = rendererRef.current;
            if (!renderer || !timeline) return;
            const target = printedBy(timeline, positionMs);
            if (target < printedRef.current) {
                renderer.clear();
                printedRef.current = 0;
            }
            for (let index = printedRef.current; index < target; index++) {
                renderer.write(encoder.encode(timeline[index].text));
            }
            printedRef.current = target;
        },
        [timeline, encoder],
    );

    // The clock.
    useEffect(() => {
        if (!playing || !timeline) return;
        const timer = setInterval(() => {
            setPosition((current) => {
                const next = Math.min(duration, current + TICK_MS * speed);
                if (next >= duration) setPlaying(false);
                return next;
            });
        }, TICK_MS);
        return () => clearInterval(timer);
    }, [playing, speed, duration, timeline]);

    useEffect(() => {
        render(position);
    }, [position, render]);

    const seek = (positionMs: number) => setPosition(clampPosition(positionMs, duration));
    const marks = useMemo(
        () => (timeline && manifest ? spanMarks(timeline, manifest.driverSpans) : []),
        [timeline, manifest],
    );

    const empty = manifest && manifest.chunks === 0;
    const emptyLine = !manifest
        ? null
        : manifest.expired
          ? t('expired', { days: manifest.retentionDays })
          : manifest.state === 'off'
            ? t('notRecorded')
            : manifest.state === 'recording'
              ? t('nothingYet')
              : t('notRecorded');
    const date = manifest?.firstAt
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(manifest.firstAt))
        : '';

    return (
        <section className="space-y-3" aria-label={t('title', { title, node: nodeName, date })} data-testid="fleet-session-replay">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                {t('title', { title, node: nodeName, date })}
            </h2>
            {failed && (
                <p role="alert" className="text-sm text-danger">
                    {t('failed')}
                </p>
            )}
            {empty && (
                <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-session-replay-empty">
                    {emptyLine}
                </p>
            )}
            {!manifest && !failed && <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('loading')}</p>}

            <div className="relative h-[50vh] min-h-[280px] rounded-md overflow-hidden bg-[#0b0f19]" hidden={Boolean(empty)}>
                <div ref={hostRef} className="absolute inset-0" data-testid="fleet-session-replay-host" />
            </div>

            {!empty && timeline && timeline.length > 0 && (
                <div className="space-y-2">
                    <div className="relative">
                        <input
                            type="range"
                            min={0}
                            max={Math.max(duration, 1)}
                            step={REPLAY_STEP_MS}
                            value={position}
                            onChange={(event) => seek(Number(event.target.value))}
                            aria-label={t('position', { at: formatPosition(position), total: formatPosition(duration) })}
                            aria-valuetext={t('position', { at: formatPosition(position), total: formatPosition(duration) })}
                            className="w-full"
                            data-testid="fleet-session-replay-slider"
                        />
                        <div className="pointer-events-none absolute inset-x-0 -bottom-1 h-1" aria-hidden="true">
                            {marks.map((mark, index) => (
                                <span
                                    key={index}
                                    className="absolute h-1 rounded bg-warning/70"
                                    style={{ left: `${mark.start * 100}%`, width: `${Math.max(0.5, (mark.end - mark.start) * 100)}%` }}
                                />
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => seek(0)} aria-label={t('restart')}>
                            <SkipBack className="w-4 h-4" aria-hidden="true" />
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => seek(position - REPLAY_JUMP_MS)} aria-label={t('back10')}>
                            <Rewind className="w-4 h-4" aria-hidden="true" />
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => {
                                if (!playing && position >= duration) seek(0);
                                setPlaying((current) => !current);
                            }}
                            data-testid="fleet-session-replay-play"
                        >
                            {playing ? <Pause className="w-4 h-4" aria-hidden="true" /> : <Play className="w-4 h-4" aria-hidden="true" />}
                            {playing ? t('pause') : t('play')}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => seek(position + REPLAY_JUMP_MS)} aria-label={t('forward10')}>
                            <FastForward className="w-4 h-4" aria-hidden="true" />
                        </Button>
                        <span className="tabular-nums text-xs text-text-muted dark:text-text-muted-dark">
                            {formatPosition(position)} / {formatPosition(duration)}
                        </span>
                        <span className="ml-auto inline-flex items-center gap-1 text-xs" role="group" aria-label={t('speed')}>
                            {REPLAY_SPEEDS.map((option) => (
                                <button
                                    key={option}
                                    type="button"
                                    aria-pressed={speed === option}
                                    onClick={() => setSpeed(option)}
                                    className={
                                        speed === option
                                            ? 'rounded px-1.5 py-0.5 bg-primary/10 text-primary'
                                            : 'rounded px-1.5 py-0.5 text-text-muted dark:text-text-muted-dark'
                                    }
                                >
                                    {option}×
                                </button>
                            ))}
                        </span>
                    </div>
                    {marks.length > 0 && (
                        <ul className="text-xs text-text-muted dark:text-text-muted-dark space-y-0.5">
                            {marks.map((mark, index) => (
                                <li key={index}>
                                    {t('driverSpan', {
                                        name: mark.span.requestedBy?.startsWith('agent:') ? t('anAgent') : t('someone'),
                                        from: clock(mark.span.from, locale),
                                        to: clock(mark.span.to, locale),
                                    })}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
}

function clock(iso: string, locale: string): string {
    const at = new Date(iso);
    return Number.isFinite(at.getTime())
        ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
        : '';
}
