'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
    type KeyboardEvent,
} from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Send, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createHomeTaskAction, type CreateHomeTaskResult } from '@/app/actions/dashboard/home';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    canSubmitComposer,
    HOME_COMPOSER_CHIP_TTL_MS,
    HOME_COMPOSER_CHIPS_MAX,
    HOME_COMPOSER_COUNTER_FROM_CHARS,
    HOME_COMPOSER_INPUT_ID,
    HOME_COMPOSER_MAX_CHARS,
} from './home.shared';

/** Per-browser unsent draft. Versioned so a future shape change can ignore old values. */
export const HOME_COMPOSER_DRAFT_KEY = 'ew:v1:home:composer-draft';

const MAX_ROWS = 6;

interface ComposerChip {
    id: string;
    title: string;
}

interface HomeComposerProps {
    /** From the dashboard layout's health read; `false` adds the no-runtime note to a success chip. */
    jobRuntimeConfigured?: boolean | null;
    /** Injected for tests; defaults to the Home server action. */
    createTask?: (text: string) => Promise<CreateHomeTaskResult>;
}

function readDraft(): string {
    try {
        return window.localStorage.getItem(HOME_COMPOSER_DRAFT_KEY) ?? '';
    } catch {
        return '';
    }
}

function writeDraft(value: string): void {
    try {
        if (value) window.localStorage.setItem(HOME_COMPOSER_DRAFT_KEY, value);
        else window.localStorage.removeItem(HOME_COMPOSER_DRAFT_KEY);
    } catch {
        // Locked-down browsers throw on storage access; the draft is a convenience.
    }
}

/**
 * Home (AW-19) — one sentence becomes a Task.
 *
 * Works whether or not the morning summary loaded: it depends only on the
 * Task create path. The unsent text is kept per browser and restored; it is
 * never sent anywhere until the user submits. A failed submission keeps the
 * text and returns focus to the field.
 */
