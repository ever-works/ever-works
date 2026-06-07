'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { updateKbDocumentAction } from '@/app/actions/works/kb-document';
import { lockKbDocumentAction, unlockKbDocumentAction } from '@/app/actions/works/kb-lock';
import { KbGitHistoryModal } from './KbGitHistoryModal';
import {
    KB_DOCUMENT_CLASSES,
    KB_DOCUMENT_STATUSES,
    KB_LOCK_MODES,
    type KbDocumentClass,
    type KbDocumentDto,
    type KbDocumentStatus,
    type KbLockMode,
} from '@ever-works/contracts';
import { classifyServerError } from '@/lib/kb/use-autosave-status';

/**
 * EW-641 slice B — right-column "Metadata" side panel for the KB
 * workbench. Each field is a self-saving sub-component:
 *
 *  - Class chip selector (PATCH `{ class }` on change)
 *  - Tags chip input (debounced 400ms PATCH `{ tags }`)
 *  - Description textarea (debounced 800ms PATCH `{ description }`)
 *  - Status dropdown (PATCH `{ status }` on change)
 *  - Lock toggle + LockMode select (POST `/lock` or `/unlock`)
 *  - Language input (debounced 800ms PATCH `{ language }`)
 *  - Read-only Source
 *  - Disabled "View Git history" placeholder for slice E
 *
 * Standard error handling: each field surfaces an inline error if the
 * PATCH fails. A 423 (locked) response promotes a panel-wide banner —
 * mirrors the Tiptap editor's locked branch so the operator gets the
 * same signal everywhere.
 */
export interface KbMetadataPanelProps {
    workId: string;
    document: KbDocumentDto;
    onPatched?: (document: KbDocumentDto) => void;
    /** Test seam — override default 400ms tags / 800ms description+language debounce. */
    debounceOverrides?: {
        tagsMs?: number;
        descriptionMs?: number;
        languageMs?: number;
    };
}

const DEFAULT_TAGS_DEBOUNCE_MS = 400;
const DEFAULT_TEXT_DEBOUNCE_MS = 800;

