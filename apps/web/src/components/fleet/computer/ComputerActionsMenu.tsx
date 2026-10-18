'use client';

import {
    useEffect,
    useRef,
    useState,
    useTransition,
    type FormEvent,
    type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    Link2,
    MoreHorizontal,
    Pause,
    Pencil,
    Play,
    Power,
    RotateCcw,
    Star,
    Trash2,
} from 'lucide-react';
import {
    FLEET_MAX_NODE_NAME_LENGTH,
    fleetFamilyAllows,
    type FleetNodeView,
    type FleetViewerRole,
} from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    deleteFleetNodeAction,
    drainFleetNodeAction,
    fetchFleetComputerInFlightAction,
    setFleetNodeFavoriteAction,
    updateFleetNodeAction,
} from '@/app/actions/settings/fleet';
import { getComputerActions, type FleetFeatureFlags } from '../registry';
import { RegisteredComponent } from '../RegisteredComponent';
import { captureFleetEvent } from '../fleet-telemetry';

const TRIGGER =
    'inline-flex items-center justify-center w-8 h-8 rounded-md border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

type DrainCount = { state: 'counting' } | { state: 'known'; count: number } | { state: 'unknown' };

/**
 * Fleet hub (FL-01, FR-22, FR-23, spec §5.8 / §5.11) — the computer page's ⋯
 * menu: Rename… (inline, no dialog) · Add to / Remove from favourites ·
 * Pause / Resume (a toast) · Drain (one confirmation naming the jobs in flight
 * it releases) / Return to fleet · Copy link · Remove from Fleet… (type the
 * name), then whatever other epics registered for the menu.
 *
 * The page only MIRRORS who may do what: every act is answered server-side
 * (the `machines` family for the lifecycle acts, owner only for the star). An
 * act the viewer is outside of is shown disabled with the reason beside it,
 * never hidden and never offered as if it would work.
 */
