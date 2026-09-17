import { describe, it, expect, vi } from 'vitest';

/**
 * `TriggerModule` is the @Global() module every `*_DISPATCHER` token is bound
 * in, and this spec pins the half of that wiring nothing else can see.
 *
 * A @Global() module shares only what it lists in `exports`. A token bound in
 * `providers` and left out of `exports` resolves to `undefined` at every
 * `@Optional() @Inject()` site in another module — silently, with the app
 * still booting, and with every unit test still green because each one
 * constructs its consumer directly with a dispatcher double. Two tokens were
 * in exactly that state: AW-20's `ROSTER_PROVISION_DISPATCHER` and AW-22's
 * `WORKSPACE_BACKUP_DISPATCHER`.
 *
 * For the backup that meant `POST /api/account/backups` answered 202 with a
 * row already marked `failed` / 'Could not enqueue the backup: no job
 * runtime is configured' on a deployment where the job runtime was fully
 * configured — the feature's headline path, dead on arrival.
 *
 * So the assertion is not "these two are exported". It is "every symbol
 * `buildJobRuntimeProviders()` binds is exported", derived from the same
 * function the bindings come from, so the next dispatcher someone adds
 * cannot land half-wired.
 */

vi.mock('@trigger.dev/sdk', () => ({
    configure: vi.fn(),
    runs: { cancel: vi.fn() },
    task: vi.fn().mockImplementation(() => ({ id: 'mock-task' })),
    schedules: { task: vi.fn().mockImplementation(() => ({ id: 'mock-schedule-task' })) },
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            shouldUseTrigger: vi.fn(),
            getSecretKey: vi.fn(),
            getApiUrl: vi.fn(),
            getMachine: vi.fn(),
            getInternalBaseUrl: vi.fn(),
            getInternalSecret: vi.fn(),
            getInternalRequestTimeoutMs: vi.fn(() => 45000),
        },
        subscriptions: { getDispatchIntervalMinutes: vi.fn(() => 5) },
    },
}));

const { buildJobRuntimeProviders } = await import('@ever-works/agent/tasks');
const { TriggerModule } = await import('../trigger/trigger.module');

/** The `provide` token of every provider the job-runtime factory returns. */
function boundDispatcherTokens(): symbol[] {
    return buildJobRuntimeProviders().map((provider) => (provider as { provide: symbol }).provide);
}

function exportedTokens(): unknown[] {
    return (Reflect.getMetadata('exports', TriggerModule) as unknown[]) ?? [];
}

describe('TriggerModule dispatcher exports', () => {
    it('binds a dispatcher provider for every symbol in the pin list', () => {
        // A zero or a shrinking count here would make every assertion below
        // vacuous, so the arity is pinned first.
        expect(boundDispatcherTokens().length).toBeGreaterThanOrEqual(14);
        for (const token of boundDispatcherTokens()) {
            expect(typeof token).toBe('symbol');
        }
    });

    it('exports every dispatcher token it binds', () => {
        const exported = new Set(exportedTokens());
        const unexported = boundDispatcherTokens()
            .filter((token) => !exported.has(token))
            .map((token) => token.toString());

        // If this fails, the named token is bound but not shared: every
        // `@Optional() @Inject()` of it in another module resolves to
        // `undefined`, the app boots, and the feature behind it silently
        // never enqueues anything.
        expect(unexported).toEqual([]);
    });

    it('exports the two that were missing, by name', async () => {
        // Named as well as derived, so a future refactor of
        // `buildJobRuntimeProviders` cannot quietly take the regression
        // guard with it.
        const { ROSTER_PROVISION_DISPATCHER, WORKSPACE_BACKUP_DISPATCHER } =
            await import('@ever-works/agent/tasks');
        expect(exportedTokens()).toContain(ROSTER_PROVISION_DISPATCHER);
        expect(exportedTokens()).toContain(WORKSPACE_BACKUP_DISPATCHER);
    });
});
