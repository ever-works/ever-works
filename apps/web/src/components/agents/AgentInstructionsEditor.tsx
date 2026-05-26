'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { writeAgentFileAction } from '@/app/actions/agents';
import type { AgentFileBody, AgentFileName } from '@/lib/api/agents';

const AUTOSAVE_DELAY_MS = 800;

type Status = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5.6. 5-pill instructions
 * editor. Tabs across the 5 canonical files. Each pill keeps a
 * working buffer + the last-confirmed hash; PUT goes out 800ms
 * after the last keystroke, carrying `expectedHash` so a
 * concurrent edit elsewhere surfaces as a CONFLICT banner that
 * tells the user to refresh.
 *
 * v1 uses textarea — Tiptap reuse of `KbEditor.tsx` lands in a
 * later sub-tick once the shared editor toolbar is extracted.
 */
export function AgentInstructionsEditor({
    agentId,
    files,
}: {
    agentId: string;
    files: AgentFileBody[];
}) {
    const initialMap = useMemo(() => {
        const map: Record<AgentFileName, AgentFileBody> = {} as Record<
            AgentFileName,
            AgentFileBody
        >;
        for (const f of files) map[f.name] = f;
        return map;
    }, [files]);

    const [active, setActive] = useState<AgentFileName>('SOUL.md');
    const [buffers, setBuffers] = useState<Record<AgentFileName, string>>(() => {
        const b: Record<AgentFileName, string> = {} as Record<AgentFileName, string>;
        for (const f of files) b[f.name] = f.body;
        return b;
    });
    const [hashes, setHashes] = useState<Record<AgentFileName, string>>(() => {
        const h: Record<AgentFileName, string> = {} as Record<AgentFileName, string>;
        for (const f of files) h[f.name] = f.hash;
        return h;
    });
    const [status, setStatus] = useState<Record<AgentFileName, Status>>(() => {
        const s: Record<AgentFileName, Status> = {} as Record<AgentFileName, Status>;
        for (const f of files) s[f.name] = 'idle';
        return s;
    });

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const activeBody = buffers[active] ?? '';
    const activeStatus = status[active] ?? 'idle';
    // Review-fix I15: drop the `activeBody !== ''` clause. Previously
    // an intentional clear (e.g. user erasing HEARTBEAT.md to reset
    // the heartbeat preamble) couldn't be saved because the dirty
    // flag was false. Empty bodies are valid — the 64KB cap is an
    // upper bound, not a lower one.
    const dirty = activeBody !== (initialMap[active]?.body ?? '');

    useEffect(() => {
        if (!dirty) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            void persist(active, activeBody);
        }, AUTOSAVE_DELAY_MS);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeBody, active]);

    async function persist(name: AgentFileName, body: string) {
        setStatus((s) => ({ ...s, [name]: 'saving' }));
        try {
            const { newHash } = await writeAgentFileAction(agentId, name, body, hashes[name]);
            setHashes((h) => ({ ...h, [name]: newHash }));
            setStatus((s) => ({ ...s, [name]: 'saved' }));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStatus((s) => ({ ...s, [name]: /etag/i.test(msg) ? 'conflict' : 'error' }));
        }
    }

    const FILE_TABS: AgentFileName[] = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'];

    return (
        <div className="p-6 space-y-4 max-w-screen-2xl mx-auto">
            <div className="flex items-center gap-2 flex-wrap">
                {FILE_TABS.map((name) => {
                    const isActive = active === name;
                    const s = status[name] ?? 'idle';
                    return (
                        <button
                            key={name}
                            type="button"
                            onClick={() => setActive(name)}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                                isActive
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark'
                            }`}
                        >
                            <span>{name}</span>
                            {s === 'saving' && <span className="ml-1 opacity-60">…</span>}
                            {s === 'saved' && <span className="ml-1 text-success">✓</span>}
                            {s === 'conflict' && <span className="ml-1 text-warning">!</span>}
                            {s === 'error' && <span className="ml-1 text-danger">×</span>}
                        </button>
                    );
                })}
            </div>

            {activeStatus === 'conflict' && (
                <div
                    role="alert"
                    className="rounded-md border border-warning/40 bg-warning/10 text-warning text-xs px-3 py-2"
                >
                    Another edit happened in parallel. Refresh to load the latest version, then re-apply your change.
                </div>
            )}
            {activeStatus === 'error' && (
                <div
                    role="alert"
                    className="rounded-md border border-danger/40 bg-danger/10 text-danger text-xs px-3 py-2"
                >
                    Save failed. Check your secret-scan, size cap (64 KB), or network and try again.
                </div>
            )}

            <textarea
                value={activeBody}
                onChange={(e) =>
                    setBuffers((b) => ({ ...b, [active]: e.target.value }))
                }
                className="w-full min-h-[480px] rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-4 font-mono text-xs text-text dark:text-text-dark"
                spellCheck={false}
                aria-label={active}
            />
        </div>
    );
}