export function KbMetadataPanel({
    workId,
    document,
    onPatched,
    debounceOverrides,
}: KbMetadataPanelProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const tMeta = useTranslations('dashboard.workDetail.kb.workbench.metadata');

    const [current, setCurrent] = useState<KbDocumentDto>(document);
    const [panelLocked, setPanelLocked] = useState(false);

    // When the parent swaps documents (route change), re-seed every
    // field so stale optimistic values don't leak across docs.
    const lastDocIdRef = useRef(document.id);
    useEffect(() => {
        if (lastDocIdRef.current === document.id) return;
        lastDocIdRef.current = document.id;
        setCurrent(document);
        setPanelLocked(false);
    }, [document]);

    const handlePatched = useCallback(
        (next: KbDocumentDto) => {
            setCurrent(next);
            onPatched?.(next);
        },
        [onPatched],
    );

    const onLockedResponse = useCallback(() => {
        setPanelLocked(true);
    }, []);

    const tagsDebounce = debounceOverrides?.tagsMs ?? DEFAULT_TAGS_DEBOUNCE_MS;
    const descriptionDebounce = debounceOverrides?.descriptionMs ?? DEFAULT_TEXT_DEBOUNCE_MS;
    const languageDebounce = debounceOverrides?.languageMs ?? DEFAULT_TEXT_DEBOUNCE_MS;

    return (
        <div
            data-testid="kb-workbench-metadata-panel"
            data-doc-id={current.id}
            className={cn(
                'flex h-full max-h-full min-h-[24rem] flex-col gap-4 overflow-y-auto p-4',
                'text-sm text-text dark:text-text-dark',
            )}
        >
            <header className="flex flex-col gap-1">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark/70">
                    {tMeta('title')}
                </h2>
            </header>

            {panelLocked ? (
                <div
                    data-testid="kb-workbench-metadata-locked-banner"
                    role="status"
                    className={cn(
                        'flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
                        'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
                    )}
                >
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{tMeta('lockedBanner')}</span>
                </div>
            ) : null}

            <ClassField
                workId={workId}
                document={current}
                onPatched={handlePatched}
                onLocked={onLockedResponse}
                labels={{
                    fieldLabel: tMeta('class'),
                    optionLabel: (cls) => t(`classes.${cls}`),
                    saveFailed: tMeta('saveFailed'),
                }}
            />

            <TagsField
                workId={workId}
                document={current}
                debounceMs={tagsDebounce}
                onPatched={handlePatched}
                onLocked={onLockedResponse}
                labels={{
                    label: tMeta('tags.label'),
                    add: tMeta('tags.add'),
                    placeholder: tMeta('tags.placeholder'),
                    remove: (tag) => tMeta('tags.remove', { tag }),
                    saveFailed: tMeta('saveFailed'),
                }}
            />

            <DescriptionField
                workId={workId}
                document={current}
                debounceMs={descriptionDebounce}
                onPatched={handlePatched}
                onLocked={onLockedResponse}
                labels={{
                    label: tMeta('description'),
                    placeholder: tMeta('descriptionPlaceholder'),
                    saveFailed: tMeta('saveFailed'),
                }}
            />

            <StatusField
                workId={workId}
                document={current}
                onPatched={handlePatched}
                onLocked={onLockedResponse}
                labels={{
                    label: tMeta('status'),
                    optionLabel: (status) => tMeta(statusKey(status)),
                    saveFailed: tMeta('saveFailed'),
                }}
            />

            <LockField
                workId={workId}
                document={current}
                onPatched={handlePatched}
                labels={{
                    toggle: tMeta('lock.toggle'),
                    mode: tMeta('lock.mode'),
                    modeFull: tMeta('lock.modeFull'),
                    modeAdditionsOnly: tMeta('lock.modeAdditionsOnly'),
                    saveFailed: tMeta('saveFailed'),
                }}
            />

            <LanguageField
                workId={workId}
                document={current}
                debounceMs={languageDebounce}
                onPatched={handlePatched}
                onLocked={onLockedResponse}
                labels={{
                    label: tMeta('language'),
                    placeholder: tMeta('languagePlaceholder'),
                    saveFailed: tMeta('saveFailed'),
                }}
            />

            <SourceField
                document={current}
                labels={{
                    label: tMeta('source'),
                }}
            />

            <HistoryField workId={workId} document={current} label={tMeta('history')} />
        </div>
    );
}

function statusKey(status: KbDocumentStatus): 'statusActive' | 'statusArchived' | 'statusDraft' {
    switch (status) {
        case 'active':
            return 'statusActive';
        case 'archived':
            return 'statusArchived';
        case 'draft':
            return 'statusDraft';
    }
}

interface FieldErrorState {
    message: string | null;
}

function useInlineError() {
    const [error, setError] = useState<FieldErrorState>({ message: null });
    const set = useCallback((message: string | null) => setError({ message }), []);
    return { error, setError: set };
}

interface SharedFieldArgs {
    workId: string;
    document: KbDocumentDto;
    onPatched: (next: KbDocumentDto) => void;
    onLocked?: () => void;
}

