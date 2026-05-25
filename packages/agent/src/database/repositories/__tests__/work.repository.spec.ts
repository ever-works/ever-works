import type { Repository, SelectQueryBuilder, Brackets } from 'typeorm';
import { In, IsNull, LessThanOrEqual } from 'typeorm';
import { WorkRepository } from '../work.repository';
import { Work } from '../../../entities/work.entity';
import type { User } from '../../../entities';

type Mocked = jest.Mocked<
    Pick<
        Repository<Work>,
        | 'create'
        | 'save'
        | 'findOne'
        | 'find'
        | 'count'
        | 'update'
        | 'increment'
        | 'delete'
        | 'createQueryBuilder'
    >
>;

function buildChain<TResult>(terminalName: string, terminalResolved: TResult) {
    const fns: Record<string, jest.Mock> = {};
    const chain: any = {};

    const passthroughMethods = [
        'where',
        'andWhere',
        'orWhere',
        'orderBy',
        'addOrderBy',
        'select',
        'addSelect',
        'leftJoin',
        'leftJoinAndSelect',
        'skip',
        'take',
    ];

    for (const m of passthroughMethods) {
        fns[m] = jest.fn(() => chain);
        chain[m] = fns[m];
    }

    fns[terminalName] = jest.fn().mockResolvedValue(terminalResolved);
    chain[terminalName] = fns[terminalName];

    return { chain, fns };
}

