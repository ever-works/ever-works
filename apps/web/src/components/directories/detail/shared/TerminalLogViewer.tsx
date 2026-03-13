'use client';

import { cn } from '@/lib/utils/cn';
import { useEffect, useRef } from 'react';
import type { GenerationStepLog } from '@/lib/api/types-only';

interface TerminalLogViewerProps {
    logs: GenerationStepLog[];
    title?: string;
    maxHeight?: string;
    showCursor?: boolean;
    className?: string;
}

const SOURCE_COLORS: Record<string, string> = {
    'claude-code': 'text-violet-400',
    orchestrator: 'text-sky-400',
    pipeline: 'text-teal-400',
    system: 'text-slate-500',
};

const LEVEL_COLORS: Record<string, string> = {
    error: 'text-red-400',
    warn: 'text-amber-400',
    debug: 'text-slate-500',
    info: 'text-emerald-400',
};

function formatTime(timestamp: string): string {
    try {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch {
        return '';
    }
}

function LogLine({ log }: { log: GenerationStepLog }) {
    const time = log.timestamp ? formatTime(log.timestamp) : '';
    const levelColor = LEVEL_COLORS[log.level] ?? LEVEL_COLORS.info;
    const sourceColor = SOURCE_COLORS[log.source] ?? SOURCE_COLORS.system;

    return (
        <div className="flex gap-0 font-mono text-[11px] leading-5 hover:bg-white/3 -mx-4 px-4">
            <span className="text-slate-600 shrink-0 w-17.5">{time}</span>
            <span className={cn('shrink-0 w-22.5 truncate', sourceColor)}>[{log.source}]</span>
            <span className={cn('flex-1 break-all', levelColor)}>{log.message}</span>
            {log.durationMs != null && (
                <span className="shrink-0 ml-2 text-slate-600">{log.durationMs}ms</span>
            )}
        </div>
    );
}

export function TerminalLogViewer({
    logs,
    title,
    maxHeight = 'max-h-64',
    showCursor = false,
    className,
}: TerminalLogViewerProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    return (
        <div
            className={cn(
                'overflow-hidden rounded-lg border border-border dark:border-border-dark',
                className,
            )}
        >
            {/* Title Bar */}
            <div className="flex items-center gap-2 bg-surface-tertiary dark:bg-surface-tertiary-dark px-4 py-2 border-b border-border dark:border-border-dark">
                <div className="flex gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
                </div>
                {title && (
                    <span className="text-[10px] font-medium text-text-muted dark:text-text-muted-dark uppercase tracking-wider ml-1">
                        {title}
                    </span>
                )}
            </div>

            {/* Terminal Body */}
            <div ref={scrollRef} className={cn(maxHeight, 'overflow-y-auto bg-[#0d1117] p-4')}>
                {logs.map((log, i) => (
                    <LogLine key={i} log={log} />
                ))}

                {showCursor && (
                    <div className="flex items-center font-mono text-[11px] leading-5 h-5">
                        <span className="text-emerald-400 animate-pulse">&#9608;</span>
                    </div>
                )}
            </div>
        </div>
    );
}