// ---------------------------------------------------------------------------
// Class chip selector
// ---------------------------------------------------------------------------
function ClassField({
    workId,
    document,
    onPatched,
    onLocked,
    labels,
}: SharedFieldArgs & {
    labels: {
        fieldLabel: string;
        optionLabel: (cls: KbDocumentClass) => string;
        saveFailed: string;
    };
}) {
    const { error, setError } = useInlineError();
    const [pending, setPending] = useState(false);

    const onSelect = useCallback(
        async (cls: KbDocumentClass) => {
            if (cls === document.class) return;
            setPending(true);
            setError(null);
            const result = await updateKbDocumentAction({
                workId,
                docId: document.id,
                body: { class: cls },
            });
            setPending(false);
            if (result.success && result.data) {
                onPatched(result.data);
            } else {
                setError(result.error ?? labels.saveFailed);
                if (classifyServerError(result.error) === 'locked') onLocked?.();
            }
        },
        [workId, document.id, document.class, onPatched, setError, onLocked, labels.saveFailed],
    );

    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-class">
            <FieldLabel>{labels.fieldLabel}</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
                {KB_DOCUMENT_CLASSES.map((cls) => {
                    const selected = cls === document.class;
                    return (
                        <button
                            key={cls}
                            type="button"
                            data-testid="kb-workbench-metadata-class-chip"
                            data-kb-class={cls}
                            data-selected={selected ? 'true' : 'false'}
                            disabled={pending}
                            onClick={() => onSelect(cls)}
                            className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                'uppercase tracking-wide transition-colors',
                                selected
                                    ? 'bg-primary text-white dark:bg-primary'
                                    : cn(
                                          'bg-primary/10 text-primary',
                                          'hover:bg-primary/20 dark:bg-primary/20',
                                      ),
                                pending && 'opacity-60',
                            )}
                        >
                            {labels.optionLabel(cls)}
                        </button>
                    );
                })}
            </div>
            <InlineError testId="kb-workbench-metadata-class-error" message={error.message} />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Tags chip input
// ---------------------------------------------------------------------------
function TagsField({
    workId,
    document,
    debounceMs,
    onPatched,
    onLocked,
    labels,
}: SharedFieldArgs & {
    debounceMs: number;
    labels: {
        label: string;
        add: string;
        placeholder: string;
        remove: (tag: string) => string;
        saveFailed: string;
    };
}) {
    const [tags, setTags] = useState<string[]>(document.tags);
    const [input, setInput] = useState('');
    const { error, setError } = useInlineError();
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedRef = useRef<string[]>(document.tags);
    const pendingTagsRef = useRef<string[]>(document.tags);

    // Re-seed on doc swap.
    const docIdRef = useRef(document.id);
    useEffect(() => {
        if (docIdRef.current === document.id) return;
        docIdRef.current = document.id;
        setTags(document.tags);
        lastSavedRef.current = document.tags;
        pendingTagsRef.current = document.tags;
        setInput('');
        setError(null);
    }, [document, setError]);

    const flush = useCallback(async () => {
        const candidate = pendingTagsRef.current;
        if (sameTags(candidate, lastSavedRef.current)) return;
        setError(null);
        const result = await updateKbDocumentAction({
            workId,
            docId: document.id,
            body: { tags: candidate },
        });
        if (result.success && result.data) {
            lastSavedRef.current = result.data.tags;
            onPatched(result.data);
        } else {
            setError(result.error ?? labels.saveFailed);
            if (classifyServerError(result.error) === 'locked') onLocked?.();
        }
    }, [workId, document.id, onPatched, setError, onLocked, labels.saveFailed]);

    const scheduleFlush = useCallback(
        (next: string[]) => {
            pendingTagsRef.current = next;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (debounceMs <= 0) {
                debounceRef.current = null;
                void flush();
                return;
            }
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                void flush();
            }, debounceMs);
        },
        [debounceMs, flush],
    );

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    const addTag = useCallback(
        (raw: string) => {
            const value = raw.trim();
            if (value.length === 0) return;
            setTags((prev) => {
                if (prev.includes(value)) return prev;
                const next = [...prev, value];
                scheduleFlush(next);
                return next;
            });
            setInput('');
        },
        [scheduleFlush],
    );

    const removeTag = useCallback(
        (value: string) => {
            setTags((prev) => {
                const next = prev.filter((t) => t !== value);
                scheduleFlush(next);
                return next;
            });
        },
        [scheduleFlush],
    );

    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-tags">
            <FieldLabel>{labels.label}</FieldLabel>
            <div
                className={cn(
                    'flex flex-wrap items-center gap-1.5 rounded-md border',
                    'border-border dark:border-border-dark',
                    'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5',
                )}
            >
                {tags.map((tag) => (
                    <span
                        key={tag}
                        data-testid="kb-workbench-metadata-tag-chip"
                        data-tag={tag}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-full',
                            'bg-primary/10 text-primary px-2 py-0.5 text-xs',
                        )}
                    >
                        {tag}
                        <button
                            type="button"
                            data-testid="kb-workbench-metadata-tag-remove"
                            data-tag={tag}
                            aria-label={labels.remove(tag)}
                            onClick={() => removeTag(tag)}
                            className="text-primary/70 hover:text-primary"
                        >
                            ×
                        </button>
                    </span>
                ))}
            </div>
            <input
                type="text"
                data-testid="kb-workbench-metadata-tag-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        addTag(input);
                    } else if (e.key === 'Backspace' && input.length === 0 && tags.length > 0) {
                        removeTag(tags[tags.length - 1]);
                    }
                }}
                placeholder={labels.placeholder}
                aria-label={labels.add}
                className={cn(
                    'rounded-md border border-border dark:border-border-dark',
                    'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1 text-xs',
                )}
            />
            <InlineError testId="kb-workbench-metadata-tags-error" message={error.message} />
        </section>
    );
}

