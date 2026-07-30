'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Live microphone level meter for the composer's dictation bar.
 *
 * The Web Speech API tells us *what* was said but exposes no audio level, so
 * a dictation UI built on it alone can only offer a static "listening" dot —
 * the user gets no confirmation their mic is actually picking anything up.
 * This hook opens a second, silent `getUserMedia` stream purely to read
 * amplitude off an `AnalyserNode` and paints it as a scrolling bar meter.
 *
 * Everything runs on refs + `requestAnimationFrame` into a `<canvas>`: React
 * never re-renders while recording, which matters because this repaints
 * continuously for as long as the user talks.
 *
 * The analyser is deliberately NOT connected to `ctx.destination` — routing
 * the mic to the speakers would feed back.
 */

/** Widest history we keep; the visible count is derived from canvas width. */
const MAX_SAMPLES = 96;
/** ~18 samples/sec — fast enough to track syllables, cheap to paint. */
const SAMPLE_INTERVAL_MS = 55;
const BAR_WIDTH = 2.5;
const BAR_GAP = 2;
/** Speech RMS lands around 0.02–0.2; scale so normal talking fills the bar. */
const LEVEL_GAIN = 4;
const MIN_LEVEL = 0.05;

export interface MicWaveform {
    /** Attach to the `<canvas>` that should show the meter. */
    readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
    /** True while a mic stream is open and the meter is painting. */
    readonly active: boolean;
    /**
     * Opens the mic and starts painting. Resolves `false` when the mic is
     * unavailable, permission is denied, or the browser lacks Web Audio —
     * callers fall back to a non-audio "listening" indicator.
     */
    start: () => Promise<boolean>;
    stop: () => void;
}

/** RMS amplitude of the current audio frame, normalized to a 0–1 bar height. */
function readLevel(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
        const deviation = (data[i] - 128) / 128;
        sumSquares += deviation * deviation;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    return Math.min(1, Math.max(MIN_LEVEL, rms * LEVEL_GAIN));
}

function paint(canvas: HTMLCanvasElement, levels: ReadonlyArray<number>): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    // Re-back the bitmap only when the CSS box or DPR actually changed;
    // assigning width/height clears the canvas on every write.
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.round(cssWidth * dpr);
    const targetHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Inherit the colour from CSS so the meter follows the light/dark design
    // token set on the element instead of hard-coding a hex here.
    // (`currentColor` is not a valid canvas fill, hence a literal neutral.)
    ctx.fillStyle = window.getComputedStyle(canvas).color || '#71717a';

    const step = BAR_WIDTH + BAR_GAP;
    const visible = Math.max(6, Math.floor((cssWidth + BAR_GAP) / step));
    // Newest sample sits at the right edge, so the meter scrolls leftwards.
    const window_ = levels.slice(-visible);
    const offset = visible - window_.length;

    for (let i = 0; i < window_.length; i++) {
        const level = window_[i];
        const height = Math.max(2, level * (cssHeight - 2));
        const x = (offset + i) * step;
        const y = (cssHeight - height) / 2;
        // Fade the tail so the history reads as motion even in a still frame.
        ctx.globalAlpha = 0.3 + 0.7 * ((offset + i + 1) / visible);
        if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(x, y, BAR_WIDTH, height, BAR_WIDTH / 2);
            ctx.fill();
        } else {
            ctx.fillRect(x, y, BAR_WIDTH, height);
        }
    }
    ctx.globalAlpha = 1;
}

export function useMicWaveform(): MicWaveform {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const levelsRef = useRef<number[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    // Explicit `<ArrayBuffer>` — `getByteTimeDomainData` rejects the
    // `ArrayBufferLike` default (it could be a SharedArrayBuffer).
    const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastSampleRef = useRef(0);
    const [active, setActive] = useState(false);

    const stop = useCallback(() => {
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        // Releasing the tracks is what turns the browser's recording
        // indicator off — closing the AudioContext alone does not.
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        analyserRef.current = null;
        dataRef.current = null;
        if (audioCtxRef.current) {
            void audioCtxRef.current.close().catch(() => {
                /* already closed */
            });
            audioCtxRef.current = null;
        }
        levelsRef.current = [];
        setActive(false);
    }, []);

    const start = useCallback(async () => {
        if (typeof window === 'undefined') return false;
        // A continuously animating meter is exactly what "reduce motion"
        // asks us not to draw; the caller shows a static indicator instead.
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
        if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) return false;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            const audioCtx = new window.AudioContext();
            audioCtxRef.current = audioCtx;
            void audioCtx.resume().catch(() => {
                /* autoplay policy — the meter just stays flat */
            });

            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.7;
            audioCtx.createMediaStreamSource(stream).connect(analyser);
            analyserRef.current = analyser;
            dataRef.current = new Uint8Array(analyser.fftSize);

            levelsRef.current = [];
            lastSampleRef.current = 0;

            // The loop lives here (a hoisted declaration so it can schedule
            // itself) and touches only refs, so it never needs re-creating
            // and React never re-renders while the meter runs.
            function frame() {
                rafRef.current = requestAnimationFrame(frame);

                const canvas = canvasRef.current;
                const liveAnalyser = analyserRef.current;
                const data = dataRef.current;
                if (!canvas || !liveAnalyser || !data) return;

                const now = performance.now();
                if (now - lastSampleRef.current < SAMPLE_INTERVAL_MS) return;
                lastSampleRef.current = now;

                const levels = levelsRef.current;
                levels.push(readLevel(liveAnalyser, data));
                if (levels.length > MAX_SAMPLES) levels.shift();
                paint(canvas, levels);
            }

            setActive(true);
            rafRef.current = requestAnimationFrame(frame);
            return true;
        } catch {
            // Permission denied / no input device / mic already claimed.
            stop();
            return false;
        }
    }, [stop]);

    // Never leave a mic stream open behind an unmounted composer.
    useEffect(() => stop, [stop]);

    // Stable identity so the consuming hook's start/stop stay stable too —
    // they end up in effect dependency arrays.
    return useMemo(() => ({ canvasRef, active, start, stop }), [active, start, stop]);
}
