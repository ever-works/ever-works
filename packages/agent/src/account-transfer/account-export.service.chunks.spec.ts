// Mock the data-repository module so we don't pull in fs-extra/isomorphic-git
// during unit-test runs. The service only invokes static `DataRepository.create`.
jest.mock('../generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn() },
}));

import { AccountExportService } from './account-export.service';
import { DataRepository } from '../generators/data-generator/data-repository';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

/**
 * `GET /api/account/export` on a large account answered with an edge 524:
 * the service read every Work's data repo at once — a clone or pull each, on
 * the API's single event loop — held the whole account in memory, and only
 * then produced a byte. These pin the two things that replace that:
 *
 *  - the Works are read in order, at most two at a time, by BOTH the payload
 *    method and the chunked one;
 *  - the chunked export's fragments join to exactly the payload's JSON, its
 *    first fragment exists before any repo is read, and a consumer that stops
 *    reading stops the walk.
 *
 * The fixture is thousands of multi-hundred-byte items over several Works —
 * megabytes, not a toy body that would fit in one write.
 */

interface Deferred {
    readonly promise: Promise<string>;
    resolve(): void;
}

function harness(options: { works: number; itemsPerWork: number; tail?: boolean }) {
    let inFlight = 0;
    let maxInFlight = 0;
    const cloneOrder: string[] = [];
    const pending: Deferred[] = [];
    let autoResolve = true;

    const works = Array.from({ length: options.works }, (_, i) => ({
        id: `work-${i}`,
        slug: `work-${i}`,
        name: `Work ${i}`,
        description: `Work number ${i}`,
        owner: 'octocat',
        userId: 'user-1',
        gitProvider: 'github',
        scheduledUpdatesEnabled: false,
        communityPrEnabled: false,
        communityPrAutoClose: false,
        comparisonsEnabled: true,
        user: { id: 'user-1' },
        getRepoOwner: () => 'octocat',
        getDataRepo: () => `work-${i}-data`,
    }));

    dataRepoCreateMock.mockReset();
    dataRepoCreateMock.mockImplementation(async (dest: string) => {
        const index = Number(dest.replace('/tmp/', ''));
        return {
            getItems: jest.fn().mockResolvedValue(
                Array.from({ length: options.itemsPerWork }, (_, item) => ({
                    slug: `w${index}-item-${item}`,
                    name: `Item ${item} of work ${index}`,
                    description: `${'x'.repeat(200)}-${index}-${item}`,
                    tags: ['a', 'b'],
                })),
            ),
            getCategories: jest.fn().mockResolvedValue([{ id: `cat-${index}`, name: 'Cat' }]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue({ title: `Work ${index}` }),
            getComparisons: jest.fn().mockResolvedValue([]),
            readMarkdownTemplate: jest.fn().mockResolvedValue(null),
            getComparisonMarkdown: jest.fn().mockResolvedValue(undefined),
        };
    });

    const gitFacade = {
        cloneOrPull: jest.fn(async ({ repo }: { repo: string }) => {
            cloneOrder.push(repo);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const index = repo.replace('work-', '').replace('-data', '');
            let resolve!: () => void;
            const promise = new Promise<string>((done) => {
                resolve = () => {
                    inFlight -= 1;
                    done(`/tmp/${index}`);
                };
            });
            if (autoResolve) {
                // Resolve on a later macrotask so overlapping reads really overlap.
                setTimeout(resolve, 5);
            } else {
                pending.push({ promise, resolve });
            }
            return promise;
        }),
    };

    const tailService = {
        exportTail: jest.fn().mockResolvedValue({
            agents: [{ slug: 'helper', name: 'Helper' }],
            skills: [],
            tasks: [{ title: 'Ship it' }],
        }),
    };

    const service = new AccountExportService(
        { findByUser: jest.fn().mockResolvedValue(works) } as any,
        { findByWork: jest.fn().mockResolvedValue([{ userId: 'user-1', role: 'owner' }]) } as any,
        { findByWork: jest.fn().mockResolvedValue([]) } as any,
        {
            findByUser: jest.fn().mockResolvedValue([
                {
                    pluginId: 'openai',
                    enabled: true,
                    autoEnableForWorks: false,
                    settings: { model: 'x' },
                    secretSettings: { apiKey: 'sk-real-secret' },
                },
            ]),
        } as any,
        { findByWork: jest.fn().mockResolvedValue([]) } as any,
        {
            findById: jest.fn().mockResolvedValue({
                username: 'octocat',
                email: 'octocat@example.invalid',
                avatar: null,
                digestFrequency: 'weekly',
            }),
        } as any,
        { findByWorkId: jest.fn().mockResolvedValue(null) } as any,
        { findByWorkId: jest.fn().mockResolvedValue(null) } as any,
        gitFacade as any,
        options.tail ? (tailService as any) : undefined,
    );

    return {
        service,
        gitFacade,
        cloneOrder,
        maxInFlight: () => maxInFlight,
        manual() {
            autoResolve = false;
        },
        releaseAll() {
            for (const deferred of pending.splice(0)) deferred.resolve();
        },
    };
}

async function collect(chunks: AsyncGenerator<string, void, undefined>): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of chunks) out.push(chunk);
    return out;
}

