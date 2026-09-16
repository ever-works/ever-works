import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { McpConnection } from '@/lib/api/mcp-connections';
import { McpConnectionsClient } from './McpConnectionsClient';

/**
 * Settings → Connections — the AW-15 health additions. The existing list,
 * form and controls are unchanged; this pins that each row shows its
 * health, that credential problems carry their explanation, and that the
 * banner counts exactly the rows that need the owner.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    usePathname: () => '/settings/connections',
}));
vi.mock('@/app/actions/mcp-connections', () => ({
    createMcpConnectionAction: vi.fn(),
    deleteMcpConnectionAction: vi.fn(),
    listMcpConnectionsAction: vi.fn(),
    testMcpConnectionAction: vi.fn(),
    updateMcpConnectionAction: vi.fn(),
}));

function connection(over: Partial<McpConnection> = {}): McpConnection {
    return {
        id: 'c1',
        name: 'docs',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
        enabled: true,
        source: 'manual',
        authHeaderNames: ['Authorization'],
        lastConnectedAt: null,
        lastError: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        ...over,
    };
}

describe('McpConnectionsClient — health', () => {
    it('shows a health pill per row, "unknown" for rows from an older API', () => {
        render(
            <McpConnectionsClient
                initial={[
                    connection({ health: 'healthy' }),
                    connection({ id: 'c2', name: 'legacy' }),
                ]}
            />,
        );
        expect(screen.getByTestId('mcp-connection-health-docs')).toHaveAttribute(
            'data-health',
            'healthy',
        );
        expect(screen.getByTestId('mcp-connection-health-docs')).toHaveTextContent(
            'health.healthy',
        );
        expect(screen.getByTestId('mcp-connection-health-legacy')).toHaveAttribute(
            'data-health',
            'unknown',
        );
        expect(screen.queryByTestId('mcp-connections-attention-banner')).not.toBeInTheDocument();
    });

    it('counts expired and unreachable rows in the banner and explains a missing credential', () => {
        render(
            <McpConnectionsClient
                initial={[
                    connection({
                        health: 'expired',
                        lastErrorCode: 'credential_missing',
                        lastError: 'Missing credential `docs_token`',
                    }),
                    connection({
                        id: 'c2',
                        name: 'slow',
                        health: 'degraded',
                        lastError: 'Request timed out.',
                    }),
                    connection({
                        id: 'c3',
                        name: 'gone',
                        health: 'unreachable',
                        lastErrorCode: 'unreachable',
                        lastError: 'Server unreachable (connection failed).',
                    }),
                ]}
            />,
        );

        expect(screen.getByTestId('mcp-connections-attention-banner')).toHaveTextContent(
            'banner.needsAttention:2',
        );
        expect(screen.getByTestId('mcp-connection-health-hint-docs')).toHaveTextContent(
            'health.credentialMissingHint',
        );
        // The key name is shown (it is the stored, value-free message); a
        // timeout needs no extra sentence.
        expect(screen.getByText('Missing credential `docs_token`')).toBeInTheDocument();
        expect(screen.queryByTestId('mcp-connection-health-hint-slow')).not.toBeInTheDocument();
    });
    it('a legacy literal-header http connection shows a warning pill, a fix hint and its own banner — not "needs attention"', () => {
        render(
            <McpConnectionsClient
                initial={[
                    connection({
                        name: 'legacy',
                        url: 'http://mcp.example.com/mcp',
                        health: 'insecure_transport',
                        lastErrorCode: 'insecure_transport',
                        insecureCredentialTransport: true,
                    }),
                    connection({
                        id: 'c2',
                        name: 'fresh',
                        url: 'http://mcp2.example.com/mcp',
                        health: 'unknown',
                        insecureCredentialTransport: true,
                    }),
                    connection({ id: 'c3', name: 'secure', health: 'healthy' }),
                ]}
            />,
        );

        const pill = screen.getByTestId('mcp-connection-health-legacy');
        expect(pill).toHaveAttribute('data-health', 'insecure_transport');
        expect(pill).toHaveTextContent('health.insecureTransport');
        expect(pill.className).toContain('text-warning');

        expect(screen.getByTestId('mcp-connection-insecure-legacy')).toHaveTextContent(
            'health.insecureTransportWarning',
        );
        expect(screen.getByTestId('mcp-connection-insecure-legacy')).toHaveTextContent(
            'health.insecureTransportHint',
        );
        // Known from the stored URL + headers before the first attempt.
        expect(screen.getByTestId('mcp-connection-insecure-fresh')).toBeInTheDocument();
        expect(screen.queryByTestId('mcp-connection-insecure-secure')).not.toBeInTheDocument();

        expect(screen.getByTestId('mcp-connections-insecure-banner')).toHaveTextContent(
            'banner.insecureTransport:2',
        );
        expect(screen.queryByTestId('mcp-connections-attention-banner')).not.toBeInTheDocument();
    });

    it('a refused credential transport explains the https fix', () => {
        render(
            <McpConnectionsClient
                initial={[
                    connection({
                        name: 'strict',
                        url: 'http://mcp.example.com/mcp',
                        health: 'expired',
                        lastErrorCode: 'https_required',
                        lastError:
                            'Credentials require an https:// endpoint (organization setting "Require https for connection credentials" is on)',
                    }),
                ]}
            />,
        );
        expect(screen.getByTestId('mcp-connection-health-hint-strict')).toHaveTextContent(
            'health.httpsRequiredHint',
        );
        expect(screen.getByTestId('mcp-connections-attention-banner')).toHaveTextContent(
            'banner.needsAttention:1',
        );
    });
});
