import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { ComparisonGenerationProgress } from './ComparisonGenerationProgress';

/**
 * Same transport contract as `DeployProgressPanel`: the generation-status
 * route handler resolves the platform scope from the per-tab
 * `x-ever-workspace` selector, so the poller must send it.
 */
describe('ComparisonGenerationProgress polling transport', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ generating: true, stage: 'researching' }),
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

        render(<ComparisonGenerationProgress workId="w1" isGenerating />);

        await waitFor(() => expect(fetch).toHaveBeenCalled());
        const [url, init] = vi.mocked(fetch).mock.calls[0];
        expect(url).toBe('/api/works/w1/comparisons/generation-status');
        expect(new Headers(init?.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe(selector);
    });
});
