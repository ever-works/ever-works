'use client';

import type { ProviderModelSummary } from '@/lib/api/types-only';

interface ProviderModelBadgesProps {
    models?: ProviderModelSummary[];
    maxVisible?: number;
}

export function ProviderModelBadges({ models, maxVisible = 4 }: ProviderModelBadgesProps) {
    if (!models?.length) return null;

    return (
        <span className="mt-0.5 flex max-w-72 flex-wrap gap-1">
            {models.slice(0, maxVisible).map((model) => (
                <span
                    key={`${model.key}-${model.value}`}
                    className="max-w-36 truncate rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] font-normal leading-tight text-text-muted dark:bg-surface-secondary-dark dark:text-text-muted-dark"
                    title={`${model.label}: ${model.value}`}
                >
                    {model.value}
                </span>
            ))}
        </span>
    );
}
