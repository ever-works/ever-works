import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { DeployProgressPanel } from './DeployProgressPanel';

/**
 * `/api/works/:id/deploy/status` is a Next route handler outside the proxy
 * matcher, and it reaches the platform through `serverFetch`, which fails
 * closed without the per-tab `x-ever-workspace` selector. A raw `fetch()`
 * from this poller therefore threw `Invalid workspace scope` on every tick
 * and the panel silently never updated. The poller must go through
 * `browserApiFetch`, which derives the selector from the visible URL.
 */
describe('DeployProgressPanel polling transport', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    deploymentState: 'BUILDING',
                    deploymentStartedAt: null,
                    website: null,
                    deployProvider: 'k8s',
                }),
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it.each([
        ['/org/ever/works/w1', 'org:ever'],
        ['/works/w1', 'personal'],
    ])('polls with the workspace selector derived from %s', async (pathname, selector) => {
        window.history.replaceState({}, '', pathname);

        render(<DeployProgressPanel workId="w1" isDeploying />);

        await waitFor(() => expect(fetch).toHaveBeenCalled());
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('/api/works/w1/deploy/status');
        expect(new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe(selector);
    });
});
