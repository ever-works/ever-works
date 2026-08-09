import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkflowsService } from '../workflows.service';
import { WorkflowStatus } from '../../entities/workflow.entity';
import type { WorkflowRepository } from '../../database/repositories/workflow.repository';

/**
 * Saved workflow graphs (judgment layer G5).
 *
 * Two properties carry this service:
 *
 *  1. A STORED graph is validated on write, so a row that exists is a
 *     row that can be executed. Deferring the check to run time would
 *     let a user save something that fails later with no idea which edit
 *     broke it, and would put the error in a background log instead of
 *     in the response to the request that caused it.
 *  2. Reads are owner-scoped and a foreign id is 404, never 403 — the
 *     collection must not be usable to discover which ids exist for
 *     other users.
 */

const validGraph = () => ({
    id: 'g-1',
    entryNodeId: 'a',
    nodes: [{ id: 'a', kind: 'noop' }],
    edges: [],
});

describe('WorkflowsService', () => {
    let repo: {
        create: jest.Mock;
        findByIdAndUser: jest.Mock;
        list: jest.Mock;
        update: jest.Mock;
        remove: jest.Mock;
    };
    let service: WorkflowsService;

    beforeEach(() => {
        repo = {
            create: jest.fn().mockImplementation(async (input) => ({ id: 'w1', ...input })),
            findByIdAndUser: jest.fn().mockResolvedValue({ id: 'w1', userId: 'u1' }),
            list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            update: jest.fn().mockImplementation(async (id, userId, patch) => ({ id, ...patch })),
            remove: jest.fn().mockResolvedValue(true),
        };
        service = new WorkflowsService(repo as unknown as WorkflowRepository);
    });

    afterEach(() => jest.restoreAllMocks());

    describe('create', () => {
        it('persists a valid graph and defaults to draft', async () => {
            await service.create('u1', { name: 'Nightly', graph: validGraph() });

            expect(repo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    name: 'Nightly',
                    status: WorkflowStatus.DRAFT,
                }),
            );
        });

        it('trims the name rather than storing the whitespace', async () => {
            await service.create('u1', { name: '  Nightly  ', graph: validGraph() });

            expect(repo.create.mock.calls[0][0].name).toBe('Nightly');
        });

        it('REFUSES a structurally invalid graph before it is stored', async () => {
            // The point of validating on write: an unrunnable row never
            // exists, so nothing discovers it mid-run.
            await expect(
                service.create('u1', {
                    name: 'Broken',
                    graph: { ...validGraph(), entryNodeId: 'missing' },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('returns the SPECIFIC structural errors, not just "invalid"', async () => {
            // A human is editing this graph; "invalid graph" with no
            // detail is the least useful thing an editor can say.
            await expect(
                service.create('u1', {
                    name: 'Broken',
                    graph: { ...validGraph(), entryNodeId: 'missing' },
                }),
            ).rejects.toMatchObject({
                response: expect.objectContaining({ errors: expect.any(Array) }),
            });
        });

        it('refuses a non-object graph', async () => {
            await expect(
                service.create('u1', { name: 'x', graph: 'not-a-graph' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('refuses a graph whose nodes are not an array', async () => {
            await expect(
                service.create('u1', { name: 'x', graph: { nodes: {}, edges: [] } }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('refuses a graph past the size ceiling', async () => {
            const nodes = Array.from({ length: WorkflowsService.MAX_NODES + 1 }, (_, i) => ({
                id: `n${i}`,
                kind: 'noop',
            }));
            await expect(
                service.create('u1', {
                    name: 'huge',
                    graph: { ...validGraph(), entryNodeId: 'n0', nodes },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('allows a graph far larger than the MODEL-authored cap', async () => {
            // A stored workflow is authored by a human, deliberately, and
            // is visible before it runs — the model clamps exist for a
            // situation that does not apply, and capping a hand-built
            // workflow at 4 delegate nodes would be borrowed strictness.
            const nodes = Array.from({ length: 50 }, (_, i) => ({
                id: `n${i}`,
                kind: 'agent.delegate',
            }));
            const edges = nodes.slice(0, -1).map((n, i) => ({
                id: `e${i}`,
                kind: 'sequential',
                from: n.id,
                to: nodes[i + 1].id,
            }));

            await expect(
                service.create('u1', {
                    name: 'big but legal',
                    graph: { id: 'g', entryNodeId: 'n0', nodes, edges },
                }),
            ).resolves.toBeDefined();
        });
    });

    it('REFUSES a node kind the runner cannot execute', async () => {
        // `validateWorkflowGraph` treats `kind` as opaque, so a graph
        // naming `shell.exec` validates cleanly and fails at RUN time.
        // Catching it on write is what makes "a stored workflow is
        // runnable" actually true rather than aspirational.
        await expect(
            service.create('u1', {
                name: 'sneaky',
                graph: {
                    id: 'g',
                    entryNodeId: 'a',
                    nodes: [{ id: 'a', kind: 'shell.exec' }],
                    edges: [],
                },
            }),
        ).rejects.toMatchObject({
            response: expect.objectContaining({
                message: expect.stringContaining('shell.exec'),
            }),
        });
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('accepts every kind the runner DOES implement', async () => {
        for (const kind of ['noop', 'ai.ask', 'kb.search', 'agent.delegate']) {
            await expect(
                service.create('u1', {
                    name: kind,
                    graph: { id: 'g', entryNodeId: 'a', nodes: [{ id: 'a', kind }], edges: [] },
                }),
            ).resolves.toBeDefined();
        }
    });

    describe('get', () => {
        it('reports another user’s workflow as 404, not 403', async () => {
            // The repository returns null for "missing" and "not yours"
            // alike, so the response cannot be used to probe which ids
            // exist elsewhere.
            repo.findByIdAndUser.mockResolvedValue(null);

            await expect(service.get('u1', 'w-someone-else')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('scopes the lookup to the acting user', async () => {
            await service.get('u1', 'w1');

            expect(repo.findByIdAndUser).toHaveBeenCalledWith('w1', 'u1');
        });
    });

    describe('update', () => {
        it('RE-VALIDATES a supplied graph', async () => {
            // Otherwise "a stored workflow is runnable" is a one-time
            // property that any PATCH could quietly break.
            await expect(
                service.update('u1', 'w1', { graph: { ...validGraph(), entryNodeId: 'nope' } }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repo.update).not.toHaveBeenCalled();
        });

        it('leaves the graph alone when the patch does not mention it', async () => {
            await service.update('u1', 'w1', { name: 'Renamed' });

            const patch = repo.update.mock.calls[0][2];
            expect(patch).not.toHaveProperty('graph');
            expect(patch.name).toBe('Renamed');
        });

        it('reports a foreign workflow as 404', async () => {
            repo.update.mockResolvedValue(null);

            await expect(service.update('u1', 'w1', { name: 'x' })).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('remove', () => {
        it('reports a foreign workflow as 404 rather than silently succeeding', async () => {
            repo.remove.mockResolvedValue(false);

            await expect(service.remove('u1', 'w1')).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
