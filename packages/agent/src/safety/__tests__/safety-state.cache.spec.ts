import { SAFETY_CACHE_TTL_MS, WORKSPACE_RUNNING } from '@ever-works/contracts';
import { resolveLadder } from '../trust-ladder';
import { SafetyStateCache, type SafetyCacheKey, type SafetySnapshot } from '../safety-state.cache';

const KEY: SafetyCacheKey = {
    ownerUserId: 'user-1',
    workspaceScopeId: 'org-1',
    agentId: null,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
};

function snapshot(overrides: Partial<SafetySnapshot> = {}): SafetySnapshot {
    return {
        ladder: resolveLadder([], { workspaceScopeId: 'org-1' }),
        pause: { ...WORKSPACE_RUNNING },
        safe: false,
        loadedAt: Date.now(),
        ...overrides,
    };
}

describe('SafetyStateCache', () => {
    beforeEach(() => jest.useRealTimers());

    it('loads once and serves the cached snapshot inside the TTL', async () => {
        const cache = new SafetyStateCache();
        const load = jest.fn().mockResolvedValue(snapshot());
        await cache.get(KEY, load);
        await cache.get(KEY, load);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('refreshes a stale entry', async () => {
        const cache = new SafetyStateCache();
        const stale = snapshot({ loadedAt: Date.now() - SAFETY_CACHE_TTL_MS - 1 });
        const load = jest.fn().mockResolvedValueOnce(stale).mockResolvedValue(snapshot());
        await cache.get(KEY, load);
        await cache.get(KEY, load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('keeps one entry per agent, because an agent narrows the ladder', async () => {
        const cache = new SafetyStateCache();
        const load = jest.fn().mockResolvedValue(snapshot());
        await cache.get(KEY, load);
        await cache.get({ ...KEY, agentId: 'agent-1' }, load);
        expect(load).toHaveBeenCalledTimes(2);
        expect(cache.size()).toBe(2);
    });

    it('drops every entry for a workspace on a write', async () => {
        // The replica that took the write must never be the one showing stale
        // state; the others expire inside the same ten seconds.
        const cache = new SafetyStateCache();
        const load = jest.fn().mockResolvedValue(snapshot());
        await cache.get(KEY, load);
        await cache.get({ ...KEY, agentId: 'agent-1' }, load);

        cache.invalidate({ ownerUserId: 'user-1', workspaceScopeId: 'org-1' });

        expect(cache.size()).toBe(0);
        await cache.get(KEY, load);
        expect(load).toHaveBeenCalledTimes(3);
    });

    it('leaves another workspace alone on an invalidate', async () => {
        const cache = new SafetyStateCache();
        const load = jest.fn().mockResolvedValue(snapshot());
        await cache.get(KEY, load);
        await cache.get({ ...KEY, workspaceScopeId: 'org-2' }, load);
        cache.invalidate({ ownerUserId: 'user-1', workspaceScopeId: 'org-1' });
        expect(cache.size()).toBe(1);
    });

    it('does not swallow a loader failure — the gate decides what that means', async () => {
        // Turning a read failure into a cached "allow" here is precisely the
        // fail-open the epic exists to prevent; the gate converts it into the
        // safe-mode refusal instead.
        const cache = new SafetyStateCache();
        await expect(
            cache.get(KEY, async () => {
                throw new Error('database down');
            }),
        ).rejects.toThrow('database down');
        expect(cache.size()).toBe(0);
    });

    it('caches a safe-mode snapshot like any other', async () => {
        const cache = new SafetyStateCache();
        const safe = snapshot({
            ladder: resolveLadder([], { workspaceScopeId: 'org-1', safeMode: true }),
            safe: true,
        });
        const result = await cache.get(KEY, async () => safe);
        expect(result.safe).toBe(true);
        for (const entry of result.ladder.entries) expect(entry.enforced).toBe(true);
    });

    it('stays bounded so a many-tenant worker cannot grow it without limit', async () => {
        const cache = new SafetyStateCache();
        const load = jest.fn().mockResolvedValue(snapshot());
        for (let index = 0; index < 600; index += 1) {
            await cache.get({ ...KEY, workspaceScopeId: `org-${index}` }, load);
        }
        expect(cache.size()).toBeLessThanOrEqual(500);
    });

    it('clears everything on demand', async () => {
        const cache = new SafetyStateCache();
        await cache.get(KEY, async () => snapshot());
        cache.clear();
        expect(cache.size()).toBe(0);
    });
});
