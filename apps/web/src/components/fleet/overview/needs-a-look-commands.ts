import type { NeedsALookItem } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01, FR-6) — the named commands a "needs a look" row's one
 * action button can run, besides navigating to a route.
 *
 * A producer names a command (`action.command`, e.g. FL-03's
 * `clear-model-throttle`); the epic that owns it registers the handler here
 * from its module file (`components/fleet/modules/<epic>.ts`). A row whose
 * command nobody registered shows no button — never one that does nothing.
 * A handler answers whether the act succeeded so the list can refresh.
 */
export type NeedsALookCommandHandler = (
    item: NeedsALookItem,
) => Promise<{ ok: boolean; error?: string }>;

const handlers = new Map<string, NeedsALookCommandHandler>();

export function registerNeedsALookCommand(name: string, handler: NeedsALookCommandHandler): void {
    handlers.set(name, handler);
}

export function getNeedsALookCommand(name: string | undefined): NeedsALookCommandHandler | null {
    return name ? (handlers.get(name) ?? null) : null;
}

/** For tests only. */
export function resetNeedsALookCommandsForTests(): void {
    handlers.clear();
}
