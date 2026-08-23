import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('./TerminalPane', () => ({
    TerminalPane: () => <div data-testid="terminal-pane" />,
}));

import { AgentTerminalClient } from './AgentTerminalClient';

describe('AgentTerminalClient workspace selector', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        window.history.replaceState({}, '', '/');
    });

    it('stamps start-session from the visible Organization route', async () => {
        window.history.replaceState({}, '', '/org/ever/agents/agent-1');
        const fetchMock = vi.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                new Response('{}', { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);

        render(
            <AgentTerminalClient
                agentId="11111111-2222-4333-8444-555555555555"
                initialRunId="2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f"
                runs={[
                    {
                        id: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
                        status: 'running',
                        triggerKind: 'manual',
                        createdAt: '2026-08-23T00:00:00.000Z',
                        summary: null,
                    },
                ]}
            />,
        );

        fireEvent.click(screen.getByTestId('terminal-start-session'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });
});
