'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

interface WorkspaceSectionProps {
    children: ReactNode;
    /** Whether the section starts open. */
    defaultExpanded?: boolean;
}

/**
 * Home (AW-19) — `Your workspace`: everything Home showed before the morning
 * read, gathered under one heading and rendered exactly as it was. Collapsing
 * hides it without unmounting it, so nothing inside loses its state.
 */
export function WorkspaceSection({ children, defaultExpanded = true }: WorkspaceSectionProps) {
    const t = useTranslations('dashboard.home.workspace');
    const [expanded, setExpanded] = useState(defaultExpanded);
    const regionId = useId();

    return (
        <section
            aria-labelledby={`${regionId}-heading`}
            className="mt-10"
            data-testid="home-workspace"
        >
            <h2
                id={`${regionId}-heading`}
                className="text-lg font-semibold text-text dark:text-text-dark"
            >
                <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={regionId}
                    onClick={() => setExpanded((value) => !value)}
                    className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                    <ChevronDown
                        aria-hidden="true"
                        className={cn('h-4 w-4 transition-transform', !expanded && '-rotate-90')}
                    />
                    {t('title')}
                    <span className="sr-only">{expanded ? t('hide') : t('show')}</span>
                </button>
            </h2>
            <div id={regionId} hidden={!expanded}>
                {children}
            </div>
        </section>
    );
}
