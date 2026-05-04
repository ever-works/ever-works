'use client';

import type { ProviderModelSummary } from '@/lib/api/types-only';
import { ProviderModelBadges } from './ProviderModelBadges';

interface ActiveProviderModelsProps {
    models?: ProviderModelSummary[];
    changeLabel?: string;
    onConfigure?: () => void;
}

export function ActiveProviderModels({
    models,
    changeLabel,
    onConfigure,
}: ActiveProviderModelsProps) {
    if (!models?.length) return null;

    return (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
            <ProviderModelBadges models={models} />
            {onConfigure && changeLabel && (
                <button
                    type="button"
                    onClick={onConfigure}
                    className="text-[11px] font-medium text-primary hover:text-primary-hover"
                >
                    {changeLabel}
                </button>
            )}
        </div>
    );
}
