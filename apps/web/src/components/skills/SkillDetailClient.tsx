'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Link2, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Skill, SkillBinding, SkillBindingTargetType } from '@/lib/api/skills';
import {
    createBindingAction,
    deleteBindingAction,
    deleteSkillAction,
    updateSkillAction,
} from '@/app/actions/skills';

const AUTOSAVE_DELAY_MS = 800;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9.4 client.
 *
 * Sectioned scroll: header → body editor → bindings list + add
 * form → danger zone (delete). v1 uses a plain textarea for the
 * body with 800ms autosave + error banner; Tiptap upgrade arrives
 * once the shared KbEditor toolbar is extracted (same posture as
 * the Agent Instructions editor at Phase 5.6).
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
            <Link href={ROUTES.DASHBOARD_SKILLS} className="text-xs text-text-muted hover:text-text">
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
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark mt-1">
                            {skill.title}
                        </h1>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
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
    const [body, setBody] = useState(skill.instructionsMd);
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const dirty = body !== skill.instructionsMd;

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

    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Body</h2>
                <span className="text-xs text-text-muted">
                    {status === 'saving' && '…saving'}
                    {status === 'saved' && '✓ saved'}
                    {status === 'error' && <span className="text-danger">save failed</span>}
                </span>
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
            <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={20}
                spellCheck={false}
                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 font-mono text-xs text-text dark:text-text-dark"
            />
        </section>
    );
}

function BindingsPanel({
    skillId,
    initialBindings,
}: {
    skillId: string;
    initialBindings: SkillBinding[];
}) {
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

    const sorted = useMemo(
        () => [...bindings].sort((a, b) => a.priority - b.priority),
        [bindings],
    );

    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3">
            <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                <Link2 className="w-4 h-4 text-info" />
                Bindings
            </h2>
            {sorted.length === 0 ? (
                <p className="text-xs text-text-muted">No bindings yet. Add one below.</p>
            ) : (
                <ul className="space-y-2">
                    {sorted.map((b) => (
                        <li
                            key={b.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border/40 dark:border-border-dark/40 p-2 text-xs"
                        >
                            <span className="flex items-center gap-2">
                                <span className="uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary">
                                    {b.targetType}
                                </span>
                                {b.targetId && (
                                    <span className="font-mono text-text-muted">
                                        {b.targetId.slice(0, 8)}…
                                    </span>
                                )}
                                <span className="text-text-muted">priority {b.priority}</span>
                                {!b.injectIntoAgent && (
                                    <span className="text-warning">agent: off</span>
                                )}
                                {b.injectIntoGenerator && (
                                    <span className="text-info">generator: on</span>
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => handleDelete(b.id)}
                                className="text-text-muted hover:text-danger"
                                aria-label="Remove binding"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <form
                onSubmit={handleAdd}
                className="grid grid-cols-1 @md/main:grid-cols-[auto_1fr_auto_auto] gap-2 items-end pt-3 border-t border-border/40 dark:border-border-dark/40"
            >
                <div>
                    <label className="block text-[10px] text-text-muted mb-1">Target type</label>
                    <select
                        value={targetType}
                        onChange={(e) => setTargetType(e.target.value as SkillBindingTargetType)}
                        className="rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                    >
                        <option value="tenant">tenant</option>
                        <option value="agent">agent</option>
                        <option value="work">work</option>
                        <option value="mission">mission</option>
                        <option value="idea">idea</option>
                    </select>
                </div>
                <div>
                    <label className="block text-[10px] text-text-muted mb-1">
                        Target ID {targetType === 'tenant' ? '(not needed)' : '(required)'}
                    </label>
                    <input
                        type="text"
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        disabled={targetType === 'tenant'}
                        placeholder={targetType === 'tenant' ? 'auto' : 'uuid'}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs font-mono disabled:opacity-50"
                    />
                </div>
                <div>
                    <label className="block text-[10px] text-text-muted mb-1">Priority</label>
                    <input
                        type="number"
                        value={priority}
                        onChange={(e) => setPriority(parseInt(e.target.value, 10) || 100)}
                        min={1}
                        max={9999}
                        className="w-20 rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                    />
                </div>
                <Button type="submit" size="sm" disabled={pending}>
                    {pending ? '…' : 'Add'}
                </Button>
            </form>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}

function DangerZone({ skillId }: { skillId: string }) {
    const [confirming, setConfirming] = useState(false);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleDelete = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await deleteSkillAction(skillId);
                    window.location.href = '/skills';
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
                    <Button
                        size="sm"
                        onClick={handleDelete}
                        disabled={pending}
                        className="bg-danger text-white hover:bg-danger/90"
                    >
                        {pending ? '…' : 'Confirm delete'}
                    </Button>
                </div>
            ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} className="text-danger">
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
