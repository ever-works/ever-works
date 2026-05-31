import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the network layer so we test the factory's guard + routing logic only.
vi.mock('./api-call', () => ({
    callApi: vi.fn(async () => ({ success: true, data: { ok: true } })),
}));

import { callApi } from './api-call';
import { buildGeneratedTools } from './factory';
import type { OperationSpec } from './registry';

const specs: OperationSpec[] = [
    {
        toolName: 'get_thing',
        method: 'GET',
        path: '/api/things/{id}',
        summary: 'Get a thing',
        kind: 'read',
        params: [
            { name: 'id', in: 'path', required: true, type: 'string' },
            { name: 'q', in: 'query', type: 'string' },
        ],
    },
    {
        toolName: 'make_thing',
        method: 'POST',
        path: '/api/things',
        summary: 'Make',
        kind: 'create',
        body: true,
    },
    {
        toolName: 'del_thing',
        method: 'DELETE',
        path: '/api/things/{id}',
        summary: 'Delete a thing',
        kind: 'destructive',
        params: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },
];

// The AI SDK tool's execute ignores the second (options) argument here.
type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>>;
const run = (tool: unknown, args: Record<string, unknown>) =>
    ((tool as { execute: Exec }).execute as Exec)(args, {});

describe('buildGeneratedTools', () => {
    const tools = buildGeneratedTools(specs);
    beforeEach(() => vi.mocked(callApi).mockClear());

    it('routes path + query params', async () => {
        await run(tools.get_thing, { id: '42', q: 'x' });
        expect(callApi).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'GET',
                path: '/api/things/{id}',
                pathParams: { id: '42' },
                query: { q: 'x' },
            }),
        );
    });

    it('forwards the body for mutations', async () => {
        await run(tools.make_thing, { body: { name: 'n' } });
        expect(callApi).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'POST', body: { name: 'n' } }),
        );
    });

    it('blocks a destructive op without confirmed and does not call the API', async () => {
        const result = await run(tools.del_thing, { id: '42' });
        expect(result.__confirmationRequired).toBe(true);
        expect(result.toolName).toBe('del_thing');
        expect(callApi).not.toHaveBeenCalled();
    });

    it('performs the destructive op once confirmed: true', async () => {
        await run(tools.del_thing, { id: '42', confirmed: true });
        expect(callApi).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'DELETE', pathParams: { id: '42' } }),
        );
    });

    it('rejects bulk id arrays and does not call the API', async () => {
        const result = await run(tools.make_thing, { body: { ids: ['a', 'b', 'c'] } });
        expect(result.bulkRejected).toBe(true);
        expect(callApi).not.toHaveBeenCalled();
    });

    it('allows a single id (not bulk)', async () => {
        await run(tools.make_thing, { body: { ids: ['only-one'] } });
        expect(callApi).toHaveBeenCalled();
    });
});
