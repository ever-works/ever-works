'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import {
    Bot,
    Briefcase,
    Building2,
    Check,
    ChevronDown,
    Eye,
    FileText,
    Lightbulb,
    Link2,
    Pencil,
    Plus,
    Search,
    Sparkles,
    Target,
    Trash2,
    type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill, SkillBinding, SkillBindingTargetType } from '@/lib/api/skills';
import {
    createBindingAction,
    deleteBindingAction,
    deleteSkillAction,
    loadBindingTargetOptionsAction,
    updateSkillAction,
} from '@/app/actions/skills';

const AUTOSAVE_DELAY_MS = 800;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// react-markdown + remark-gfm is ~50KB gzipped; only load it when a user
// actually opens the Preview tab. The chunk is shared with the items
// MarkdownBodyField and ChatMarkdown.
const MarkdownPreview = dynamic(
    () =>
        import('@/components/works/detail/items/MarkdownPreview').then((m) => m.MarkdownPreview),
    { ssr: false },
);

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9.4 client.
 *
 * Sectioned scroll: header → body editor → bindings list + add
 * form → danger zone (delete). The body is a Write/Preview markdown
 * editor: a plain textarea with 800ms autosave + error banner, plus
 * a rendered preview tab reusing the shared lazy-loaded
 * MarkdownPreview. Tiptap upgrade arrives once the shared KbEditor
 * toolbar is extracted (same posture as the Agent Instructions
 * editor at Phase 5.6).
 */
export function SkillDetailClient({
    skill,
    initialBindings,
}: {
    skill: Skill;
    initialBindings: SkillBinding[];
}) {
    return (
        <div className="max-w-screen-2xl mx-auto p-6 space-y-6">
            <Link
                href={ROUTES.DASHBOARD_SKILLS}
                className="text-xs text-text-muted hover:text-text"
            >
                ← Skills
            </Link>
            <header className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-success/10 border border-success/20 flex items-center justify-center">
                        <Sparkles className="w-4 h-4 text-success" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[11px] text-text-muted font-mono">
                            <span>{skill.slug}</span>
                            <span>·</span>
                            <span className="uppercase tracking-wide">{skill.ownerType}</span>
                            <span>·</span>
                            <span>v{skill.version}</span>
                        </div>
                        <h1 className="text-xl font-semibold text-text dark:text-text-dark mt-1">
                            {skill.title}
                        </h1>
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-1">
                            {skill.description}
                        </p>
                    </div>
                </div>
            </header>

            <BodyEditor skill={skill} />
            <BindingsPanel skillId={skill.id} initialBindings={initialBindings} />
            <DangerZone skillId={skill.id} />
        </div>
    );
}