function sameTags(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Description autosizing textarea
// ---------------------------------------------------------------------------
function DescriptionField({
    workId,
    document,
    debounceMs,
    onPatched,
    onLocked,
    labels,
}: SharedFieldArgs & {
    debounceMs: number;
    labels: { label: string; placeholder: string; saveFailed: string };
}) {
    const [value, setValue] = useState<string>(document.description ?? '');
    const { error, setError } = useInlineError();
    const lastSavedRef = useRef<string>(document.description ?? '');
    const pendingRef = useRef<string>(document.description ?? '');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const docIdRef = useRef(document.id);
    useEffect(() => {
        if (docIdRef.current === document.id) return;
        docIdRef.current = document.id;
        const next = document.description ?? '';
        setValue(next);
        lastSavedRef.current = next;
        pendingRef.current = next;
        setError(null);
    }, [document, setError]);

    // Autoresize on value change.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }, [value]);

    const flush = useCallback(async () => {
        const candidate = pendingRef.current;
        if (candidate === lastSavedRef.current) return;
        const body = candidate === '' ? null : candidate;
        const result = await updateKbDocumentAction({
            workId,
            docId: document.id,
            body: { description: body },
        });
        if (result.success && result.data) {
            lastSavedRef.current = result.data.description ?? '';
            onPatched(result.data);
        } else {
            setError(result.error ?? labels.saveFailed);
            if (classifyServerError(result.error) === 'locked') onLocked?.();
        }
    }, [workId, document.id, onPatched, setError, onLocked, labels.saveFailed]);

    const schedule = useCallback(
        (next: string) => {
            pendingRef.current = next;
            setError(null);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (debounceMs <= 0) {
                debounceRef.current = null;
                void flush();
                return;
            }
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                void flush();
            }, debounceMs);
        },
        [debounceMs, flush, setError],
    );

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-description">
            <FieldLabel>{labels.label}</FieldLabel>
            <textarea
                ref={textareaRef}
                data-testid="kb-workbench-metadata-description-input"
                value={value}
                rows={2}
                placeholder={labels.placeholder}
                onChange={(e) => {
                    setValue(e.target.value);
                    schedule(e.target.value);
                }}
                className={cn(
                    'resize-none rounded-md border border-border dark:border-border-dark',
                    'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                    'min-h-[3rem]',
                )}
            />
            <InlineError testId="kb-workbench-metadata-description-error" message={error.message} />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Status dropdown