const withoutTimestamp = (text: string) =>
    text.replace(/"exportedAt":"[^"]+"/, '"exportedAt":"<t>"');

describe('AccountExportService — a large account', () => {
    it('joins its fragments to exactly the payload’s JSON, tail and masked secrets included', async () => {
        const options = {
            includeSecrets: true,
            includeAgents: true,
            includeSkills: true,
            includeTasks: true,
        };
        const whole = harness({ works: 6, itemsPerWork: 1_500, tail: true });
        const payload = await whole.service.exportAccountData('user-1', options);

        const streamed = harness({ works: 6, itemsPerWork: 1_500, tail: true });
        const fragments = await collect(
            streamed.service.exportAccountDataChunks('user-1', options),
        );
        const joined = fragments.join('');

        // Megabytes of body, in many writes — not one buffer's worth.
        expect(joined.length).toBeGreaterThan(2_000_000);
        expect(fragments.length).toBeGreaterThanOrEqual(6 + 2);
        expect(withoutTimestamp(joined)).toBe(withoutTimestamp(JSON.stringify(payload)));
        expect(payload.version).toBe(2);
        // The secret boundary holds on the streamed path too.
        expect(joined).not.toContain('sk-real-secret');
    }, 60_000);

    it('reads the Works in order, never more than two repos at once — payload and fragments alike', async () => {
        const whole = harness({ works: 9, itemsPerWork: 10 });
        const payload = await whole.service.exportAccountData('user-1');
        expect(whole.maxInFlight()).toBeLessThanOrEqual(2);
        expect(whole.maxInFlight()).toBe(2);
        expect(payload.data.works.map((work) => work.slug)).toEqual(
            Array.from({ length: 9 }, (_, i) => `work-${i}`),
        );

        const streamed = harness({ works: 9, itemsPerWork: 10 });
        const parsed = JSON.parse(
            (await collect(streamed.service.exportAccountDataChunks('user-1'))).join(''),
        ) as { data: { works: { slug: string }[] } };
        expect(streamed.maxInFlight()).toBe(2);
        expect(parsed.data.works.map((work) => work.slug)).toEqual(
            Array.from({ length: 9 }, (_, i) => `work-${i}`),
        );
    }, 30_000);

    it('has its first fragment before any repo is read, so a response can start at once', async () => {
        const h = harness({ works: 4, itemsPerWork: 5 });
        const chunks = h.service.exportAccountDataChunks('user-1');

        const first = await chunks.next();

        expect(first.done).toBe(false);
        expect(first.value).toMatch(/^\{"version":1,"exportedAt":"[^"]+","includesSecrets":false,/);
        expect(h.gitFacade.cloneOrPull).not.toHaveBeenCalled();
        await chunks.return(undefined);
    });

    it('stops starting Works once the consumer stops reading', async () => {
        const h = harness({ works: 20, itemsPerWork: 5 });
        const chunks = h.service.exportAccountDataChunks('user-1');

        await chunks.next(); // the envelope
        await chunks.next(); // work-0
        await chunks.return(undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));

        // work-0, plus the one read ahead of it, plus at most the one started
        // as work-0 was handed over — never all twenty.
        expect(h.cloneOrder.length).toBeLessThanOrEqual(3);
    });

    it('rejects the first fragment, before any byte, for an account that is not there', async () => {
        const h = harness({ works: 1, itemsPerWork: 1 });
        (
            h.service as unknown as { userRepository: { findById: jest.Mock } }
        ).userRepository.findById.mockResolvedValue(null);

        await expect(h.service.exportAccountDataChunks('missing').next()).rejects.toThrow(
            'User not found',
        );
        expect(h.gitFacade.cloneOrPull).not.toHaveBeenCalled();
    });

    it('holds no more than the window while repos are slow', async () => {
        const h = harness({ works: 8, itemsPerWork: 5 });
        h.manual();
        const chunks = h.service.exportAccountDataChunks('user-1');
        await chunks.next(); // envelope

        const second = chunks.next(); // waits on work-0
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Nothing resolved yet: exactly the window is being read.
        expect(h.cloneOrder).toEqual(['work-0-data', 'work-1-data']);

        h.releaseAll();
        await second;
        await chunks.return(undefined);
        h.releaseAll();
    });
});