describe('WorkRepository', () => {
    let repository: Mocked;
    let service: WorkRepository;
    const user = { id: 'u1' } as User;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            update: jest.fn(),
            increment: jest.fn(),
            delete: jest.fn(),
            createQueryBuilder: jest.fn(),
        };
        // Phase 2 PR F — getAccessibleStats now also runs 2 raw
        // COUNT(*) queries (missions + work_proposals) via
        // `repository.manager.query`. Stub it with a no-op that
        // returns the empty-result shape (`[{ c: 0 }]`) so the
        // numeric coercion path still works in tests that don't
        // care about the mission/idea counts. Tests that DO care
        // about specific values override per-test via mockResolvedValueOnce.
        (repository as unknown as { manager: { query: jest.Mock } }).manager = {
            query: jest.fn().mockResolvedValue([{ c: '0' }]),
        };
        service = new WorkRepository(repository as unknown as Repository<Work>);
    });

    describe('create', () => {
        it('throws "Work already exists" when findByOwnerAndSlug returns a row (no save call)', async () => {
            // First findOne resolves with an existing row (the duplicate-check inside findByOwnerAndSlug)
            repository.findOne.mockResolvedValueOnce({ id: 'w1' } as Work);

            await expect(service.create({ owner: 'me', slug: 'site' }, user)).rejects.toThrow(
                'Work already exists',
            );

            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
        });

        it('happy path: no duplicate → create + save + refetch via findById (which also joins user)', async () => {
            repository.findOne
                .mockResolvedValueOnce(null) // duplicate check
                .mockResolvedValueOnce({ id: 'w1', name: 'X' } as Work); // findById refetch
            const created = {} as Work;
            const saved = { id: 'w1' } as Work;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.create({ owner: 'me', slug: 'site', name: 'X' }, user);

            expect(result).toEqual({ id: 'w1', name: 'X' });
            expect(repository.create).toHaveBeenCalledWith({
                owner: 'me',
                slug: 'site',
                name: 'X',
            });
            expect(repository.save).toHaveBeenCalledWith(created);
            // refetch via findById uses {where:{id}, relations:['user']}
            expect(repository.findOne).toHaveBeenLastCalledWith({
                where: { id: 'w1' },
                relations: ['user'],
            });
        });
    });

    describe('createOrUpdate', () => {
        it('updates the existing row when found AND owned by the user (`exists.userId === user.id`)', async () => {
            repository.findOne
                .mockResolvedValueOnce({ id: 'w1', userId: user.id } as Work) // duplicate-check finds owned row
                .mockResolvedValueOnce({ id: 'w1', userId: user.id, name: 'updated' } as Work) // findById refetch via update()
                .mockResolvedValueOnce({ id: 'w1', userId: user.id, name: 'updated' } as Work); // final findById refetch
            repository.update.mockResolvedValueOnce({} as never);
            repository.save.mockResolvedValueOnce({ id: 'w1' } as Work);

            await service.createOrUpdate({ name: 'updated' }, user);

            expect(repository.update).toHaveBeenCalledWith('w1', { name: 'updated' });
            // create is NOT called when updating
            expect(repository.create).not.toHaveBeenCalled();
        });

        it('creates a NEW row when an existing row is owned by ANOTHER user (current behaviour pin: the dup-check returns a foreign row, but the code falls through to create — slug uniqueness is enforced at the schema level)', async () => {
            repository.findOne
                .mockResolvedValueOnce({ id: 'w-other', userId: 'other-user' } as Work)
                .mockResolvedValueOnce({ id: 'w2' } as Work);
            const created = {} as Work;
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce({ id: 'w2' } as Work);

            await service.createOrUpdate({ slug: 'site', owner: 'other' }, user);

            expect(repository.create).toHaveBeenCalledWith({ slug: 'site', owner: 'other' });
            expect(repository.update).not.toHaveBeenCalled();
        });

        it('creates a NEW row when no duplicate exists', async () => {
            repository.findOne
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: 'w3' } as Work);
            repository.create.mockReturnValueOnce({} as Work);
            repository.save.mockResolvedValueOnce({ id: 'w3' } as Work);

            await service.createOrUpdate({ slug: 'fresh' }, user);

            expect(repository.create).toHaveBeenCalledWith({ slug: 'fresh' });
            expect(repository.update).not.toHaveBeenCalled();
        });
    });

    describe('findByOwnerAndSlug', () => {
        it('queries by (userId, owner, slug) when owner is truthy, joining user', async () => {
            const row = { id: 'w1' } as Work;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(
                service.findByOwnerAndSlug({
                    userId: 'u1',
                    owner: 'me',
                    slug: 'site',
                }),
            ).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { userId: 'u1', owner: 'me', slug: 'site' },
                relations: ['user'],
            });
        });

        it('falls back to (userId, slug) when owner is empty/falsy (`owner ? {…} : {…}` ternary — pinned because empty-owner is a valid linked-repo case)', async () => {
            const row = { id: 'w1' } as Work;
            repository.findOne.mockResolvedValueOnce(row);

            await service.findByOwnerAndSlug({
                userId: 'u1',
                owner: '',
                slug: 'site',
            });

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { userId: 'u1', slug: 'site' },
                relations: ['user'],
            });
        });
    });

    describe('findById', () => {
        it('joins the user relation', async () => {
            const row = { id: 'w1' } as Work;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findById('w1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'w1' },
                relations: ['user'],
            });
        });
    });

    describe('findByIdForAccess', () => {
        it('loads the work row plus safe owner fields through query builder', async () => {
            const row = { id: 'w1' } as Work;
            const { chain, fns } = buildChain<Work | null>('getOne', row);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.findByIdForAccess('w1')).resolves.toBe(row);

            expect(repository.findOne).not.toHaveBeenCalled();
            expect(repository.createQueryBuilder).toHaveBeenCalledWith('work');
            expect(fns.leftJoin).toHaveBeenCalledWith('work.user', 'user');
            expect(fns.addSelect).toHaveBeenCalledWith([
                'user.id',
                'user.username',
                'user.email',
                'user.committerName',
                'user.committerEmail',
            ]);
            expect(fns.where).toHaveBeenCalledWith({ id: 'w1' });
        });
    });

    describe('findByIds', () => {
        it('returns [] without touching the repository when ids is empty (avoids `IN ()` SQL syntax error)', async () => {
            await expect(service.findByIds([])).resolves.toEqual([]);
            expect(repository.find).not.toHaveBeenCalled();
        });

        it('returns [] without touching the repository when every id is falsy (filtered out)', async () => {
            await expect(
                service.findByIds(['', null as unknown as string, undefined as unknown as string]),
            ).resolves.toEqual([]);
            expect(repository.find).not.toHaveBeenCalled();
        });

        it('dedupes ids via `new Set(...)` before querying (so callers that build ids from multiple sources do not pay for duplicates)', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findByIds(['w1', 'w2', 'w1', 'w3', 'w2']);

            expect(repository.find).toHaveBeenCalledWith({
                where: { id: In(['w1', 'w2', 'w3']) },
                relations: ['user'],
            });
        });

        it('strips falsy ids before deduping', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findByIds(['w1', '', 'w2', null as unknown as string]);

            expect(repository.find).toHaveBeenCalledWith({
                where: { id: In(['w1', 'w2']) },
                relations: ['user'],
            });
        });
    });

    describe('findByDeploymentStates', () => {
        it('returns [] without touching the repository when states is empty', async () => {
            await expect(service.findByDeploymentStates([])).resolves.toEqual([]);
            expect(repository.find).not.toHaveBeenCalled();
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('selects only deployment poller fields and avoids eager user loading', async () => {
            const rows = [{ id: 'w1', slug: 'site' }] as Work[];
            const { chain, fns } = buildChain('getMany', rows);
            repository.createQueryBuilder.mockReturnValueOnce(chain as SelectQueryBuilder<Work>);

            await expect(service.findByDeploymentStates(['pending'], 50)).resolves.toBe(rows);

            expect(repository.find).not.toHaveBeenCalled();
            expect(repository.createQueryBuilder).toHaveBeenCalledWith('work');
            expect(fns.select).toHaveBeenCalledWith([
                'work.id',
                'work.slug',
                'work.deploymentState',
                'work.deploymentStartedAt',
                'work.lastDeployCorrelationId',
            ]);
            expect(fns.where).toHaveBeenCalledWith({ deploymentState: In(['pending']) });
            expect(fns.orderBy).toHaveBeenCalledWith('work.id', 'ASC');
            expect(fns.take).toHaveBeenCalledWith(50);
            expect(fns.getMany).toHaveBeenCalledTimes(1);
        });
    });

    describe('findAll', () => {
        it('with no options: only order + relations (NO where, no take, no skip)', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll();

            expect(repository.find).toHaveBeenCalledWith({
                order: { id: 'DESC' },
                relations: ['user'],
            });
        });

        it('with userId only: where = { userId } object form', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll({ userId: 'u1' });

            const opts = repository.find.mock.calls[0][0] as Record<string, unknown>;
            expect(opts.where).toEqual({ userId: 'u1' });
        });

        it('with search only (no userId): where = array of three OR conditions on name/description/slug, each with a Raw operator', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll({ search: ' Hello%World ' });

            const opts = repository.find.mock.calls[0][0] as { where: any[] };
            expect(Array.isArray(opts.where)).toBe(true);
            expect(opts.where).toHaveLength(3);
            const keys = opts.where.map((c: Record<string, unknown>) => Object.keys(c)[0]);
            expect(keys).toEqual(['name', 'description', 'slug']);
            for (const cond of opts.where) {
                const value = Object.values(cond)[0] as {
                    _type: string;
                    _objectLiteralParameters: { search: string };
                };
                expect(value._type).toBe('raw');
                expect(value._objectLiteralParameters).toEqual({
                    search: '%hello\\%world%',
                });
            }
        });

        it('with userId AND search: every search clause in the OR-array is composed with the userId scope', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll({ userId: 'u1', search: 'foo' });

            const opts = repository.find.mock.calls[0][0] as { where: any[] };
            expect(opts.where).toHaveLength(3);
            for (const cond of opts.where) {
                expect(cond.userId).toBe('u1');
            }
        });

        it('with userId + whitespace-only search: pattern empty → falls back to where:{userId} (NOT array form)', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll({ userId: 'u1', search: '   ' });

            const opts = repository.find.mock.calls[0][0] as Record<string, unknown>;
            expect(opts.where).toEqual({ userId: 'u1' });
        });

        it('truthy limit/offset → forwards as take/skip', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll({ userId: 'u1', limit: 10, offset: 5 });

            const opts = repository.find.mock.calls[0][0] as Record<string, unknown>;
            expect(opts.take).toBe(10);
            expect(opts.skip).toBe(5);
        });

        it('limit:0 / offset:0 → falsy short-circuit means take/skip are NOT forwarded (current behaviour pin: `if (limit) findOptions.take = limit`)', async () => {
            repository.find.mockResolvedValueOnce([] as Work[]);

            await service.findAll({ userId: 'u1', limit: 0, offset: 0 });

            const opts = repository.find.mock.calls[0][0] as Record<string, unknown>;
            expect(opts).not.toHaveProperty('take');
            expect(opts).not.toHaveProperty('skip');
        });
    });

    describe('countAll', () => {
        it('with no options: count() with no where', async () => {
            repository.count.mockResolvedValueOnce(7);

            await expect(service.countAll()).resolves.toBe(7);

            expect(repository.count).toHaveBeenCalledWith({});
        });

        it('with userId: where:{userId}', async () => {
            repository.count.mockResolvedValueOnce(2);

            await service.countAll({ userId: 'u1' });

            expect(repository.count).toHaveBeenCalledWith({ where: { userId: 'u1' } });
        });

        it('with userId + search: where = OR-array of three search conditions, each scoped to userId', async () => {
            repository.count.mockResolvedValueOnce(0);

            await service.countAll({ userId: 'u1', search: 'foo' });

            const opts = repository.count.mock.calls[0][0] as { where: any[] };
            expect(Array.isArray(opts.where)).toBe(true);
            expect(opts.where).toHaveLength(3);
        });
    });

    describe('update', () => {
        it('updates by id then refetches via findById (so the returned row reflects post-update state)', async () => {
            const refetched = { id: 'w1', name: 'updated' } as Work;
            repository.update.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(refetched);

            const result = await service.update('w1', { name: 'updated' });

            expect(result).toBe(refetched);
            expect(repository.update).toHaveBeenCalledWith('w1', { name: 'updated' });
            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'w1' },
                relations: ['user'],
            });
        });

        it('returns null when the row vanished between update and refetch', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            repository.findOne.mockResolvedValueOnce(null);

            await expect(service.update('w1', {})).resolves.toBeNull();
        });
    });

    describe('increment', () => {
        it('forwards the column name + value to TypeORM increment with the {id} criteria object', async () => {
            repository.increment.mockResolvedValueOnce({} as never);

            await service.increment('w1', 'itemsCount', 5);

            expect(repository.increment).toHaveBeenCalledWith({ id: 'w1' }, 'itemsCount', 5);
        });

        it('forwards negative values verbatim (decrement is just `increment(-N)`; pinned so a future "guard against negatives" tightening would be a deliberate change)', async () => {
            repository.increment.mockResolvedValueOnce({} as never);

            await service.increment('w1', 'itemsCount', -3);

            expect(repository.increment).toHaveBeenCalledWith({ id: 'w1' }, 'itemsCount', -3);
        });
    });

    describe('delete / deleteBySlug', () => {
        it('delete returns affected > 0 (uses `>` NOT `>=` so affected===0 is false)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 1 } as never);
            await expect(service.delete('w1')).resolves.toBe(true);

            expect(repository.delete).toHaveBeenCalledWith('w1');
        });

        it('delete affected===0 → false', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 0 } as never);
            await expect(service.delete('w1')).resolves.toBe(false);
        });

        it('deleteBySlug deletes by composite (slug, userId)', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 1 } as never);

            await expect(service.deleteBySlug('site', 'u1')).resolves.toBe(true);

            expect(repository.delete).toHaveBeenCalledWith({ slug: 'site', userId: 'u1' });
        });

        it('deleteBySlug affected===0 → false', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 0 } as never);
            await expect(service.deleteBySlug('site', 'u1')).resolves.toBe(false);
        });
    });

    describe('exists / existsByUserAndSlug', () => {
        it('exists queries by (slug, userId) and returns count > 0', async () => {
            repository.count.mockResolvedValueOnce(1);
            await expect(service.exists('site', 'u1')).resolves.toBe(true);

            expect(repository.count).toHaveBeenCalledWith({
                where: { slug: 'site', userId: 'u1' },
            });
        });

        it('exists returns false when count === 0', async () => {
            repository.count.mockResolvedValueOnce(0);
            await expect(service.exists('site', 'u1')).resolves.toBe(false);
        });

        it('existsByUserAndSlug uses the same composite (just argument order swapped at the call site — the WHERE shape is identical to exists)', async () => {
            repository.count.mockResolvedValueOnce(1);
            await expect(service.existsByUserAndSlug('u1', 'site')).resolves.toBe(true);

            expect(repository.count).toHaveBeenCalledWith({
                where: { userId: 'u1', slug: 'site' },
            });
        });
    });

    describe('countByUserAndWebsiteTemplateId', () => {
        it('counts works using a specific template id (drives the "Cannot archive — N works still use this template" UI copy)', async () => {
            repository.count.mockResolvedValueOnce(3);

            await expect(service.countByUserAndWebsiteTemplateId('u1', 't1')).resolves.toBe(3);

            expect(repository.count).toHaveBeenCalledWith({
                where: { userId: 'u1', websiteTemplateId: 't1' },
            });
        });
    });

    describe('countByUserAndInheritedWebsiteTemplateSelection', () => {
        it('counts works whose websiteTemplateId IS NULL (those inherit the global default)', async () => {
            repository.count.mockResolvedValueOnce(4);

            await expect(
                service.countByUserAndInheritedWebsiteTemplateSelection('u1'),
            ).resolves.toBe(4);

            expect(repository.count).toHaveBeenCalledWith({
                where: { userId: 'u1', websiteTemplateId: IsNull() },
            });
        });
    });

    describe('findByUser', () => {
        it('queries by userId only, NO relations joined (used for high-volume listing where user data already in scope)', async () => {
            const rows = [{ id: 'w1' } as Work];
            repository.find.mockResolvedValueOnce(rows);

            await expect(service.findByUser('u1')).resolves.toBe(rows);

            expect(repository.find).toHaveBeenCalledWith({ where: { userId: 'u1' } });
        });
    });

    describe('updateLastPullRequest', () => {
        it('merges the new lastPullRequest fields onto the existing fields (so a `data` PR update does not erase the `main` PR)', async () => {
            repository.findOne
                // first findById refetch returns existing PR state
                .mockResolvedValueOnce({
                    id: 'w1',
                    lastPullRequest: {
                        main: { number: 1 },
                    },
                } as unknown as Work);
            repository.update.mockResolvedValueOnce({} as never);

            await service.updateLastPullRequest('w1', {
                data: { number: 2 },
            } as unknown as Work['lastPullRequest']);

            expect(repository.update).toHaveBeenCalledWith('w1', {
                lastPullRequest: {
                    main: { number: 1 },
                    data: { number: 2 },
                },
            });
        });

        it('overwrites existing keys when both old and new have the same key (spread order: existing first, new last — last wins)', async () => {
            repository.findOne.mockResolvedValueOnce({
                id: 'w1',
                lastPullRequest: { main: { number: 1 } },
            } as unknown as Work);
            repository.update.mockResolvedValueOnce({} as never);

            await service.updateLastPullRequest('w1', {
                main: { number: 99 },
            } as unknown as Work['lastPullRequest']);

            expect(repository.update).toHaveBeenCalledWith('w1', {
                lastPullRequest: { main: { number: 99 } },
            });
        });
    });

    describe('updateGenerateStatus', () => {
        it('dedupes warnings via `new Set(...)` and sets generationProgressedAt to a fresh Date', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            const before = Date.now();

            await service.updateGenerateStatus('w1', {
                status: 'generating',
                warnings: ['dup', 'unique', 'dup'],
            } as never);

            const after = Date.now();
            const updateCall = repository.update.mock.calls[0][1] as {
                generateStatus: { warnings: string[] };
                generationProgressedAt: Date;
            };
            expect(updateCall.generateStatus.warnings).toEqual(['dup', 'unique']);
            expect(updateCall.generationProgressedAt).toBeInstanceOf(Date);
            expect(updateCall.generationProgressedAt.getTime()).toBeGreaterThanOrEqual(before);
            expect(updateCall.generationProgressedAt.getTime()).toBeLessThanOrEqual(after);
        });

        it('preserves generateStatus verbatim when warnings is missing or empty (no defensive `warnings:[]` injection)', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            await service.updateGenerateStatus('w1', { status: 'pending' } as never);

            const updateCall = repository.update.mock.calls[0][1] as {
                generateStatus: Record<string, unknown>;
            };
            expect(updateCall.generateStatus).toEqual({ status: 'pending' });
            expect(updateCall.generateStatus).not.toHaveProperty('warnings');
        });

        it('passes empty-warnings array through verbatim (current behaviour pin: empty `warnings:[]` short-circuits the `?.warnings?.length` guard so the original status object reference is reused)', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            const status = { status: 'completed', warnings: [] } as never;
            await service.updateGenerateStatus('w1', status);

            const updateCall = repository.update.mock.calls[0][1] as {
                generateStatus: unknown;
            };
            expect(updateCall.generateStatus).toBe(status);
        });

        it('handles null/undefined generateStatus without crashing (optional-chain guard `?.warnings?.length`)', async () => {
            repository.update.mockResolvedValueOnce({} as never);

            await service.updateGenerateStatus('w1', null as never);

            const updateCall = repository.update.mock.calls[0][1] as {
                generateStatus: unknown;
            };
            expect(updateCall.generateStatus).toBeNull();
        });
    });

    describe('recordGenerationStartTime', () => {
        it('writes generationStartedAt + generationProgressedAt to the SAME date AND resets generationFinishedAt to null (so a re-run clears prior finish state)', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            const startedAt = new Date('2026-05-01T00:00:00Z');

            await service.recordGenerationStartTime('w1', startedAt);

            expect(repository.update).toHaveBeenCalledWith('w1', {
                generationStartedAt: startedAt,
                generationProgressedAt: startedAt,
                generationFinishedAt: null,
            });
        });
    });

    describe('recordGenerationFinishTime', () => {
        it('writes ONLY generationFinishedAt (does NOT touch progressedAt — that is the "stalled-job-detector" knob)', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            const finishedAt = new Date('2026-05-01T00:00:00Z');

            await service.recordGenerationFinishTime('w1', finishedAt);

            expect(repository.update).toHaveBeenCalledWith('w1', {
                generationFinishedAt: finishedAt,
            });
            const partial = repository.update.mock.calls[0][1] as Record<string, unknown>;
            expect(partial).not.toHaveProperty('generationProgressedAt');
            expect(partial).not.toHaveProperty('generationStartedAt');
        });
    });

    describe('getUnfinishedGenerations', () => {
        it('queries works whose progressedAt is older than the given cutoff AND finishedAt IS NULL (so completed runs are excluded even if last progress was stale)', async () => {
            const olderThan = new Date('2026-05-01T00:00:00Z');
            const rows = [{ id: 'w1' } as Work];
            const { chain, fns } = buildChain<Work[]>('getMany', rows);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.getUnfinishedGenerations(olderThan)).resolves.toBe(rows);

            expect(repository.find).not.toHaveBeenCalled();
            expect(repository.createQueryBuilder).toHaveBeenCalledWith('work');
            expect(fns.select).toHaveBeenCalledWith(['work.id', 'work.generateStatus']);
            expect(fns.where).toHaveBeenCalledWith('work.generationProgressedAt < :olderThan', {
                olderThan: olderThan.getTime(),
            });
            expect(fns.andWhere).toHaveBeenCalledWith('work.generationFinishedAt IS NULL');
        });
    });

    describe('findAllAccessible', () => {
        it('returns [] when userId is missing without touching the query builder', async () => {
            await expect(service.findAllAccessible()).resolves.toEqual([]);
            await expect(service.findAllAccessible({ userId: '' })).resolves.toEqual([]);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('userId only (no memberWorkIds): a simple `work.userId = :userId` where without the OR-Brackets', async () => {
            const { chain, fns } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.findAllAccessible({ userId: 'u1' });

            expect(fns.where).toHaveBeenCalledWith('work.userId = :userId', { userId: 'u1' });
            // No Brackets call (only the simple shape)
            const bracketsCalls = fns.where.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(0);
            expect(fns.orderBy).toHaveBeenCalledWith('work.updatedAt', 'DESC');
        });

        it('userId + non-empty memberWorkIds: composes a Brackets with userId-OR-membership clauses', async () => {
            const { chain, fns } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.findAllAccessible({
                userId: 'u1',
                memberWorkIds: ['w-mem-1', 'w-mem-2'],
            });

            const bracketsCalls = fns.where.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(1);

            // Drive the Brackets factory through a sub-chain
            const subFns: Record<string, jest.Mock> = {};
            const subChain: any = {};
            for (const m of ['where', 'orWhere']) {
                subFns[m] = jest.fn(() => subChain);
                subChain[m] = subFns[m];
            }
            const brackets = bracketsCalls[0][0] as Brackets;
            (brackets as any).whereFactory(subChain);

            expect(subFns.where).toHaveBeenCalledWith('work.userId = :userId', {
                userId: 'u1',
            });
            expect(subFns.orWhere).toHaveBeenCalledWith('work.id IN (:...memberWorkIds)', {
                memberWorkIds: ['w-mem-1', 'w-mem-2'],
            });
        });

        it('with search, registers an additional Brackets with case-insensitive name/description/slug LIKE clauses', async () => {
            const { chain, fns } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.findAllAccessible({ userId: 'u1', search: 'foo' });

            const bracketsCalls = fns.andWhere.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(1);

            const subFns: Record<string, jest.Mock> = {};
            const subChain: any = {};
            for (const m of ['where', 'orWhere']) {
                subFns[m] = jest.fn(() => subChain);
                subChain[m] = subFns[m];
            }
            const brackets = bracketsCalls[0][0] as Brackets;
            (brackets as any).whereFactory(subChain);

            expect(subFns.where).toHaveBeenCalledWith(
                expect.stringContaining('LOWER(work.name) LIKE :search'),
                { search: '%foo%' },
            );
            expect(subFns.orWhere).toHaveBeenCalledWith(
                expect.stringContaining('LOWER(work.description) LIKE :search'),
                { search: '%foo%' },
            );
            expect(subFns.orWhere).toHaveBeenCalledWith(
                expect.stringContaining('LOWER(work.slug) LIKE :search'),
                { search: '%foo%' },
            );
        });

        it('whitespace-only search → pattern empty → search Brackets NOT registered', async () => {
            const { chain, fns } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.findAllAccessible({ userId: 'u1', search: '   ' });

            const bracketsCalls = fns.andWhere.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(0);
        });

        it('truthy limit/offset → take/skip; falsy → omitted (`if (limit) qb.take(limit)`)', async () => {
            const { chain, fns } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.findAllAccessible({
                userId: 'u1',
                limit: 10,
                offset: 5,
            });

            expect(fns.take).toHaveBeenCalledWith(10);
            expect(fns.skip).toHaveBeenCalledWith(5);

            const { chain: chain2, fns: fns2 } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain2 as unknown as SelectQueryBuilder<Work>,
            );

            await service.findAllAccessible({ userId: 'u1', limit: 0, offset: 0 });

            expect(fns2.take).not.toHaveBeenCalled();
            expect(fns2.skip).not.toHaveBeenCalled();
        });
    });

    describe('countAllAccessible', () => {
        it('returns 0 when userId is missing without touching the query builder', async () => {
            await expect(service.countAllAccessible()).resolves.toBe(0);
            await expect(service.countAllAccessible({ userId: '' })).resolves.toBe(0);
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('userId only: simple where + getCount', async () => {
            const { chain, fns } = buildChain<number>('getCount', 5);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.countAllAccessible({ userId: 'u1' })).resolves.toBe(5);

            expect(fns.where).toHaveBeenCalledWith('work.userId = :userId', { userId: 'u1' });
        });

        it('userId + memberWorkIds: composes Brackets with the same OR-membership shape as findAllAccessible', async () => {
            const { chain, fns } = buildChain<number>('getCount', 0);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.countAllAccessible({
                userId: 'u1',
                memberWorkIds: ['w-mem-1'],
            });

            const bracketsCalls = fns.where.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(1);
        });

        it('search Brackets fires when search is non-empty', async () => {
            const { chain, fns } = buildChain<number>('getCount', 0);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.countAllAccessible({ userId: 'u1', search: 'foo' });

            const bracketsCalls = fns.andWhere.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(1);
        });
    });

    describe('getAccessibleStats', () => {
        it('returns the zero envelope when userId is missing without touching the query builder', async () => {
            await expect(service.getAccessibleStats({ userId: '' })).resolves.toEqual({
                totalWorks: 0,
                totalItems: 0,
                activeWebsites: 0,
                generatingCount: 0,
                // Phase 2 PR F — new tiles included in the
                // empty-user envelope.
                totalMissions: 0,
                totalIdeas: 0,
            });
            expect(repository.createQueryBuilder).not.toHaveBeenCalled();
        });

        it('coerces every aggregate column from string to number via parseInt(_, 10) || 0 — and pins the LIKE-on-simple-json gate string for the generatingCount column', async () => {
            const getRawOne = jest.fn().mockResolvedValueOnce({
                totalWorks: '10',
                totalItems: '50',
                activeWebsites: '7',
                generatingCount: '2',
            });
            const fns: Record<string, jest.Mock> = {};
            const chain: any = {};
            for (const m of ['where', 'andWhere', 'select', 'addSelect']) {
                fns[m] = jest.fn(() => chain);
                chain[m] = fns[m];
            }
            chain.getRawOne = getRawOne;
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.getAccessibleStats({ userId: 'u1' })).resolves.toEqual({
                totalWorks: 10,
                totalItems: 50,
                activeWebsites: 7,
                generatingCount: 2,
                // Phase 2 PR F — manager.query mock returns
                // `[{ c: '0' }]` from the beforeEach default; missions
                // + ideas counts therefore parse to 0.
                totalMissions: 0,
                totalIdeas: 0,
            });

            // Pin the four select column shapes
            expect(fns.select).toHaveBeenCalledWith('COUNT(*)', 'totalWorks');
            expect(fns.addSelect).toHaveBeenCalledWith(
                'COALESCE(SUM(work.itemsCount), 0)',
                'totalItems',
            );
            expect(fns.addSelect).toHaveBeenCalledWith(
                expect.stringContaining(
                    "COALESCE(SUM(CASE WHEN work.website IS NOT NULL AND work.website != '' THEN 1 ELSE 0 END), 0)",
                ),
                'activeWebsites',
            );
            // generatingCount uses LIKE on the serialized simple-json — pinned because
            // simple-json portability across SQLite / MySQL / Postgres rules out JSON
            // operators.
            expect(fns.addSelect).toHaveBeenCalledWith(
                expect.stringContaining(`work.generateStatus LIKE '%"status":"generating"%'`),
                'generatingCount',
            );
        });

        it('non-numeric / undefined / null → 0 via `|| 0` fallback', async () => {
            const getRawOne = jest.fn().mockResolvedValueOnce({
                totalWorks: 'NaN',
                totalItems: undefined,
                activeWebsites: null,
                generatingCount: '',
            });
            const fns: Record<string, jest.Mock> = {};
            const chain: any = {};
            for (const m of ['where', 'andWhere', 'select', 'addSelect']) {
                fns[m] = jest.fn(() => chain);
                chain[m] = fns[m];
            }
            chain.getRawOne = getRawOne;
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.getAccessibleStats({ userId: 'u1' })).resolves.toEqual({
                totalWorks: 0,
                totalItems: 0,
                activeWebsites: 0,
                generatingCount: 0,
                // Phase 2 PR F — defaults from the beforeEach
                // manager.query stub.
                totalMissions: 0,
                totalIdeas: 0,
            });
        });

        it('userId + memberWorkIds: composes the Brackets membership filter (so accessible-stats matches accessible-list scope)', async () => {
            const getRawOne = jest.fn().mockResolvedValueOnce({
                totalWorks: '0',
                totalItems: '0',
                activeWebsites: '0',
                generatingCount: '0',
            });
            const fns: Record<string, jest.Mock> = {};
            const chain: any = {};
            for (const m of ['where', 'andWhere', 'select', 'addSelect']) {
                fns[m] = jest.fn(() => chain);
                chain[m] = fns[m];
            }
            chain.getRawOne = getRawOne;
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.getAccessibleStats({
                userId: 'u1',
                memberWorkIds: ['w-mem-1'],
            });

            const bracketsCalls = fns.where.mock.calls.filter(
                (call: unknown[]) => call.length === 1,
            );
            expect(bracketsCalls).toHaveLength(1);
        });
    });

    describe('findByIdWithMembers', () => {
        it('joins user + members + members.user (used by the per-work member roster page)', async () => {
            const row = { id: 'w1' } as Work;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByIdWithMembers('w1')).resolves.toBe(row);

            expect(repository.findOne).toHaveBeenCalledWith({
                where: { id: 'w1' },
                relations: ['user', 'members', 'members.user'],
            });
        });
    });

    describe('feature-flag finders', () => {
        it.each([
            ['findWithWebsiteAutoUpdateEnabled', { websiteTemplateAutoUpdate: true }],
            ['findWithCommunityPrEnabled', { communityPrEnabled: true }],
            ['findWithComparisonsEnabled', { comparisonsEnabled: true }],
            ['findWithScheduledSourceValidationEnabled', { scheduledUpdatesEnabled: true }],
        ] as const)('%s queries by the flag with user joined', async (method, where) => {
            const rows = [{ id: 'w1' } as Work];
            repository.find.mockResolvedValueOnce(rows);

            await (service as unknown as Record<string, () => Promise<Work[]>>)[method]();

            expect(repository.find).toHaveBeenCalledWith({
                where,
                relations: ['user'],
            });
        });
    });

    describe('detail-cache warmup', () => {
        it('countForDetailCacheWarmup uses COALESCE(itemsCount,0) > 0 (so works that never generated items do not warm)', async () => {
            const { chain, fns } = buildChain<number>('getCount', 12);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.countForDetailCacheWarmup()).resolves.toBe(12);

            expect(repository.createQueryBuilder).toHaveBeenCalledWith('work');
            expect(fns.where).toHaveBeenCalledWith('COALESCE(work.itemsCount, 0) > 0');
        });

        it('findForDetailCacheWarmup orders by updatedAt:DESC then id:ASC for deterministic paging across ties (with skip+take applied)', async () => {
            const rows = [{ id: 'w1' } as Work];
            const { chain, fns } = buildChain<Work[]>('getMany', rows);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await expect(service.findForDetailCacheWarmup(50, 100)).resolves.toBe(rows);

            expect(fns.leftJoinAndSelect).toHaveBeenCalledWith('work.user', 'user');
            expect(fns.select).toHaveBeenCalledWith([
                'work.id',
                'work.generateStatus',
                'work.itemsCount',
                'work.updatedAt',
                'user.id',
            ]);
            expect(fns.where).toHaveBeenCalledWith('COALESCE(work.itemsCount, 0) > 0');
            expect(fns.orderBy).toHaveBeenCalledWith('work.updatedAt', 'DESC');
            expect(fns.addOrderBy).toHaveBeenCalledWith('work.id', 'ASC');
            expect(fns.skip).toHaveBeenCalledWith(100);
            expect(fns.take).toHaveBeenCalledWith(50);
        });

        it('findForDetailCacheWarmup defaults offset to 0 when omitted', async () => {
            const { chain, fns } = buildChain<Work[]>('getMany', []);
            repository.createQueryBuilder.mockReturnValueOnce(
                chain as unknown as SelectQueryBuilder<Work>,
            );

            await service.findForDetailCacheWarmup(20);

            expect(fns.skip).toHaveBeenCalledWith(0);
            expect(fns.take).toHaveBeenCalledWith(20);
        });
    });

    describe('findDueSourceValidation', () => {
        it('queries enabled rows whose nextRunAt is <= now() with user joined, ordered ASC for FIFO settlement', async () => {
            const rows = [{ id: 'w1' } as Work];
            repository.find.mockResolvedValueOnce(rows);

            const before = Date.now();
            await expect(service.findDueSourceValidation(10)).resolves.toBe(rows);
            const after = Date.now();

            const opts = repository.find.mock.calls[0][0] as {
                where: {
                    sourceValidationEnabled: boolean;
                    sourceValidationNextRunAt: ReturnType<typeof LessThanOrEqual<Date>>;
                };
                order: { sourceValidationNextRunAt: 'ASC' };
                take: number;
                relations: string[];
            };
            expect(opts.where.sourceValidationEnabled).toBe(true);
            // Pin the structural shape of the LessThanOrEqual operator + its bounded date
            const op = opts.where.sourceValidationNextRunAt as unknown as {
                _value: Date;
            };
            expect(op._value).toBeInstanceOf(Date);
            expect(op._value.getTime()).toBeGreaterThanOrEqual(before);
            expect(op._value.getTime()).toBeLessThanOrEqual(after);
            expect(opts.order).toEqual({ sourceValidationNextRunAt: 'ASC' });
            expect(opts.take).toBe(10);
            expect(opts.relations).toEqual(['user']);
        });
    });

    describe('updateSourceValidationRun', () => {
        it('writes lastRunAt to a fresh Date AND nextRunAt to the supplied schedule (caller computes the next cadence)', async () => {
            repository.update.mockResolvedValueOnce({} as never);
            const nextRunAt = new Date('2026-05-09T01:00:00Z');
            const before = Date.now();

            await service.updateSourceValidationRun('w1', nextRunAt);

            const after = Date.now();
            const partial = repository.update.mock.calls[0][1] as {
                sourceValidationLastRunAt: Date;
                sourceValidationNextRunAt: Date;
            };
            expect(partial.sourceValidationLastRunAt).toBeInstanceOf(Date);
            expect(partial.sourceValidationLastRunAt.getTime()).toBeGreaterThanOrEqual(before);
            expect(partial.sourceValidationLastRunAt.getTime()).toBeLessThanOrEqual(after);
            expect(partial.sourceValidationNextRunAt).toBe(nextRunAt);
        });
    });

    // EW-641 Phase 2/e row 37d — `findIdsByOrganization` resolves
    // target Works for the KB org-overlay fanout enqueue.
    describe('findIdsByOrganization', () => {
        it('returns empty array (no DB hit) when organizationId is falsy', async () => {
            const result = await service.findIdsByOrganization('');
            expect(result).toEqual([]);
            expect(repository.find).not.toHaveBeenCalled();
        });

        it('queries by organizationId with id-only projection ordered ASC', async () => {
            repository.find.mockResolvedValueOnce([
                { id: 'w-a' },
                { id: 'w-b' },
                { id: 'w-c' },
            ] as Work[]);

            const result = await service.findIdsByOrganization('org-1');

            expect(result).toEqual(['w-a', 'w-b', 'w-c']);
            expect(repository.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { organizationId: 'org-1' },
                    order: { id: 'ASC' },
                }),
            );
            // id-only projection — avoids hydrating user / every column for
            // an enqueue payload that only needs ids.
            const call = repository.find.mock.calls[0][0] as {
                select?: { id?: boolean };
            };
            expect(call.select).toEqual({ id: true });
        });

        it('returns [] when the org has no Works', async () => {
            repository.find.mockResolvedValueOnce([]);
            const result = await service.findIdsByOrganization('org-empty');
            expect(result).toEqual([]);
        });
    });
});