function BodyEditor({ skill }: { skill: Skill }) {
    const t = useTranslations('dashboard.skillsPage.detail');
    const [body, setBody] = useState(skill.instructionsMd);
    const [mode, setMode] = useState<'write' | 'preview'>('write');
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // Click-to-edit: clicking the rendered preview flips back to Write
    // and drops the caret into the textarea once it has re-rendered.
    const focusPendingRef = useRef(false);

    const dirty = body !== skill.instructionsMd;

    useEffect(() => {
        if (mode === 'write' && focusPendingRef.current) {
            focusPendingRef.current = false;
            textareaRef.current?.focus();
        }
    }, [mode]);

    useEffect(() => {
        if (!dirty) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            void persist(body);
        }, AUTOSAVE_DELAY_MS);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [body]);

    async function persist(next: string) {
        setStatus('saving');
        setError(null);
        try {
            await updateSkillAction(skill.id, { instructionsMd: next });
            setStatus('saved');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Save failed');
            setStatus('error');
        }
    }

    const wordCount = useMemo(() => {
        const trimmed = body.trim();
        return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
    }, [body]);

    const tabClass = (selected: boolean) =>
        `inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors ${
            selected
                ? 'border-border-secondary dark:border-border-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark font-medium text-text dark:text-text-dark'
                : 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-border dark:hover:border-border-dark'
        }`;

    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <FileText className="w-4 h-4 text-success" />
                    {t('instructions')}
                </h2>
                <div className="flex items-center gap-3">
                    <span className="text-[11px] text-text-muted" aria-live="polite">
                        {status === 'saving' && t('body.saving')}
                        {status === 'saved' && t('body.saved')}
                        {status === 'error' && (
                            <span className="text-danger">{t('body.saveFailed')}</span>
                        )}
                    </span>
                    <div role="tablist" aria-label={t('instructions')} className="flex gap-1.5">
                        <button
                            id="skill-body-tab-write"
                            type="button"
                            role="tab"
                            aria-selected={mode === 'write'}
                            aria-controls="skill-body-panel-write"
                            onClick={() => setMode('write')}
                            className={tabClass(mode === 'write')}
                        >
                            <Pencil className="w-3 h-3" />
                            {t('body.write')}
                        </button>
                        <button
                            id="skill-body-tab-preview"
                            type="button"
                            role="tab"
                            aria-selected={mode === 'preview'}
                            aria-controls="skill-body-panel-preview"
                            onClick={() => setMode('preview')}
                            className={tabClass(mode === 'preview')}
                        >
                            <Eye className="w-3 h-3" />
                            {t('body.preview')}
                        </button>
                    </div>
                </div>
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
            {mode === 'write' ? (
                <div
                    id="skill-body-panel-write"
                    role="tabpanel"
                    aria-labelledby="skill-body-tab-write"
                >
                    <Textarea
                        ref={textareaRef}
                        variant="form"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={20}
                        spellCheck={false}
                        placeholder={t('body.placeholder')}
                        className="p-3 font-mono text-xs resize-y leading-relaxed"
                    />
                </div>
            ) : (
                <div
                    id="skill-body-panel-preview"
                    role="tabpanel"
                    aria-labelledby="skill-body-tab-preview"
                    title={t('body.clickToEdit')}
                    onClick={(e) => {
                        // Let links in the rendered markdown behave as links.
                        if ((e.target as HTMLElement).closest('a')) return;
                        focusPendingRef.current = true;
                        setMode('write');
                    }}
                    className="rounded-lg border border-border/40 dark:border-border-dark/40 bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 px-4 py-3 min-h-40 max-h-128 overflow-auto cursor-text hover:border-border dark:hover:border-border-dark transition-colors"
                >
                    {body.trim().length > 0 ? (
                        <MarkdownPreview content={body} />
                    ) : (
                        <p className="text-xs text-text-muted">{t('body.emptyPreview')}</p>
                    )}
                </div>
            )}
            <div className="flex items-center justify-between gap-3 text-[11px] text-text-muted pt-1 border-t border-border/40 dark:border-border-dark/40">
                <span>{t('body.markdownHint')}</span>
                <span>
                    {t('body.words', { count: wordCount })} ·{' '}
                    {t('body.characters', { count: body.length })}
                </span>
            </div>
        </section>
    );
}

// Icon per binding target type — badges stay neutral (surface tokens) so the
// panel reads calmly next to the colored priority/injection pills.
const TARGET_TYPE_ICONS: Record<SkillBindingTargetType, LucideIcon> = {
    tenant: Building2,
    agent: Bot,
    work: Briefcase,
    mission: Target,
    idea: Lightbulb,
};