export function ComputerActionsMenu({
    node,
    flags = {},
}: {
    node: FleetNodeView;
    flags?: FleetFeatureFlags;
}) {
    const t = useTranslations('fleet.computer.menu');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(node.name);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [drainOpen, setDrainOpen] = useState(false);
    const [drainCount, setDrainCount] = useState<DrainCount>({ state: 'counting' });
    const [removeOpen, setRemoveOpen] = useState(false);
    const [removeName, setRemoveName] = useState('');
    const [removeError, setRemoveError] = useState<string | null>(null);

    const role: FleetViewerRole = node.viewerRole ?? 'owner';
    const isOwner = role === 'owner';
    const canLifecycle = isOwner || fleetFamilyAllows(node, role, 'machines');
    const lifecycleDenied = canLifecycle
        ? null
        : role === 'org-admin'
          ? t('deniedAskAdmins', { name: node.name })
          : role === 'org-member'
            ? t('deniedAskMembers', { name: node.name })
            : t('deniedOwnerOnly', { name: node.name });
    const ownerOnlyDenied = isOwner ? null : t('deniedOwnerOnly', { name: node.name });
    const paused = node.status === 'paused';
    const drained = node.status === 'disabled';
    const registered = getComputerActions('menu', flags);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const focusTriggerNext = useRef(false);

    // Leaving the inline rename (saved, cancelled or Escape) puts the focus
    // back on the ⋯ button it came from, never on the page's start.
    useEffect(() => {
        if (renaming || !focusTriggerNext.current) return;
        focusTriggerNext.current = false;
        menuRef.current
            ?.querySelector<HTMLButtonElement>('[data-testid="fleet-computer-menu-trigger"]')
            ?.focus();
    }, [renaming]);

    // ── Rename (inline) ────────────────────────────────────────────────────
    const startRename = () => {
        setRenameValue(node.name);
        setRenameError(null);
        setRenaming(true);
    };
    const endRename = () => {
        focusTriggerNext.current = true;
        setRenaming(false);
    };
    const submitRename = (event: FormEvent) => {
        event.preventDefault();
        const name = renameValue.trim();
        if (name === node.name) {
            endRename();
            return;
        }
        startTransition(async () => {
            const result = await updateFleetNodeAction(node.id, { name });
            if (!result.success) {
                setRenameError(result.error || t('renameFailed', { name: node.name }));
                return;
            }
            endRename();
            toast.success(t('renamed', { name }));
            router.refresh();
        });
    };
    const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            endRename();
        }
    };

    // ── Favourite ──────────────────────────────────────────────────────────
    const toggleFavourite = () => {
        const next = !node.isFavorite;
        captureFleetEvent({ name: 'fleet_favorite_toggled', properties: { on: next } });
        startTransition(async () => {
            const result = await setFleetNodeFavoriteAction(node.id, next);
            if (!result.success) {
                toast.error(result.error || t('favouriteFailed'));
                return;
            }
            router.refresh();
        });
    };

    // ── Pause / resume (plain, a toast) ────────────────────────────────────
    const togglePaused = () => {
        const next = !paused;
        startTransition(async () => {
            const result = await updateFleetNodeAction(node.id, { paused: next });
            if (!result.success) {
                toast.error(result.error || t('pauseFailed', { name: node.name }));
                return;
            }
            toast.success(
                next ? t('paused', { name: node.name }) : t('resumed', { name: node.name }),
            );
            router.refresh();
        });
    };

    // ── Drain (confirm, naming the jobs it releases) / return (plain) ──────
    const openDrain = () => {
        setDrainCount({ state: 'counting' });
        setDrainOpen(true);
        startTransition(async () => {
            const result = await fetchFleetComputerInFlightAction(node.id);
            setDrainCount(
                result.success && result.data !== null
                    ? { state: 'known', count: result.data }
                    : { state: 'unknown' },
            );
        });
    };
    const drain = (on: boolean) => {
        startTransition(async () => {
            const result = await drainFleetNodeAction(node.id, on);
            if (!result.success) {
                toast.error(result.error || t('drainFailed', { name: node.name }));
                return;
            }
            setDrainOpen(false);
            toast.success(
                on
                    ? t('drained', { name: node.name, count: result.data.releasedJobs })
                    : t('returned', { name: node.name }),
            );
            router.refresh();
        });
    };

    // ── Copy link ──────────────────────────────────────────────────────────
    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(
                `${window.location.origin}${window.location.pathname}`,
            );
            toast.success(t('linkCopied'));
        } catch {
            toast.error(t('linkCopyFailed'));
        }
    };

    // ── Remove (type the name) ─────────────────────────────────────────────
    const openRemove = () => {
        setRemoveName('');
        setRemoveError(null);
        setRemoveOpen(true);
    };
    const nameMatches = removeName.trim() === node.name;
    const remove = () => {
        // Only from the open dialog, and only with the name typed.
        if (!removeOpen || !nameMatches) return;
        startTransition(async () => {
            const result = await deleteFleetNodeAction(node.id, removeName);
            if (!result.success) {
                setRemoveError(result.error || t('removeFailed', { name: node.name }));
                return;
            }
            setRemoveOpen(false);
            toast.success(t('removed', { name: node.name }));
            router.push(ROUTES.DASHBOARD_FLEET_COMPUTERS);
        });
    };

    if (renaming) {
        return (
            <form
                onSubmit={submitRename}
                className="flex items-center gap-2"
                data-testid="fleet-computer-rename-form"
            >
                <input
                    // The person asked to rename: the field takes the focus.
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={onRenameKeyDown}
                    maxLength={FLEET_MAX_NODE_NAME_LENGTH}
                    aria-label={t('renameLabel', { name: node.name })}
                    aria-invalid={renameError ? true : undefined}
                    aria-describedby={renameError ? 'fleet-computer-rename-error' : undefined}
                    className="h-8 w-48 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm text-text dark:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    data-testid="fleet-computer-rename-input"
                />
                <Button type="submit" size="sm" loading={isPending}>
                    {t('save')}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={endRename}
                    disabled={isPending}
                >
                    {t('cancel')}
                </Button>
                {renameError && (
                    <span
                        id="fleet-computer-rename-error"
                        role="alert"
                        className="text-xs text-danger"
                    >
                        {renameError}
                    </span>
                )}
            </form>
        );
    }

    const item = (
        testId: string,
        icon: React.ReactNode,
        label: string,
        onClick: () => void,
        denied: string | null = null,
    ) => (
        <DropdownMenuItem onClick={onClick} disabled={denied !== null || isPending}>
            <span className="flex flex-col items-start text-left" data-testid={testId}>
                <span className="flex items-center gap-2">
                    {icon}
                    {label}
                </span>
                {denied && (
                    <span
                        className="pl-6 text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid={`${testId}-denied`}
                    >
                        {denied}
                    </span>
                )}
            </span>
        </DropdownMenuItem>
    );

    const iconClass = 'w-4 h-4 shrink-0';

    return (
        <>
            <div ref={menuRef} data-testid="fleet-computer-menu">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={TRIGGER}
                            aria-label={t('label', { name: node.name })}
                            data-testid="fleet-computer-menu-trigger"
                        >
                            <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {item(
                            'fleet-computer-menu-rename',
                            <Pencil className={iconClass} aria-hidden="true" />,
                            t('rename'),
                            startRename,
                            lifecycleDenied,
                        )}
                        {item(
                            'fleet-computer-menu-favourite',
                            <Star className={iconClass} aria-hidden="true" />,
                            node.isFavorite && isOwner ? t('removeFavourite') : t('addFavourite'),
                            toggleFavourite,
                            ownerOnlyDenied,
                        )}
                        {item(
                            'fleet-computer-menu-pause',
                            paused ? (
                                <Play className={iconClass} aria-hidden="true" />
                            ) : (
                                <Pause className={iconClass} aria-hidden="true" />
                            ),
                            paused ? t('resume') : t('pause'),
                            togglePaused,
                            lifecycleDenied ?? (drained ? t('pauseNeedsReturn') : null),
                        )}
                        {item(
                            'fleet-computer-menu-drain',
                            drained ? (
                                <RotateCcw className={iconClass} aria-hidden="true" />
                            ) : (
                                <Power className={iconClass} aria-hidden="true" />
                            ),
                            drained ? t('returnToFleet') : t('drain'),
                            drained ? () => drain(false) : openDrain,
                            lifecycleDenied,
                        )}
                        {item(
                            'fleet-computer-menu-copy-link',
                            <Link2 className={iconClass} aria-hidden="true" />,
                            t('copyLink'),
                            () => void copyLink(),
                        )}
                        {registered.length > 0 && <DropdownMenuSeparator />}
                        {registered.map((action) => (
                            <RegisteredComponent
                                key={action.id}
                                id={`menu:${action.id}`}
                                load={action.load}
                                props={{ node, flags }}
                                loading={null}
                                failed={null}
                            />
                        ))}
                        <DropdownMenuSeparator />
                        {item(
                            'fleet-computer-menu-remove',
                            <Trash2 className={iconClass} aria-hidden="true" />,
                            t('remove'),
                            openRemove,
                            lifecycleDenied,
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <Dialog open={drainOpen} onOpenChange={(open) => !open && setDrainOpen(false)}>
                <DialogContent>
                    <div data-testid="fleet-computer-drain-dialog">
                        <DialogClose onClose={() => setDrainOpen(false)} />
                        <DialogHeader>
                            <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                {t('drainTitle', { name: node.name })}
                            </DialogTitle>
                            <DialogDescription>
                                <span data-testid="fleet-computer-drain-body">
                                    {drainCount.state === 'counting'
                                        ? t('drainCounting')
                                        : drainCount.state === 'known'
                                          ? t('drainBody', { count: drainCount.count })
                                          : t('drainBodyUnknown')}
                                </span>
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button variant="secondary" onClick={() => setDrainOpen(false)}>
                                {t('cancel')}
                            </Button>
                            <Button
                                variant="danger"
                                onClick={() => drain(true)}
                                loading={isPending}
                                data-testid="fleet-computer-drain-confirm"
                            >
                                {t('drainConfirm')}
                            </Button>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={removeOpen} onOpenChange={(open) => !open && setRemoveOpen(false)}>
                <DialogContent>
                    {/* Outside the form: the close button is a plain <button>, and inside
                        the form it would SUBMIT — removing the computer it was meant to spare. */}
                    <DialogClose onClose={() => setRemoveOpen(false)} />
                    <form
                        data-testid="fleet-computer-remove-dialog"
                        onSubmit={(event) => {
                            event.preventDefault();
                            remove();
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                {t('removeTitle', { name: node.name })}
                            </DialogTitle>
                            <DialogDescription>{t('removeBody')}</DialogDescription>
                        </DialogHeader>
                        <label className="block space-y-1 text-sm text-text dark:text-text-dark">
                            <span>{t('removeNameLabel')}</span>
                            <input
                                value={removeName}
                                onChange={(event) => setRemoveName(event.target.value)}
                                placeholder={node.name}
                                autoComplete="off"
                                spellCheck={false}
                                aria-invalid={removeError ? true : undefined}
                                className="h-9 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                data-testid="fleet-computer-remove-name"
                            />
                        </label>
                        {removeError && (
                            <p role="alert" className="mt-2 text-sm text-danger">
                                {removeError}
                            </p>
                        )}
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => setRemoveOpen(false)}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                type="submit"
                                variant="danger"
                                disabled={!nameMatches}
                                loading={isPending}
                                data-testid="fleet-computer-remove-confirm"
                            >
                                {t('removeConfirm')}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
