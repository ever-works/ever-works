'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useCanvas } from './CanvasProvider';
import { CanvasArtifactView } from './CanvasArtifactView';

/**
 * Slide-over canvas panel. Mounted once inside the chat; renders the active
 * artifact and a tab strip when more than one artifact has been produced in
 * the session. Viewport-fixed so it gives the agent a roomy working surface
 * regardless of how narrow the chat column is.
 */
export function CanvasOverlay() {
    const { artifacts, activeId, isOpen, focus, close } = useCanvas();

    if (!isOpen || artifacts.length === 0) return null;

    const active = artifacts.find((a) => a.id === activeId) ?? artifacts[artifacts.length - 1];

    return (
        <>
            <div
                className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px] md:hidden"
                onClick={close}
                aria-hidden
            />
            <aside
                className={cn(
                    'fixed right-0 top-0 z-50 flex h-full w-[min(560px,92vw)] flex-col',
                    'border-l border-border bg-surface shadow-2xl',
                    'dark:border-border-dark dark:bg-surface-dark',
                )}
                role="complementary"
                aria-label="Canvas"
            >
                <header className="flex items-center justify-between border-b border-border px-4 py-3 dark:border-border-dark">
                    <h2 className="truncate text-sm font-semibold text-text dark:text-text-dark">
                        {active.title}
                    </h2>
                    <button
                        onClick={close}
                        aria-label="Close canvas"
                        className="rounded-md p-1 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                    >
                        <X className="h-4 w-4 text-text-muted dark:text-text-muted-dark" />
                    </button>
                </header>

                {artifacts.length > 1 && (
                    <nav className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 dark:border-border-dark">
                        {artifacts.map((a) => (
                            <button
                                key={a.id}
                                onClick={() => focus(a.id)}
                                className={cn(
                                    'whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] transition-colors',
                                    a.id === active.id
                                        ? 'bg-primary text-white'
                                        : 'bg-surface-secondary text-text-muted dark:bg-surface-secondary-dark dark:text-text-muted-dark',
                                )}
                            >
                                {a.title}
                            </button>
                        ))}
                    </nav>
                )}

                <div className="flex-1 overflow-auto p-4">
                    {active.description ? (
                        <p className="mb-3 text-xs text-text-muted dark:text-text-muted-dark">
                            {active.description}
                        </p>
                    ) : null}
                    <CanvasArtifactView artifact={active} />
                </div>
            </aside>
        </>
    );
}
