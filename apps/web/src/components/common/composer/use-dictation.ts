'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMicWaveform } from './use-mic-waveform';

/**
 * Web Speech API dictation for the composer, paired with a live mic meter.
 *
 * Only *final* results are appended, so a phrase the recognizer revises
 * mid-sentence never leaves half-words in the user's prompt. Interim results
 * are still requested — they make the recognizer commit finals sooner — but
 * are not surfaced.
 *
 * No-ops in browsers without SpeechRecognition: `supported` stays false and
 * the mic button is not rendered.
 */

// Web Speech API isn't in TS's default DOM lib, so declare just the bits we
// touch. Browsers expose it as `SpeechRecognition` (standard) or
// `webkitSpeechRecognition` (Chrome / Safari).
interface SpeechResult {
    readonly isFinal: boolean;
    readonly [index: number]: { readonly transcript: string };
}
interface SpeechResultList {
    readonly length: number;
    readonly [index: number]: SpeechResult;
}
interface SpeechEvent {
    readonly resultIndex: number;
    readonly results: SpeechResultList;
}
interface SpeechRecognizer {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechEvent) => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
    start(): void;
    stop(): void;
}
type SpeechRecognizerCtor = new () => SpeechRecognizer;

declare global {
    interface Window {
        SpeechRecognition?: SpeechRecognizerCtor;
        webkitSpeechRecognition?: SpeechRecognizerCtor;
    }
}

export interface Dictation {
    /** Whether this browser can dictate at all. */
    readonly supported: boolean;
    readonly listening: boolean;
    /** `Date.now()` at the moment dictation started — drives the elapsed timer. */
    readonly startedAt: number | null;
    /** True when the mic meter is live; false when it degraded to static bars. */
    readonly waveformActive: boolean;
    readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
    start: () => void;
    stop: () => void;
}

export function useDictation(onFinalText: (text: string) => void): Dictation {
    const recognitionRef = useRef<SpeechRecognizer | null>(null);
    const sessionActiveRef = useRef(false);
    const [listening, setListening] = useState(false);
    const [supported, setSupported] = useState(false);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const waveform = useMicWaveform();

    // Park the latest callback in a ref so the recognizer can dispatch through
    // it without re-subscribing every render — re-subscribing would tear down
    // continuous dictation after the first phrase.
    const onFinalTextRef = useRef(onFinalText);
    useEffect(() => {
        onFinalTextRef.current = onFinalText;
    }, [onFinalText]);

    // Same reason: `onend` / `onerror` fire from outside React and must shut
    // the meter down without the effect depending on it.
    const waveformStopRef = useRef(waveform.stop);
    useEffect(() => {
        waveformStopRef.current = waveform.stop;
    }, [waveform.stop]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
        // `supported` already defaults to false; setting it here would trip
        // react-hooks/set-state-in-effect for no gain.
        if (!Ctor) return;
        const rec = new Ctor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
        rec.onresult = (event) => {
            if (!sessionActiveRef.current) return;
            let finalText = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) finalText += result[0].transcript;
            }
            if (finalText.trim()) onFinalTextRef.current(finalText.trim());
        };
        const endSession = () => {
            sessionActiveRef.current = false;
            setListening(false);
            setStartedAt(null);
            waveformStopRef.current();
        };
        rec.onend = endSession;
        rec.onerror = endSession;
        recognitionRef.current = rec;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot capability detection at mount; can't be derived during render (needs window.SpeechRecognition).
        setSupported(true);
        return () => {
            sessionActiveRef.current = false;
            try {
                rec.stop();
            } catch {
                /* noop */
            }
        };
    }, []);

    const start = useCallback(() => {
        if (!recognitionRef.current) return;
        try {
            // Recognition first: on some browsers an already-open getUserMedia
            // stream makes SpeechRecognition.start() throw, and the meter is
            // the thing we're willing to lose, not the words.
            recognitionRef.current.start();
        } catch {
            return; /* already started */
        }
        sessionActiveRef.current = true;
        setListening(true);
        setStartedAt(Date.now());
        void waveform.start();
    }, [waveform]);

    const stop = useCallback(() => {
        sessionActiveRef.current = false;
        try {
            recognitionRef.current?.stop();
        } catch {
            /* noop */
        }
        setListening(false);
        setStartedAt(null);
        waveform.stop();
    }, [waveform]);

    return useMemo(
        () => ({
            supported,
            listening,
            startedAt,
            waveformActive: waveform.active,
            canvasRef: waveform.canvasRef,
            start,
            stop,
        }),
        [supported, listening, startedAt, waveform.active, waveform.canvasRef, start, stop],
    );
}
