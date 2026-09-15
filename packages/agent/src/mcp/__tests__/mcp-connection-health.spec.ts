import { MCP_ERROR_MESSAGES, mcpHealthErrorCode } from '../mcp-connection-health';
import {
    MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE,
    MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE,
    formatMissingCredentialMessage,
} from '../mcp-header-credentials';
import {
    MCP_HEALTH_STAMP_MAX_ATTEMPTS,
    McpServerConnectionRepository,
} from '../../database/repositories/mcp-server-connection.repository';

describe('mcpHealthErrorCode', () => {
    it('maps every classified client message to its health code', () => {
        expect(mcpHealthErrorCode(formatMissingCredentialMessage(['docs_token']))).toBe(
            'credential_missing',
        );
        // Every transport REFUSAL maps to https_required (expires); a refusal is
        // never the insecure_transport warning.
        expect(mcpHealthErrorCode(MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE)).toBe('https_required');
        expect(mcpHealthErrorCode(MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE)).toBe('https_required');
        expect(mcpHealthErrorCode(MCP_ERROR_MESSAGES.unauthorized)).toBe('credential_rejected');
        expect(mcpHealthErrorCode(MCP_ERROR_MESSAGES.forbidden)).toBe('credential_rejected');
        expect(mcpHealthErrorCode(MCP_ERROR_MESSAGES.notFound)).toBe('not_found');
        expect(mcpHealthErrorCode(MCP_ERROR_MESSAGES.unreachable)).toBe('unreachable');
        expect(mcpHealthErrorCode(MCP_ERROR_MESSAGES.timeout)).toBe('timeout');
        expect(mcpHealthErrorCode('MCP tool "slow" timed out after 20ms.')).toBe('timeout');
    });

    it('anything else is a plain failure', () => {
        expect(mcpHealthErrorCode('Headers.append: "***" is an invalid header value.')).toBe(
            'failed',
        );
        expect(mcpHealthErrorCode('')).toBe('failed');
        expect(mcpHealthErrorCode(null)).toBe('failed');
    });
});

