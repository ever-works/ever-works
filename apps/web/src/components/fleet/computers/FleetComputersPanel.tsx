'use client';

import { useCallback, useMemo, useState, useTransition, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowUpRight, Star } from 'lucide-react';
import type { FleetEnrollableNodeKind } from '@ever-works/contracts';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { FleetNodeView } from '@/lib/api/fleet';
import { setFleetNodeFavoriteAction } from '@/app/actions/settings/fleet';
import { FleetSettings } from '@/components/settings/FleetSettings';
import { captureFleetEvent } from '../fleet-telemetry';
import { orderComputers } from '../fleet-hub.shared';
import type { FleetComputersTableFavorites } from './FleetComputersTable';

type FleetSettingsProps = ComponentProps<typeof FleetSettings>;

interface FleetComputersPanelProps extends Omit<
    FleetSettingsProps,
    'view' | 'favorites' | 'onAddOpened'
> {
    /** `?add=` on arrival: open the Add flow preset to this kind. */
    openAddKind: FleetEnrollableNodeKind | null;
}

/**
 * Fleet hub (FL-01, FR-10, spec §5.6) — the Computers tab: the machine table,
 * the Add computer flow (one-time token, ready-to-run command, QR, hand-off
 * file), the node drawer and the cluster list, MOVED here from Settings →
 * Fleet — the same component, in its `computers` view, so nothing is lost on
 * the way. Two additions: a star per row (favourites sort first, FR-24) and
 * the name linking to the computer's page.
 */
export function FleetComputersPanel({
    openAddKind,
    initialNodes,
    ...props
}: FleetComputersPanelProps) {
    const t = useTranslations('fleet.computers');
    const router = useRouter();
    const pathname = usePathname();
    const [favourites, setFavourites] = useState<Record<string, boolean>>(() =>
        Object.fromEntries(initialNodes.map((node) => [node.id, Boolean(node.isFavorite)])),
    );
    const [isPending, startTransition] = useTransition();
    // Favourites first, then online by most recent check (FR-7, FR-24) —
    // with the live stars, so a toggle re-sorts at once.
    const orderNodes = useCallback(
        (rows: FleetNodeView[]) =>
            orderComputers(
                rows.map((row) =>
                    row.id in favourites ? { ...row, isFavorite: favourites[row.id] } : row,
                ),
            ),
        [favourites],
    );

    const toggle = useCallback(
        (node: FleetNodeView) => {
            const next = !favourites[node.id];
            setFavourites((prev) => ({ ...prev, [node.id]: next }));
            captureFleetEvent({ name: 'fleet_favorite_toggled', properties: { on: next } });
            startTransition(async () => {
                const result = await setFleetNodeFavoriteAction(node.id, next);
                if (!result.success) {
                    setFavourites((prev) => ({ ...prev, [node.id]: !next }));
                    toast.error(result.error || t('favouriteFailed'));
                }
            });
        },
        [favourites, t],
    );

    const favorites: FleetComputersTableFavorites = {
        columnLabel: t('favourite'),
        renderToggle: (node) => {
            const on = Boolean(favourites[node.id]);
            return (
                <button
                    type="button"
                    onClick={() => toggle(node)}
                    disabled={isPending}
                    aria-pressed={on}
                    aria-label={
                        on
                            ? t('removeFavourite', { name: node.name })
                            : t('addFavourite', { name: node.name })
                    }
                    title={
                        on
                            ? t('removeFavourite', { name: node.name })
                            : t('addFavourite', { name: node.name })
                    }
                    className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    data-testid={`fleet-node-favourite-${node.id}`}
                >
                    <Star
                        className={cn(
                            'w-4 h-4',
                            on
                                ? 'fill-warning text-warning'
                                : 'text-text-muted dark:text-text-muted-dark',
                        )}
                        aria-hidden="true"
                    />
                </button>
            );
        },
        renderOpen: (node) => (
            <Link
                href={ROUTES.DASHBOARD_FLEET_COMPUTER(node.id)}
                aria-label={t('openPageFor', { name: node.name })}
                title={t('openPage')}
                className="inline-flex items-center justify-center w-9 h-9 rounded-md text-text-muted dark:text-text-muted-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                data-testid={`fleet-node-open-page-${node.id}`}
            >
                <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
            </Link>
        ),
        renderName: (node) => (
            <Link
                href={ROUTES.DASHBOARD_FLEET_COMPUTER(node.id)}
                className="hover:underline focus-visible:underline"
                data-testid={`fleet-node-open-${node.id}`}
            >
                {node.name}
            </Link>
        ),
    };

    // Drop `?add=` once the dialog opened, so a reload does not reopen it.
    const onAddOpened = useCallback(() => {
        router.replace(pathname);
    }, [router, pathname]);

    return (
        <FleetSettings
            {...props}
            initialNodes={initialNodes}
            orderNodes={orderNodes}
            view="computers"
            openAddKind={openAddKind}
            onAddOpened={onAddOpened}
            favorites={favorites}
        />
    );
}