export function HomeComposer({
    jobRuntimeConfigured = null,
    createTask = createHomeTaskAction,
}: HomeComposerProps) {
    const t = useTranslations('dashboard.home.composer');
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [failure, setFailure] = useState<'failed' | 'throttled' | null>(null);
    const [chips, setChips] = useState<ComposerChip[]>([]);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    // Restored after mount, never during render: browser storage does not
    // exist on the server, so reading it while rendering would make the
    // server HTML and the hydrated field disagree.
    useEffect(() => {
        const draft = readDraft();
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: the stored draft is only knowable after mount.
        if (draft) setText(draft.slice(0, HOME_COMPOSER_MAX_CHARS));
    }, []);

    useEffect(() => {
        const pending = timers.current;
        return () => {
            for (const timer of pending.values()) clearTimeout(timer);
            pending.clear();
        };
    }, []);

    // A failed submission hands focus back to the field. Done after the commit
    // that re-enables it — focusing a still-disabled field is silently ignored.
    useEffect(() => {
        if (failure && !sending) inputRef.current?.focus();
    }, [failure, sending]);

    // Auto-grow from one row to at most six.
    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = 'auto';
        const lineHeight = Number.parseFloat(window.getComputedStyle(input).lineHeight) || 20;
        const padding = input.offsetHeight - input.clientHeight;
        const maxHeight = lineHeight * MAX_ROWS + Math.max(0, padding);
        if (input.scrollHeight > 0) {
            input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
        }
    }, [text]);

    const dismissChip = useCallback((id: string) => {
        setChips((current) => current.filter((chip) => chip.id !== id));
        const timer = timers.current.get(id);
        if (timer) clearTimeout(timer);
        timers.current.delete(id);
    }, []);

    const submit = useCallback(
        async (value: string) => {
            if (sending || !canSubmitComposer(value)) return;
            setSending(true);
            setFailure(null);
            setText('');
            let result: CreateHomeTaskResult;
            try {
                result = await createTask(value);
            } catch {
                result = { ok: false, reason: 'failed' };
            }
            setSending(false);
            if (result.ok) {
                writeDraft('');
                const chip = { id: result.task.id, title: result.task.title };
                setChips((current) =>
                    [chip, ...current.filter((existing) => existing.id !== chip.id)].slice(
                        0,
                        HOME_COMPOSER_CHIPS_MAX,
                    ),
                );
                const timer = setTimeout(() => dismissChip(chip.id), HOME_COMPOSER_CHIP_TTL_MS);
                timers.current.set(chip.id, timer);
                return;
            }
            setText(value);
            setFailure(result.reason === 'throttled' ? 'throttled' : 'failed');
        },
        [createTask, dismissChip, sending],
    );

    const onChange = (value: string) => {
        const next = value.slice(0, HOME_COMPOSER_MAX_CHARS);
        setText(next);
        writeDraft(next);
        if (failure) setFailure(null);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.blur();
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit(text);
        }
    };

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        void submit(text);
    };

    const length = text.length;
    const showCounter = length >= HOME_COMPOSER_COUNTER_FROM_CHARS;
    const canSend = !sending && canSubmitComposer(text);

    return (
        <div className="mb-6" data-testid="home-composer">
            <form onSubmit={onSubmit} className="flex items-start gap-2">
                <label htmlFor={HOME_COMPOSER_INPUT_ID} className="sr-only">
                    {t('label')}
                </label>
                <textarea
                    ref={inputRef}
                    id={HOME_COMPOSER_INPUT_ID}
                    rows={1}
                    value={text}
                    maxLength={HOME_COMPOSER_MAX_CHARS}
                    disabled={sending}
                    placeholder={t('placeholder')}
                    aria-describedby="home-composer-hint"
                    aria-invalid={failure ? true : undefined}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={onKeyDown}
                    className={cn(
                        'min-h-10 flex-1 resize-none rounded-lg border border-card-border dark:border-white/10 bg-card dark:bg-card-primary-dark px-3 py-2 text-sm leading-5 text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                        'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60',
                    )}
                />
                <button
                    type="submit"
                    disabled={!canSend}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-white/90"
                >
                    {sending ? (
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                    ) : (
                        <Send aria-hidden="true" className="h-4 w-4" />
                    )}
                    {sending ? t('sending') : t('send')}
                </button>
            </form>

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted dark:text-text-muted-dark">
                <p id="home-composer-hint">{t('hint')}</p>
                {showCounter ? (
                    <p data-testid="home-composer-counter" className="tabular-nums">
                        {t('counter', { used: length, max: HOME_COMPOSER_MAX_CHARS })}
                    </p>
                ) : null}
            </div>

            {failure ? (
                <div
                    role="alert"
                    data-testid="home-composer-error"
                    className="mt-2 flex flex-wrap items-center gap-2 text-sm text-danger"
                >
                    <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span>{failure === 'throttled' ? t('throttled') : t('failed')}</span>
                    {failure === 'failed' ? (
                        <button
                            type="button"
                            onClick={() => void submit(text)}
                            className="rounded-md px-1.5 py-0.5 font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                            {t('retry')}
                        </button>
                    ) : null}
                </div>
            ) : null}

            {chips.length > 0 ? (
                <ul aria-live="polite" className="mt-2 space-y-1" data-testid="home-composer-chips">
                    {chips.map((chip) => (
                        <li
                            key={chip.id}
                            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text dark:text-text-dark"
                        >
                            <CheckCircle2
                                aria-hidden="true"
                                className="h-4 w-4 shrink-0 text-success"
                            />
                            <span className="min-w-0 truncate">
                                {t('created', { title: chip.title })}
                            </span>
                            <Link
                                href={ROUTES.DASHBOARD_TASK(chip.id)}
                                className="font-medium text-primary hover:underline"
                            >
                                {t('open')}
                            </Link>
                            {jobRuntimeConfigured === false ? (
                                <span className="basis-full text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {t('noRuntime')}{' '}
                                    <Link
                                        href={ROUTES.DASHBOARD_SETTINGS_JOB_RUNTIME}
                                        className="font-medium text-primary hover:underline"
                                    >
                                        {t('configure')}
                                    </Link>
                                </span>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => dismissChip(chip.id)}
                                aria-label={t('dismiss')}
                                className="rounded p-0.5 text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            >
                                <X aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