describe('McpServerConnectionRepository.stampConnectionResult — health', () => {
    function makeRepo(previousFailureCount = 0) {
        const typeorm = {
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            findOne: jest
                .fn()
                .mockResolvedValue({ id: 'c1', healthFailureCount: previousFailureCount }),
        };
        return { repo: new McpServerConnectionRepository(typeorm as never), typeorm };
    }

    it('a success records healthy and clears the error code', async () => {
        const { repo, typeorm } = makeRepo(2);
        await repo.stampConnectionResult('c1', { ok: true });

        expect(typeorm.findOne).not.toHaveBeenCalled();
        expect(typeorm.update).toHaveBeenCalledWith(
            'c1',
            expect.objectContaining({
                lastError: null,
                health: 'healthy',
                healthFailureCount: 0,
                lastErrorCode: null,
                lastConnectedAt: expect.any(Date),
                healthCheckedAt: expect.any(Date),
            }),
        );
    });

    it('a success that sent literal credentials over plain http records the warning, not healthy', async () => {
        const { repo, typeorm } = makeRepo(2);
        await repo.stampConnectionResult('c1', { ok: true, warning: 'insecure_transport' });

        expect(typeorm.findOne).not.toHaveBeenCalled();
        expect(typeorm.update).toHaveBeenCalledWith(
            'c1',
            expect.objectContaining({
                lastError: null,
                health: 'insecure_transport',
                healthFailureCount: 0,
                lastErrorCode: 'insecure_transport',
                lastConnectedAt: expect.any(Date),
            }),
        );
    });

    it('a transport refusal expires the row', async () => {
        const { repo, typeorm } = makeRepo(0);
        await repo.stampConnectionResult('c1', {
            ok: false,
            error: MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE,
        });
        expect(typeorm.update).toHaveBeenCalledWith(
            { id: 'c1', healthFailureCount: 0 },
            expect.objectContaining({ health: 'expired', lastErrorCode: 'https_required' }),
        );
    });

    it('a missing credential expires the row and keeps the key-only message', async () => {
        const { repo, typeorm } = makeRepo(0);
        const error = formatMissingCredentialMessage(['docs_token']);
        await repo.stampConnectionResult('c1', { ok: false, error });

        expect(typeorm.update).toHaveBeenCalledWith(
            { id: 'c1', healthFailureCount: 0 },
            expect.objectContaining({
                lastError: error,
                health: 'expired',
                lastErrorCode: 'credential_missing',
                healthFailureCount: 1,
            }),
        );
    });

    it('a third consecutive unreachable attempt flips to unreachable', async () => {
        const { repo, typeorm } = makeRepo(2);
        await repo.stampConnectionResult('c1', {
            ok: false,
            error: MCP_ERROR_MESSAGES.unreachable,
        });

        expect(typeorm.update).toHaveBeenCalledWith(
            { id: 'c1', healthFailureCount: 2 },
            expect.objectContaining({ health: 'unreachable', healthFailureCount: 3 }),
        );
    });

    it('an explicit error code wins over the message mapping', async () => {
        const { repo, typeorm } = makeRepo(0);
        await repo.stampConnectionResult('c1', {
            ok: false,
            error: 'anything',
            errorCode: 'credential_rejected',
        });
        expect(typeorm.update).toHaveBeenCalledWith(
            { id: 'c1', healthFailureCount: 0 },
            expect.objectContaining({ health: 'expired', lastErrorCode: 'credential_rejected' }),
        );
    });

    it('does not touch lastConnectedAt on failure (the last success stays visible)', async () => {
        const { repo, typeorm } = makeRepo(0);
        await repo.stampConnectionResult('c1', { ok: false, error: 'boom' });
        expect(typeorm.update.mock.calls[0][1]).not.toHaveProperty('lastConnectedAt');
    });

    it('a failure writes only if the counter it read is still stored (compare-and-set)', async () => {
        const typeorm = {
            // A concurrent failed attempt stamps the row between this
            // attempt's read and its write: the first write matches nothing.
            findOne: jest
                .fn()
                .mockResolvedValueOnce({ id: 'c1', healthFailureCount: 1 })
                .mockResolvedValueOnce({ id: 'c1', healthFailureCount: 2 }),
            update: jest
                .fn()
                .mockResolvedValueOnce({ affected: 0 })
                .mockResolvedValueOnce({ affected: 1 }),
        };
        const repo = new McpServerConnectionRepository(typeorm as never);

        await repo.stampConnectionResult('c1', {
            ok: false,
            error: MCP_ERROR_MESSAGES.unreachable,
        });

        expect(typeorm.findOne).toHaveBeenCalledTimes(2);
        expect(typeorm.update).toHaveBeenCalledTimes(2);
        expect(typeorm.update.mock.calls[0]).toEqual([
            { id: 'c1', healthFailureCount: 1 },
            expect.objectContaining({ health: 'degraded', healthFailureCount: 2 }),
        ]);
        // Re-classified against the fresh count: the concurrent increment is kept.
        expect(typeorm.update.mock.calls[1]).toEqual([
            { id: 'c1', healthFailureCount: 2 },
            expect.objectContaining({ health: 'unreachable', healthFailureCount: 3 }),
        ]);
    });

    it('a row deleted mid-attempt is left alone', async () => {
        const typeorm = { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() };
        const repo = new McpServerConnectionRepository(typeorm as never);

        await repo.stampConnectionResult('c1', { ok: false, error: 'boom' });

        expect(typeorm.update).not.toHaveBeenCalled();
    });

    it('gives up with an error (never a silent lost update) when the row keeps changing', async () => {
        const typeorm = {
            findOne: jest.fn().mockResolvedValue({ id: 'c1', healthFailureCount: 0 }),
            update: jest.fn().mockResolvedValue({ affected: 0 }),
        };
        const repo = new McpServerConnectionRepository(typeorm as never);

        await expect(
            repo.stampConnectionResult('c1', { ok: false, error: 'boom' }),
        ).rejects.toThrow(/Could not record health for MCP connection c1/);
        expect(typeorm.update).toHaveBeenCalledTimes(MCP_HEALTH_STAMP_MAX_ATTEMPTS);
    });
});
