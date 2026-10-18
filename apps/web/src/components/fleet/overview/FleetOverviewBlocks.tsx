'use client';

import { useTranslations } from 'next-intl';
import type { FleetNodeView } from '@ever-works/contracts';
import '../modules';
import {
    getOverviewBlocks,
    type FleetFeatureFlags,
    type FleetOverviewBlockRegistration,
} from '../registry';
import { RegisteredComponent } from '../RegisteredComponent';

/**
 * Fleet hub (FL-01, README D9) — the Overview blocks other epics register
 * (`registerOverviewBlock`): FL-03's health metrics, FL-18's runner jobs, …
 * Each is code-split (its bundle loads only when it renders), shows a
 * sentence while it loads, and fails on its own — a block that throws says so
 * in one line while everything around it keeps rendering.
 */
export function FleetOverviewBlocks({
    surface,
    nodes,
    flags,
}: {
    surface: FleetOverviewBlockRegistration['surface'];
    nodes: FleetNodeView[];
    flags: FleetFeatureFlags;
}) {
    const t = useTranslations('fleet.overview');
    const blocks = getOverviewBlocks(surface, flags);
    if (blocks.length === 0) return null;
    return (
        <div className="space-y-6" data-testid={`fleet-overview-blocks-${surface}`}>
            {blocks.map((block) => (
                <RegisteredComponent
                    key={block.id}
                    id={`block:${block.id}`}
                    load={block.load}
                    props={{ nodes, flags }}
                    loading={
                        <p
                            role="status"
                            className="text-sm text-text-muted dark:text-text-muted-dark"
                        >
                            {t('blockLoading')}
                        </p>
                    }
                    failed={(retry) => (
                        <p
                            role="status"
                            className="flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark"
                        >
                            {t('blockFailed')}
                            <button
                                type="button"
                                onClick={retry}
                                className="underline underline-offset-2 hover:text-text dark:hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                                data-testid={`fleet-overview-block-retry-${block.id}`}
                            >
                                {t('needsALook.tryAgain')}
                            </button>
                        </p>
                    )}
                />
            ))}
        </div>
    );
}
