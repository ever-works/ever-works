import { FindOperator } from 'typeorm';
import { TaskDeliveryService } from '../task-delivery.service';
import type { Task } from '../../entities/task.entity';

/**
 * APW-08 T24 — `GET /api/tasks?includeDelivery=true`: `TaskDeliveryService.listEmbeds`, the
 * board chip's inputs for a page of Tasks.
 *
 *  - only tracked Tasks get an entry (an untracked Task's chip is never drawn);
 *  - the deciding Deployments of the whole page are read in ONE `IN` query, keyed on the rows'
 *    own `deliveryDeploymentId` (never on client input), and only for the two states that show
 *    a Deployment detail (`live`, `deploy_failed`);
 *  - the live URL, the failure outcome, the warnings and "a later change" are each reported only
 *    in the state whose chip shows them;
 *  - a failed Deployment read degrades to the states alone — the list never fails for a chip.
 */

const MERGE = '3f9c2ab000000000000000000000000000000001';
const LATER = 'b0b0b0b000000000000000000000000000000002';

type Row = Record<string, unknown>;

function deploymentsRepo(rows: Row[]) {
    return {
        find: jest.fn(async (options: { where: { id: unknown } }) => {
            const operator = options.where.id as FindOperator<string[]>;
            const ids = (operator as unknown as { value: string[] }).value;
            return rows.filter((row) => ids.includes(row.id as string));
        }),
    };
}

function make(deployments: ReturnType<typeof deploymentsRepo>) {
    const unused = {} as never;
    return new TaskDeliveryService(unused, unused, deployments as never, unused, unused);
}

function task(id: string, overrides: Partial<Task> = {}) {
    return {
        id,
        deliveryState: null,
        deliveryDeploymentId: null,
        mergeCommitSha: MERGE,
        ...overrides,
    } as Pick<Task, 'id' | 'deliveryState' | 'deliveryDeploymentId' | 'mergeCommitSha'>;
}

describe('TaskDeliveryService.listEmbeds (APW-08 T24)', () => {
    it('skips untracked Tasks and reads nothing for a page without a tracked one', async () => {
        const repo = deploymentsRepo([]);
        const embeds = await make(repo).listEmbeds([task('a'), task('b', { deliveryState: 'bogus' })]);
        expect(embeds.size).toBe(0);
        expect(repo.find).not.toHaveBeenCalled();
    });

    it('reads every deciding Deployment of the page in one IN query, only for live / deploy_failed', async () => {
        const repo = deploymentsRepo([
            { id: 'd-live', state: 'READY', commitSha: MERGE, website: 'https://bookings.example.app' },
            { id: 'd-failed', state: 'ROLLED_BACK', commitSha: MERGE, website: null },
        ]);
        const embeds = await make(repo).listEmbeds([
            task('live', { deliveryState: 'live', deliveryDeploymentId: 'd-live' }),
            task('failed', { deliveryState: 'deploy_failed', deliveryDeploymentId: 'd-failed' }),
            task('deploying', { deliveryState: 'deploying', deliveryDeploymentId: 'd-other' }),
            task('merged', { deliveryState: 'merged' }),
        ]);

        expect(repo.find).toHaveBeenCalledTimes(1);
        const ids = (repo.find.mock.calls[0][0].where.id as unknown as { value: string[] }).value;
        expect([...ids].sort()).toEqual(['d-failed', 'd-live']);

        expect(embeds.get('live')).toEqual({
            state: 'live',
            liveUrl: 'https://bookings.example.app',
            outcome: null,
            liveWithWarnings: false,
            carriedByLaterChange: false,
        });
        expect(embeds.get('failed')).toEqual({
            state: 'deploy_failed',
            liveUrl: null,
            outcome: 'rolled_back',
            liveWithWarnings: false,
            carriedByLaterChange: false,
        });
        expect(embeds.get('deploying')).toMatchObject({ state: 'deploying', liveUrl: null, outcome: null });
        expect(embeds.get('merged')).toMatchObject({ state: 'merged', liveUrl: null });
    });

    it('reports warnings and a later change on a live Task only', async () => {
        const repo = deploymentsRepo([
            {
                id: 'd-1',
                state: 'READY',
                commitSha: LATER,
                website: 'https://bookings.example.app',
                appRender: { warnings: ['slow first paint'] },
            },
        ]);
        const embeds = await make(repo).listEmbeds([
            task('live', { deliveryState: 'live', deliveryDeploymentId: 'd-1' }),
        ]);
        expect(embeds.get('live')).toMatchObject({
            state: 'live',
            liveWithWarnings: true,
            carriedByLaterChange: true,
        });
    });

    it('a failed Deployment read degrades to the states alone', async () => {
        const repo = { find: jest.fn().mockRejectedValue(new Error('db down')) };
        const embeds = await make(repo as never).listEmbeds([
            task('live', { deliveryState: 'live', deliveryDeploymentId: 'd-1' }),
        ]);
        expect(embeds.get('live')).toEqual({
            state: 'live',
            liveUrl: null,
            outcome: null,
            liveWithWarnings: false,
            carriedByLaterChange: false,
        });
    });
});