function BindingsPanel({
    skillId,
    initialBindings,
}: {
    skillId: string;
    initialBindings: SkillBinding[];
}) {
    const t = useTranslations('dashboard.skillsPage.detail');
    const [bindings, setBindings] = useState(initialBindings);
    const [targetType, setTargetType] = useState<SkillBindingTargetType>('tenant');
    const [targetId, setTargetId] = useState('');
    const [priority, setPriority] = useState(100);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleAdd = (e: React.FormEvent) => {
        e.preventDefault();
        if (targetType !== 'tenant' && !targetId.trim()) {
            setError('targetId is required for non-tenant scopes.');
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const created = await createBindingAction(skillId, {
                        targetType,
                        targetId: targetType === 'tenant' ? null : targetId.trim(),
                        priority,
                    });
                    setBindings((prev) => [...prev, created]);
                    setTargetId('');
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Bind failed');
                }
            })();
        });
    };

    const handleDelete = (bindingId: string) => {
        const before = bindings;
        setBindings((prev) => prev.filter((b) => b.id !== bindingId));
        void (async () => {
            try {
                await deleteBindingAction(bindingId);
            } catch (err) {
                setBindings(before);
                setError(err instanceof Error ? err.message : 'Unbind failed');
            }
        })();
    };

    const sorted = useMemo(() => [...bindings].sort((a, b) => a.priority - b.priority), [bindings]);

    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3">
            <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <Link2 className="w-4 h-4 text-info" />
                    {t('bindings')}
                </h2>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                    {sorted.length}
                </span>
            </div>
            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                {t('bindingHelper')}
            </p>
            {sorted.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 dark:border-border-dark/60 px-4 py-6 text-center">
                    <p className="text-xs text-text-muted">{t('noBindings')}</p>
                </div>
            ) : (
                <ul className="space-y-2">
                    {sorted.map((b) => {
                        const TypeIcon = TARGET_TYPE_ICONS[b.targetType];
                        return (
                            <li
                                key={b.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 dark:border-border-dark/40 bg-surface-secondary/30 dark:bg-surface-secondary-dark/30 px-3 py-2 text-xs"
                            >
                                <span className="flex items-center gap-2 min-w-0 flex-wrap">
                                    <span className="inline-flex items-center gap-1 uppercase tracking-wide text-[10px] font-medium px-1.5 py-0.5 rounded-md border border-border/40 dark:border-border-dark/40 bg-card dark:bg-card-primary-dark text-text-secondary dark:text-text-secondary-dark">
                                        <TypeIcon className="w-3 h-3" />
                                        {t(b.targetType)}
                                    </span>
                                    {b.targetId && (
                                        <span className="font-mono text-[11px] text-text-muted">
                                            {b.targetId.slice(0, 8)}…
                                        </span>
                                    )}
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-info/10 text-info border border-info/20">
                                        {t('priority')} {b.priority}
                                    </span>
                                    {!b.injectIntoAgent && (
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-warning/10 text-warning border border-warning/20">
                                            {t('agentOff')}
                                        </span>
                                    )}
                                    {b.injectIntoGenerator && (
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-success/10 text-success border border-success/20">
                                            {t('generatorOn')}
                                        </span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => handleDelete(b.id)}
                                    className="shrink-0 p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                                    aria-label={t('removeBinding')}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="pt-3 border-t border-border/40 dark:border-border-dark/40 space-y-2">
                <h3 className="text-xs font-medium text-text dark:text-text-dark">
                    {t('addBindingTitle')}
                </h3>
                <form
                    onSubmit={handleAdd}
                    className="grid grid-cols-1 @md/main:grid-cols-[auto_1fr_auto_auto] gap-2 items-end"
                >
                    <div>
                        <label
                            htmlFor="skill-binding-target-type"
                            className="block text-[11px] text-text-secondary dark:text-text-secondary-dark mb-1"
                        >
                            {t('targetType')}
                        </label>
                        <Select
                            id="skill-binding-target-type"
                            size="xs"
                            value={targetType}
                            onValueChange={(v) => setTargetType(v as SkillBindingTargetType)}
                            className="w-32"
                        >
                            <option value="tenant">{t('tenant')}</option>
                            <option value="agent">{t('agent')}</option>
                            <option value="work">{t('work')}</option>
                            <option value="mission">{t('mission')}</option>
                            <option value="idea">{t('idea')}</option>
                        </Select>
                    </div>
                    <div>
                        <label className="block text-[11px] text-text-secondary dark:text-text-secondary-dark mb-1">
                            {t('target')}
                        </label>
                        <SkillBindingTargetPicker
                            targetType={targetType}
                            value={targetId}
                            onChange={setTargetId}
                        />
                    </div>
                    <div>
                        <label
                            htmlFor="skill-binding-priority"
                            className="block text-[11px] text-text-secondary dark:text-text-secondary-dark mb-1"
                        >
                            {t('priority')}
                        </label>
                        <Input
                            id="skill-binding-priority"
                            variant="form"
                            type="number"
                            value={priority}
                            onChange={(e) => setPriority(parseInt(e.target.value, 10) || 100)}
                            min={1}
                            max={9999}
                            className="w-24 h-8 px-2 text-xs"
                        />
                    </div>
                    <Button type="submit" size="sm" disabled={pending}>
                        <Plus className="w-3.5 h-3.5 mr-1" />
                        {pending ? t('adding') : t('add')}
                    </Button>
                </form>
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}

/**
 * FU-8 — searchable target picker. Replaces the raw UUID textbox with
 * a combobox that loads the user's own entities for the chosen
 * targetType: one input that shows the selected option and filters
 * the dropdown as you type (arrow keys + Enter to pick, Escape to
 * close). Tenant scope auto-fills (no picker needed); agent /
 * mission / idea / work load via the existing list endpoints.
 *
 * Falls back to a plain text input when the list endpoint isn't
 * available or returns nothing — operators with paginated lists
 * larger than the first page can still paste a UUID directly.
 */
function SkillBindingTargetPicker({
    targetType,
    value,
    onChange,
}: {
    targetType: SkillBindingTargetType;
    value: string;
    onChange: (v: string) => void;
}) {
    type Option = { id: string; label: string };
    const t = useTranslations('dashboard.skillsPage.detail.picker');
    const [options, setOptions] = useState<Option[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const listRef = useRef<HTMLUListElement | null>(null);
    // FU-8 review fix (greptile P2): stash `onChange` in a ref so the
    // effect doesn't re-fire (or worse, infinite-loop) when a parent
    // passes an inline arrow function. The effect should only re-run
    // on `targetType` changes — the callback identity is incidental.
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        setOpen(false);
        setQuery('');
        setActiveIndex(0);
        if (targetType === 'tenant') {
            setOptions([]);
            onChangeRef.current('');
            return;
        }
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        void (async () => {
            try {
                // FU-8 post-CI fix: route through a server action
                // instead of importing the server-only API clients
                // (`agentsAPI` / `missionsAPI` / `workProposalsAPI` /
                // `workAPI`) directly. Importing them here pulls
                // `import 'server-only'` into the client bundle and
                // breaks the Next.js build.
                const next = await loadBindingTargetOptionsAction(targetType);
                if (!cancelled) setOptions(next);
            } catch (err) {
                if (!cancelled) {
                    setLoadError(err instanceof Error ? err.message : 'Failed to load options');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [targetType]);

    // Keep the keyboard-highlighted option visible while arrowing
    // through a list longer than the dropdown's max height.
    useEffect(() => {
        listRef.current
            ?.querySelector('[data-active="true"]')
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex, open]);

    if (targetType === 'tenant') {
        return (
            <div className="flex items-center gap-1.5 h-8 px-2 rounded-lg border border-border/40 dark:border-border-dark/40 bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-xs text-text-muted">
                <Building2 className="w-3.5 h-3.5 shrink-0" />
                {t('workspaceWide')}
            </div>
        );
    }

    if (loadError || (!loading && options.length === 0)) {
        return (
            <Input
                variant="form"
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={loadError ? t('pasteUuid') : t('noOptionsPasteUuid')}
                autoComplete="off"
                spellCheck={false}
                className="h-8 px-2 text-xs font-mono"
                data-testid="skill-binding-target-picker"
            />
        );
    }

    const normalized = query.trim().toLowerCase();
    const filtered =
        normalized.length === 0
            ? options
            : options.filter((o) => o.label.toLowerCase().includes(normalized));
    const selected = options.find((o) => o.id === value);

    const select = (o: Option) => {
        onChange(o.id);
        setOpen(false);
        setQuery('');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            if (open && filtered[activeIndex]) {
                e.preventDefault();
                select(filtered[activeIndex]);
            }
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    return (
        <div
            className="relative"
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
            }}
        >
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
            <Input
                variant="form"
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="skill-binding-target-listbox"
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
                value={open ? query : (selected?.label ?? '')}
                onFocus={() => {
                    setOpen(true);
                    setQuery('');
                    setActiveIndex(0);
                }}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                    setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder={selected ? selected.label : t('searchPlaceholder')}
                className="h-8 pl-7 pr-7 text-xs"
                data-testid="skill-binding-target-picker"
            />
            <ChevronDown
                className={`absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none transition-transform ${open ? 'rotate-180' : ''}`}
            />
            {open && (
                <ul
                    id="skill-binding-target-listbox"
                    role="listbox"
                    ref={listRef}
                    className="absolute z-50 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark shadow-lg p-1"
                >
                    {loading ? (
                        <li className="px-2 py-1.5 text-xs text-text-muted">{t('loading')}</li>
                    ) : filtered.length === 0 ? (
                        <li className="px-2 py-1.5 text-xs text-text-muted">{t('noMatches')}</li>
                    ) : (
                        filtered.map((o, i) => (
                            <li key={o.id} role="option" aria-selected={o.id === value}>
                                <button
                                    type="button"
                                    data-active={i === activeIndex}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => select(o)}
                                    onMouseEnter={() => setActiveIndex(i)}
                                    className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${
                                        i === activeIndex
                                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                                            : 'text-text-secondary dark:text-text-secondary-dark'
                                    }`}
                                >
                                    <span className="truncate">{o.label}</span>
                                    {o.id === value && (
                                        <Check className="w-3.5 h-3.5 shrink-0 text-success" />
                                    )}
                                </button>
                            </li>
                        ))
                    )}
                </ul>
            )}
        </div>
    );
}

function DangerZone({ skillId }: { skillId: string }) {
    const [confirming, setConfirming] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    // Review-fix I14: use next-intl router so the post-delete redirect
    // preserves the user's locale prefix (`/fr/skills/abc` previously
    // bounced to `/skills` losing locale + triggering a hard reload).
    const router = useRouter();

    const handleDelete = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await deleteSkillAction(skillId);
                    router.push(ROUTES.DASHBOARD_SKILLS);
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Delete failed');
                    setConfirming(false);
                }
            })();
        });
    };

    return (
        <section className="rounded-xl border border-danger/30 bg-danger/5 p-5 space-y-3">
            <h2 className="text-sm font-medium text-danger">Danger zone</h2>
            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                Deleting a Skill removes it permanently. Bindings cascade automatically.
            </p>
            {confirming ? (
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming(false)}
                        disabled={pending}
                    >
                        Cancel
                    </Button>
                    <Button size="sm" variant="danger" onClick={handleDelete} disabled={pending}>
                        {pending ? '…' : 'Confirm delete'}
                    </Button>
                </div>
            ) : (
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirming(true)}
                    className="text-danger"
                >
                    Delete this Skill
                </Button>
            )}
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
