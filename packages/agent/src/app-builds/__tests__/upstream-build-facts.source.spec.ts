import { UpstreamBuildFactsSource } from '../upstream-build-facts.source';

/**
 * APW-05 T16 — the repository facts a Build cannot guess.
 *
 * `createdByAppWork` decides whether a workflow change is pushed straight to the
 * branch or goes through a pull request (R-4). Getting it wrong in the
 * permissive direction pushes a commit into a repository that is not ours, which
 * is why every case below that cannot establish the answer asserts the safe one.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';

function source(findByWorkId: () => Promise<unknown>) {
    return new UpstreamBuildFactsSource({ findByWorkId } as never);
}

describe('UpstreamBuildFactsSource (APW-05 T16)', () => {
    it('a fork is ours to write into', async () => {
        const facts = await source(async () => ({ relation: 'fork' })).getBuildRepositoryFacts({
            workId: WORK_ID,
        });

        expect(facts?.createdByAppWork).toBe(true);
    });

    it('a private copy is too — the App Work created it', async () => {
        const facts = await source(async () => ({
            relation: 'private-copy',
        })).getBuildRepositoryFacts({ workId: WORK_ID });

        expect(facts?.createdByAppWork).toBe(true);
    });

    it('a LINK is not — a linked repository is not ours, whatever its branch protection says', async () => {
        const facts = await source(async () => ({ relation: 'link' })).getBuildRepositoryFacts({
            workId: WORK_ID,
        });

        expect(facts?.createdByAppWork).toBe(false);
    });

    it('a Work with no upstream row gets the safe answer, not an assumption', async () => {
        // No row means creation is still in flight, or this was never an App
        // Work. Reporting `true` would let a Build push a workflow commit into a
        // repository whose provenance nobody has recorded.
        const facts = await source(async () => null).getBuildRepositoryFacts({ workId: WORK_ID });

        expect(facts).toEqual({ visibility: 'private', createdByAppWork: false });
    });

    it('a failing read is the safe answer too, never a throw', async () => {
        const facts = await source(async () => {
            throw new Error('the database is down');
        }).getBuildRepositoryFacts({ workId: WORK_ID });

        expect(facts).toEqual({ visibility: 'private', createdByAppWork: false });
    });

    it('reports `private` for every relation, because no column records visibility yet', async () => {
        // Stated as an assertion rather than left implicit: this is the one
        // method that changes when APW-02 records the provider's visibility, and
        // until then `private` is the safe answer (a private repository on a
        // public runner is the failure that matters; a public one on the private
        // runner is only slower).
        for (const relation of ['fork', 'private-copy', 'link']) {
            const facts = await source(async () => ({ relation })).getBuildRepositoryFacts({
                workId: WORK_ID,
            });
            expect([relation, facts?.visibility]).toEqual([relation, 'private']);
        }
    });
});