// ---------------------------------------------------------------------------
function StatusField({
    workId,
    document,
    onPatched,
    onLocked,
    labels,
}: SharedFieldArgs & {
    labels: {
        label: string;
        optionLabel: (status: KbDocumentStatus) => string;
        saveFailed: string;
    };
}) {
    const { error, setError } = useInlineError();

    const onChange = useCallback(
        async (status: KbDocumentStatus) => {
            if (status === document.status) return;
            setError(null);
            const result = await updateKbDocumentAction({
                workId,
                docId: document.id,
                body: { status },
            });
            if (result.success && result.data) {
                onPatched(result.data);
            } else {
                setError(result.error ?? labels.saveFailed);
                if (classifyServerError(result.error) === 'locked') onLocked?.();
            }
        },
        [workId, document.id, document.status, onPatched, setError, onLocked, labels.saveFailed],
    );

    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-status">
            <FieldLabel>{labels.label}</FieldLabel>
            <select
                data-testid="kb-workbench-metadata-status-select"
                value={document.status}
                onChange={(e) => void onChange(e.target.value as KbDocumentStatus)}
                className={cn(
                    'rounded-md border border-border dark:border-border-dark',
                    'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                )}
            >
                {KB_DOCUMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                        {labels.optionLabel(status)}
                    </option>
                ))}
            </select>
            <InlineError testId="kb-workbench-metadata-status-error" message={error.message} />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Lock toggle + LockMode
// ---------------------------------------------------------------------------
function LockField({
    workId,
    document,
    onPatched,
    labels,
}: SharedFieldArgs & {
    labels: {
        toggle: string;
        mode: string;
        modeFull: string;
        modeAdditionsOnly: string;
        saveFailed: string;
    };
}) {
    const { error, setError } = useInlineError();
    const [pending, setPending] = useState(false);

    const onToggle = useCallback(
        async (checked: boolean) => {
            setPending(true);
            setError(null);
            const result = checked
                ? await lockKbDocumentAction({
                      workId,
                      docId: document.id,
                      path: document.path,
                      mode: document.lockMode ?? 'full',
                  })
                : await unlockKbDocumentAction({
                      workId,
                      docId: document.id,
                      path: document.path,
                  });
            setPending(false);
            if (result.success && result.data) {
                // The lock action returns a KbDocumentDto (no body) — merge
                // into the panel's current state so dependent fields
                // (status / class) see the freshest backend truth.
                onPatched(result.data);
            } else {
                setError(result.error ?? labels.saveFailed);
            }
        },
        [
            workId,
            document.id,
            document.path,
            document.lockMode,
            onPatched,
            setError,
            labels.saveFailed,
        ],
    );

    const onModeChange = useCallback(
        async (mode: KbLockMode) => {
            if (!document.locked) return;
            setPending(true);
            setError(null);
            const result = await lockKbDocumentAction({
                workId,
                docId: document.id,
                path: document.path,
                mode,
            });
            setPending(false);
            if (result.success && result.data) {
                onPatched(result.data);
            } else {
                setError(result.error ?? labels.saveFailed);
            }
        },
        [
            workId,
            document.id,
            document.path,
            document.locked,
            onPatched,
            setError,
            labels.saveFailed,
        ],
    );

    return (
        <section className="flex flex-col gap-2" data-testid="kb-workbench-metadata-lock">
            <label className="flex items-center justify-between gap-2">
                <FieldLabel>{labels.toggle}</FieldLabel>
                <input
                    type="checkbox"
                    data-testid="kb-workbench-metadata-lock-toggle"
                    checked={document.locked}
                    disabled={pending}
                    onChange={(e) => void onToggle(e.target.checked)}
                    aria-label={labels.toggle}
                />
            </label>
            <div className="flex flex-col gap-1">
                <FieldLabel>{labels.mode}</FieldLabel>
                <select
                    data-testid="kb-workbench-metadata-lock-mode"
                    value={document.lockMode ?? 'full'}
                    disabled={!document.locked || pending}
                    onChange={(e) => void onModeChange(e.target.value as KbLockMode)}
                    className={cn(
                        'rounded-md border border-border dark:border-border-dark',
                        'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                        (!document.locked || pending) && 'opacity-60',
                    )}
                >
                    {KB_LOCK_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                            {mode === 'full' ? labels.modeFull : labels.modeAdditionsOnly}
                        </option>
                    ))}
                </select>
            </div>
            <InlineError testId="kb-workbench-metadata-lock-error" message={error.message} />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Language input
// ---------------------------------------------------------------------------
function LanguageField({
    workId,
    document,
    debounceMs,
    onPatched,
    onLocked,
    labels,
}: SharedFieldArgs & {
    debounceMs: number;
    labels: { label: string; placeholder: string; saveFailed: string };
}) {
    const [value, setValue] = useState<string>(document.language || '');
    const { error, setError } = useInlineError();
    const lastSavedRef = useRef<string>(document.language || '');
    const pendingRef = useRef<string>(document.language || '');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const docIdRef = useRef(document.id);
    useEffect(() => {
        if (docIdRef.current === document.id) return;
        docIdRef.current = document.id;
        const next = document.language || '';
        setValue(next);
        lastSavedRef.current = next;
        pendingRef.current = next;
        setError(null);
    }, [document, setError]);

    const flush = useCallback(async () => {
        const candidate = pendingRef.current.trim();
        if (candidate === lastSavedRef.current) return;
        if (candidate.length < 2) {
            // The backend enforces `Length(2, 8)` — short-circuit and
            // surface a local validation hint instead of round-tripping.
            return;
        }
        const result = await updateKbDocumentAction({
            workId,
            docId: document.id,
            body: { language: candidate },
        });
        if (result.success && result.data) {
            lastSavedRef.current = result.data.language;
            onPatched(result.data);
        } else {
            setError(result.error ?? labels.saveFailed);
            if (classifyServerError(result.error) === 'locked') onLocked?.();
        }
    }, [workId, document.id, onPatched, setError, onLocked, labels.saveFailed]);

    const schedule = useCallback(
        (next: string) => {
            pendingRef.current = next;
            setError(null);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (debounceMs <= 0) {
                debounceRef.current = null;
                void flush();
                return;
            }
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                void flush();
            }, debounceMs);
        },
        [debounceMs, flush, setError],
    );

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-language">
            <FieldLabel>{labels.label}</FieldLabel>
            <input
                type="text"
                data-testid="kb-workbench-metadata-language-input"
                value={value}
                onChange={(e) => {
                    setValue(e.target.value);
                    schedule(e.target.value);
                }}
                placeholder={labels.placeholder}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className={cn(
                    'rounded-md border border-border dark:border-border-dark',
                    'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm font-mono',
                )}
            />
            <InlineError testId="kb-workbench-metadata-language-error" message={error.message} />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Read-only source
