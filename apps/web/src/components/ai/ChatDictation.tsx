'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Mic, Square } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Select } from '@/components/ui/select';
import { buildDictationProviderIcons, DICTATION_AUTO_ICON_KEY } from './dictation-provider-icons';

/**
 * Push-to-talk dictation for the chat composer.
 *
 * The transcription capability has existed since the KB media-ingest
 * work and is implemented by the AI-provider plugins; it simply had no
 * user-facing entry point. This is that entry point: record with
 * `MediaRecorder`, POST the clip to `/api/transcription`, hand the text
 * back to the composer.
 *
 * The control hides itself when the deployment has no transcription
 * provider (the endpoint answers 503). A mic button that always fails
 * is worse than no mic button, and whether a provider is configured is
 * a per-deployment fact the client cannot know up front — so it learns
 * from the first attempt rather than guessing.
 *
 * Transcribed text is handed to the caller to APPEND, never sent on its
 * own. Dictation that auto-sends turns a misheard word into a message
 * the user never chose to write.
 */

type State = 'idle' | 'recording' | 'transcribing';

interface TranscriptionProvider {
    readonly id: string;
    readonly name: string;
    readonly isActive: boolean;
}

/** Per-browser preference. The durable per-account choice is which
 *  plugin the account activates; this only overrides it for one user. */
const PROVIDER_STORAGE_KEY = 'ever-works.dictation.providerId';

export function ChatDictation({
    onText,
    disabled,
}: {
    readonly onText: (text: string) => void;
    readonly disabled?: boolean;
}) {
    const t = useTranslations('dashboard.aiChat.dictation');
    const [state, setState] = useState<State>('idle');
    const [unsupported, setUnsupported] = useState(false);
    const [providers, setProviders] = useState<TranscriptionProvider[]>([]);
    // The user's explicit pick. `null` means "no opinion", which is the
    // meaningful default: the request omits providerId entirely and the
    // server falls through to whichever plugin is activated for the
    // scope. Sending the active provider's id explicitly would look
    // identical but silently pin it, so an operator later switching the
    // activated plugin would not reach this user.
    const [providerId, setProviderId] = useState<string | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);

    const stopTracks = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
    }, []);

    // Releasing the mic on unmount matters: without it the browser's
    // recording indicator stays lit after the panel closes, which reads
    // as the app still listening.
    useEffect(() => stopTracks, [stopTracks]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch('/api/transcription/providers', {
                    headers: { Accept: 'application/json' },
                    cache: 'no-store',
                });
                if (!res.ok || cancelled) return;
                const body = (await res.json()) as { providers?: TranscriptionProvider[] };
                if (cancelled) return;
                const list = body.providers ?? [];
                setProviders(list);
                // Restore a previous pick only if that plugin is still
                // available — an operator may have disabled it since.
                const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
                if (stored && list.some((p) => p.id === stored)) setProviderId(stored);
            } catch {
                // No picker; dictation still works on the active plugin.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const transcribe = useCallback(
        async (blob: Blob) => {
            setState('transcribing');
            try {
                const form = new FormData();
                form.append('file', blob, 'dictation.webm');
                if (providerId) form.append('providerId', providerId);
                const res = await fetch('/api/transcription', { method: 'POST', body: form });
                if (res.status === 503) {
                    // No provider configured in this deployment — retire
                    // the control instead of offering a dead button.
                    setUnsupported(true);
                    return;
                }
                if (!res.ok) return;
                const body = (await res.json()) as { text?: string };
                const text = (body.text ?? '').trim();
                if (text) onText(text);
            } catch {
                // Swallow: a failed dictation leaves the composer exactly
                // as the user left it, which is the safe outcome.
            } finally {
                setState('idle');
            }
        },
        [onText, providerId],
    );

    const start = useCallback(async () => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            setUnsupported(true);
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const recorder = new MediaRecorder(stream);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                stopTracks();
                const blob = new Blob(chunksRef.current, {
                    type: recorder.mimeType || 'audio/webm',
                });
                chunksRef.current = [];
                if (blob.size > 0) void transcribe(blob);
                else setState('idle');
            };
            recorderRef.current = recorder;
            recorder.start();
            setState('recording');
        } catch {
            // Permission denied, no input device, or a policy block. All
            // three mean "dictation is not available here" to the user.
            stopTracks();
            setState('idle');
        }
    }, [stopTracks, transcribe]);

    const stop = useCallback(() => {
        recorderRef.current?.stop();
        recorderRef.current = null;
    }, []);

    // Built from the live list so a provider with no drawn brand mark still
    // gets a monogram — `Select` skips the icon column entirely on a miss,
    // which would leave that one row's label out of line with the others.
    // Above the `unsupported` bail so the hook order never changes.
    const providerIcons = useMemo(() => buildDictationProviderIcons(providers), [providers]);

    if (unsupported) return null;

    const label =
        state === 'recording'
            ? t('stop')
            : state === 'transcribing'
              ? t('transcribing')
              : t('start');

    // Only offer a picker when there is something to pick BETWEEN.
    // A select showing one option is pure noise in a composer toolbar.
    const picker =
        providers.length > 1 ? (
            <Select
                size="xs"
                aria-label={t('provider')}
                data-testid="chat-dictation-provider"
                value={providerId ?? ''}
                disabled={disabled || state !== 'idle'}
                onValueChange={(value) => {
                    const next = value || null;
                    setProviderId(next);
                    if (next) window.localStorage.setItem(PROVIDER_STORAGE_KEY, next);
                    else window.localStorage.removeItem(PROVIDER_STORAGE_KEY);
                }}
                iconMap={providerIcons}
                // `size="xs"` is the smallest the shared Select offers (h-8
                // text-xs) and is set on its trigger, which `className` — the
                // container — cannot reach. Reach the trigger directly so the
                // picker matches the 10px composer hint beside it instead of
                // towering over the 28px mic button.
                className="w-28 shrink-0 [&>button]:h-7 [&>button]:text-[10px]"
            >
                {/* Empty value = defer to the activated plugin. */}
                <option value="" data-icon={DICTATION_AUTO_ICON_KEY}>
                    {t('providerAuto')}
                </option>
                {providers.map((p) => (
                    <option key={p.id} value={p.id} data-icon={p.id}>
                        {p.name}
                    </option>
                ))}
            </Select>
        ) : null;

    return (
        <>
            {picker}
            <button
                type="button"
                aria-label={label}
                title={label}
                data-testid="chat-dictation-button"
                data-state={state}
                disabled={disabled || state === 'transcribing'}
                onClick={() => (state === 'recording' ? stop() : void start())}
                className={cn(
                    'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors',
                    state === 'recording'
                        ? 'bg-danger/10 text-danger hover:bg-danger/20'
                        : 'text-text-muted hover:bg-card-hover hover:text-text dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                )}
            >
                {state === 'transcribing' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : state === 'recording' ? (
                    <Square className="h-3 w-3" />
                ) : (
                    <Mic className="h-3.5 w-3.5" />
                )}
            </button>
        </>
    );
}
