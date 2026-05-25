'use client';

import { ArrowRight, Bot, FolderInput, PenLine } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

/**
 * Phase 6.5 PR CC1 — extracted from `new-work-client.tsx` lines
 * 69-186. Output is byte-identical to the inline definition
 * (Decision A11) — only the file path + reusable surface
 * changed.
 *
 * Why the extraction: the new unified `/new` page (Phase 6.5 PR
 * CC2) needs to render the same three "AI / Manual / Import"
 * mode cards beneath its chip strip, with slightly different
 * labels ("Create Work with AI" vs. the legacy "AI Creation").
 * The optional `labelSet` prop selects between the two — defaults
 * to `'legacy'` so this extraction doesn't change /works/new's
 * render at all. PR CC2 passes `labelSet='unified'` for /new.
 *
 * The component is intentionally presentational — the parent
 * holds the `creationMode` state and decides what to render
 * once the user picks a mode.
 */
export type CreationMode = 'ai' | 'manual' | 'import';

export type CreationBlockLabelSet = 'legacy' | 'unified';

export interface CreationBlockTrioProps {
    onSelect: (mode: CreationMode) => void;
    /**
     * Which i18n bundle to source the labels from:
     *   - `'legacy'` (default) — `dashboard.workCreation.{ai|manual|import}.*`
     *     (the existing /works/new copy)
     *   - `'unified'` — `dashboard.newPage.cards.{ai|manual|import}.*`
     *     (the Phase 6.5 PR CC2 /new copy: "Create Work with AI",
     *     "Create Work Manually", "Import Existing Work")
     */
    labelSet?: CreationBlockLabelSet;
}

export function CreationBlockTrio({ onSelect, labelSet = 'legacy' }: CreationBlockTrioProps) {
    // Two namespaces so the same component can render either copy
    // set without an `if` ladder. The active namespace is selected
    // based on `labelSet`.
    const tLegacy = useTranslations('dashboard.workCreation');
    const tUnified = useTranslations('dashboard.newPage.cards');
    const labels =
        labelSet === 'unified'
            ? {
                  ai: {
                      title: tUnified('ai.title'),
                      subtitle: tUnified('ai.subtitle'),
                      cta: tUnified('ai.cta'),
                  },
                  manual: {
                      title: tUnified('manual.title'),
                      subtitle: tUnified('manual.subtitle'),
                      cta: tUnified('manual.cta'),
                  },
                  import: {
                      title: tUnified('import.title'),
                      subtitle: tUnified('import.subtitle'),
                      cta: tUnified('import.cta'),
                  },
              }
            : {
                  ai: {
                      title: tLegacy('ai.title'),
                      subtitle: tLegacy('ai.subtitle'),
                      cta: tLegacy('ai.getStarted'),
                  },
                  manual: {
                      title: tLegacy('manual.title'),
                      subtitle: tLegacy('manual.subtitle'),
                      cta: tLegacy('manual.configureNow'),
                  },
                  import: {
                      title: tLegacy('import.title'),
                      subtitle: tLegacy('import.subtitle'),
                      cta: tLegacy('import.importNow'),
                  },
              };

    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-6">
            {/* AI Creation Card */}
            <button
                onClick={() => onSelect('ai')}
                className={cn(
                    'rounded-lg p-4 text-left transition-all shadow-sm',
                    'bg-white dark:bg-card-primary-dark',
                    'border border-card-border dark:border-white/9',
                    'hover:border-primary-500/50 dark:hover:border-white/20',
                    'group relative cursor-pointer',
                )}
            >
                <div className="mb-4">
                    <div
                        className={cn(
                            'w-12 h-12 rounded-lg flex items-center justify-center',
                            'bg-gray-100 dark:bg-white/5',
                        )}
                    >
                        <Bot
                            className="w-6 h-6 text-gray-800 dark:text-gray-300"
                            strokeWidth={1.5}
                        />
                    </div>
                </div>
                <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {labels.ai.title}
                </h3>
                <p className="text-text-secondary/50 text-sm dark:text-text-secondary-dark mb-6">
                    {labels.ai.subtitle}
                </p>
                <div className="flex items-center gap-2 bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-full px-3 py-1 text-sm font-medium w-fit">
                    <span>{labels.ai.cta}</span>
                    <ArrowRight
                        className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                        strokeWidth={2}
                    />
                </div>
            </button>

            {/* Manual Creation Card */}
            <button
                onClick={() => onSelect('manual')}
                className={cn(
                    'rounded-lg p-4 text-left transition-all shadow-sm',
                    'bg-white dark:bg-card-primary-dark',
                    'border border-card-border dark:border-white/9',
                    'hover:border-primary-500/50 dark:hover:border-white/20',
                    'group relative cursor-pointer',
                )}
            >
                <div className="mb-4">
                    <div
                        className={cn(
                            'w-12 h-12 rounded-lg flex items-center justify-center',
                            'bg-gray-100 dark:bg-white/5',
                        )}
                    >
                        <PenLine
                            className="w-6 h-6 text-gray-800 dark:text-gray-500"
                            strokeWidth={1.5}
                        />
                    </div>
                </div>
                <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {labels.manual.title}
                </h3>
                <p className="text-text-secondary/50 text-sm dark:text-text-secondary-dark mb-4">
                    {labels.manual.subtitle}
                </p>
                <div className="flex items-center gap-2 bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-full px-3 py-1 text-sm font-medium w-fit">
                    <span>{labels.manual.cta}</span>
                    <ArrowRight
                        className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                        strokeWidth={2}
                    />
                </div>
            </button>

            {/* Import Existing Card */}
            <button
                onClick={() => onSelect('import')}
                className={cn(
                    'rounded-lg p-4 text-left transition-all shadow-sm',
                    'bg-white dark:bg-card-primary-dark',
                    'border border-card-border dark:border-white/9',
                    'hover:border-primary-500/50 dark:hover:border-white/20',
                    'group relative cursor-pointer',
                )}
            >
                <div className="mb-4">
                    <div
                        className={cn(
                            'w-12 h-12 rounded-lg flex items-center justify-center',
                            'bg-gray-100 dark:bg-white/5',
                        )}
                    >
                        <FolderInput
                            className="w-6 h-6 text-gray-800 dark:text-gray-500"
                            strokeWidth={1.5}
                        />
                    </div>
                </div>
                <h3 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {labels.import.title}
                </h3>
                <p className="text-text-secondary/50 text-sm dark:text-text-secondary-dark mb-4">
                    {labels.import.subtitle}
                </p>
                <div className="flex items-center gap-2 bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-white dark:text-black rounded-full px-3 py-1 text-sm font-medium w-fit">
                    <span>{labels.import.cta}</span>
                    <ArrowRight
                        className="w-4 h-4 group-hover:translate-x-1 transition-transform"
                        strokeWidth={2}
                    />
                </div>
            </button>
        </div>
    );
}