// ---------------------------------------------------------------------------
function SourceField({ document, labels }: { document: KbDocumentDto; labels: { label: string } }) {
    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-source">
            <FieldLabel>{labels.label}</FieldLabel>
            <div
                data-testid="kb-workbench-metadata-source-value"
                data-source={document.source}
                className={cn(
                    'rounded-md border border-border dark:border-border-dark',
                    'bg-card/50 dark:bg-card-primary-dark/30 px-2 py-1.5 text-sm capitalize',
                    'text-text-muted dark:text-text-muted-dark/80',
                )}
            >
                {document.source}
            </div>
        </section>
    );
}

// ---------------------------------------------------------------------------
// View Git history — slice E
// ---------------------------------------------------------------------------
function HistoryField({
    workId,
    document,
    label,
}: {
    workId: string;
    document: KbDocumentDto;
    label: string;
}) {
    const [open, setOpen] = useState(false);
    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-workbench-metadata-history">
            <button
                type="button"
                data-testid="kb-workbench-metadata-history-button"
                onClick={() => setOpen(true)}
                className={cn(
                    'rounded-md border border-border dark:border-border-dark',
                    'bg-card/50 dark:bg-card-primary-dark/30 px-2 py-1.5 text-sm',
                    'text-text dark:text-text-dark',
                    'hover:bg-card-hover dark:hover:bg-card-primary-dark/60',
                )}
            >
                {label}
            </button>
            <KbGitHistoryModal
                workId={workId}
                document={document}
                open={open}
                onOpenChange={setOpen}
            />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function FieldLabel({ children }: { children: React.ReactNode }) {
    return (
        <label className="text-[11px] font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark/70">
            {children}
        </label>
    );
}

function InlineError({ testId, message }: { testId: string; message: string | null }) {
    if (!message) return null;
    return (
        <span
            data-testid={testId}
            role="status"
            className="text-[11px] text-red-600 dark:text-red-400"
        >
            {message}
        </span>
    );
}

// Re-export the type to make this file the canonical entry-point.
export type KbMetadataPanelDocument = KbDocumentDto;
