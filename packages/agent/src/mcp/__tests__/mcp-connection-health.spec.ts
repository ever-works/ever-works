import { MCP_ERROR_MESSAGES, mcpHealthErrorCode } from '../mcp-connection-health';
import {
    MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE,
    formatMissingCredentialMessage,
} from '../mcp-header-credentials';
import { McpServerConnectionRepository } from '../../database/repositories/mcp-server-connection.repository';

describe('mcpHealthErrorCode', () => {
    it('maps every classified client message to its health code', () => {
        expect(mcpHealthErrorCode(formatMissingCredentialMessage(['docs_token']))).toBe(
            'credential_missing',
        );
        expect(mcpHealthErrorCode(MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE)).toBe(
            'insecure_transport',
        );
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
            update: jest.fn().mockResolvedValue(undefined),
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

    it('a missing credential expires the row and keeps the key-only message', async () => {
        const { repo, typeorm } = makeRepo(0);
        const error = formatMissingCredentialMessage(['docs_token']);
        await repo.stampConnectionResult('c1', { ok: false, error });

        expect(typeorm.update).toHaveBeenCalledWith(
            'c1',
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
            'c1',
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
            'c1',
            expect.objectContaining({ health: 'expired', lastErrorCode: 'credential_rejected' }),
        );
    });

    it('does not touch lastConnectedAt on failure (the last success stays visible)', async () => {
        const { repo, typeorm } = makeRepo(0);
        await repo.stampConnectionResult('c1', { ok: false, error: 'boom' });
        expect(typeorm.update.mock.calls[0][1]).not.toHaveProperty('lastConnectedAt');
    });
});
