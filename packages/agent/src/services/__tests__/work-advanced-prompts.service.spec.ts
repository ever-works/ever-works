import { WorkAdvancedPromptsService } from '../work-advanced-prompts.service';
import type { WorkAdvancedPrompts } from '@src/entities/work-advanced-prompts.entity';
import type { UpdateWorkAdvancedPromptsDto } from '@src/dto/work-advanced-prompts.dto';

describe('WorkAdvancedPromptsService', () => {
    let repository: {
        findByWorkId: jest.Mock;
        createOrUpdate: jest.Mock;
        delete: jest.Mock;
    };
    let ownershipService: {
        ensureAccess: jest.Mock;
        ensureCanEdit: jest.Mock;
    };
    let service: WorkAdvancedPromptsService;

    beforeEach(() => {
        repository = {
            findByWorkId: jest.fn(),
            createOrUpdate: jest.fn(),
            delete: jest.fn(),
        };
        ownershipService = {
            ensureAccess: jest.fn().mockResolvedValue({}),
            ensureCanEdit: jest.fn().mockResolvedValue({}),
        };
        service = new WorkAdvancedPromptsService(
            repository as any,
            ownershipService as any,
        );
    });

    const buildPrompts = (
        overrides: Partial<WorkAdvancedPrompts> = {},
    ): WorkAdvancedPrompts =>
        ({
            id: 'row-1',
            workId: 'w-1',
            relevanceAssessment: 'rel',
            itemGeneration: 'gen',
            itemExtraction: 'ext',
            searchQuery: 'search',
            categorization: 'cat',
            deduplication: 'dedup',
            sourceValidation: 'src',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-05-01T12:34:56.000Z'),
            ...overrides,
        }) as WorkAdvancedPrompts;

    describe('getAdvancedPrompts', () => {
        it('calls ensureAccess before findByWorkId and forwards positional (workId, userId)', async () => {
            const order: string[] = [];
            ownershipService.ensureAccess.mockImplementation(async () => {
                order.push('ensureAccess');
            });
            repository.findByWorkId.mockImplementation(async () => {
                order.push('findByWorkId');
                return null;
            });

            await service.getAdvancedPrompts('w-1', 'u-1');

            expect(order).toEqual(['ensureAccess', 'findByWorkId']);
            expect(ownershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'u-1');
            expect(repository.findByWorkId).toHaveBeenCalledWith('w-1');
        });

        it('does not invoke ensureCanEdit (viewer access is sufficient)', async () => {
            repository.findByWorkId.mockResolvedValue(null);

            await service.getAdvancedPrompts('w-1', 'u-1');

            expect(ownershipService.ensureCanEdit).not.toHaveBeenCalled();
        });

        it('short-circuits and skips repository when ensureAccess rejects', async () => {
            const err = new Error('forbidden');
            ownershipService.ensureAccess.mockRejectedValueOnce(err);

            await expect(service.getAdvancedPrompts('w-1', 'u-1')).rejects.toBe(err);
            expect(repository.findByWorkId).not.toHaveBeenCalled();
        });

        it('returns an all-null envelope keyed by workId when no row exists', async () => {
            repository.findByWorkId.mockResolvedValue(null);

            const result = await service.getAdvancedPrompts('w-1', 'u-1');

            expect(result).toEqual({
                workId: 'w-1',
                relevanceAssessment: null,
                itemGeneration: null,
                itemExtraction: null,
                searchQuery: null,
                categorization: null,
                deduplication: null,
                sourceValidation: null,
                updatedAt: null,
            });
        });

        it('uses caller-supplied workId in the response (not the row workId) so a future repo bug cannot leak a different works prompts back', async () => {
            // Pinned current behaviour: response.workId is sourced from the
            // caller arg, not from the persisted row. This prevents a
            // hypothetical "findByWorkId returns the wrong row" bug from
            // surfacing as a confused-deputy data leak in the response.
            repository.findByWorkId.mockResolvedValue(buildPrompts({ workId: 'OTHER-WORK' }));

            const result = await service.getAdvancedPrompts('w-1', 'u-1');

            expect(result.workId).toBe('w-1');
        });

        it('maps every populated field verbatim and serialises updatedAt as ISO 8601', async () => {
            repository.findByWorkId.mockResolvedValue(buildPrompts());

            const result = await service.getAdvancedPrompts('w-1', 'u-1');

            expect(result).toEqual({
                workId: 'w-1',
                relevanceAssessment: 'rel',
                itemGeneration: 'gen',
                itemExtraction: 'ext',
                searchQuery: 'search',
                categorization: 'cat',
                deduplication: 'dedup',
                sourceValidation: 'src',
                updatedAt: '2026-05-01T12:34:56.000Z',
            });
        });

        it('coerces missing prompt fields (undefined) to null via the ?? operator', async () => {
            // The entity columns are nullable: undefined and null both
            // surface as null in the response. Pinned because a future
            // swap from `??` to `||` would still pass for undefined but
            // an explicit empty-string would be silently coerced to null
            // — and an explicit empty string is currently preserved.
            repository.findByWorkId.mockResolvedValue(
                buildPrompts({
                    relevanceAssessment: undefined,
                    itemGeneration: null,
                    itemExtraction: '',
                }),
            );

            const result = await service.getAdvancedPrompts('w-1', 'u-1');

            expect(result.relevanceAssessment).toBeNull();
            expect(result.itemGeneration).toBeNull();
            expect(result.itemExtraction).toBe('');
        });

        it('coerces missing updatedAt (null/undefined) to null in the response', async () => {
            repository.findByWorkId.mockResolvedValue(
                buildPrompts({ updatedAt: undefined as any }),
            );

            const result = await service.getAdvancedPrompts('w-1', 'u-1');

            expect(result.updatedAt).toBeNull();
        });
    });

    describe('updateAdvancedPrompts', () => {
        const dto: UpdateWorkAdvancedPromptsDto = {
            relevanceAssessment: 'r',
            itemGeneration: 'g',
            itemExtraction: 'e',
            searchQuery: 's',
            categorization: 'c',
            deduplication: 'd',
            sourceValidation: 'v',
        };

        it('calls ensureCanEdit before createOrUpdate and forwards positional args', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
            });
            repository.createOrUpdate.mockImplementation(async () => {
                order.push('createOrUpdate');
                return buildPrompts();
            });

            await service.updateAdvancedPrompts('w-1', dto, 'u-1');

            expect(order).toEqual(['ensureCanEdit', 'createOrUpdate']);
            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'u-1');
        });

        it('does not call ensureAccess (editor gate already strictly subsumes viewer)', async () => {
            repository.createOrUpdate.mockResolvedValue(buildPrompts());

            await service.updateAdvancedPrompts('w-1', dto, 'u-1');

            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
        });

        it('forwards each documented prompt field by exact key — no extras smuggled from the dto', async () => {
            const fatDto = {
                ...dto,
                // Smuggled extras that should NOT reach the repository:
                workId: 'OTHER-WORK',
                userId: 'OTHER-USER',
                evil: 'pwn',
            } as unknown as UpdateWorkAdvancedPromptsDto;
            repository.createOrUpdate.mockResolvedValue(buildPrompts());

            await service.updateAdvancedPrompts('w-1', fatDto, 'u-1');

            const [workIdArg, payload] = repository.createOrUpdate.mock.calls[0];
            expect(workIdArg).toBe('w-1');
            // Pin the EXACT 7 documented keys — a future field rename or
            // a "spread the dto" refactor that would leak `workId`/`userId`
            // into the persisted row breaks loudly.
            expect(Object.keys(payload).sort()).toEqual(
                [
                    'categorization',
                    'deduplication',
                    'itemExtraction',
                    'itemGeneration',
                    'relevanceAssessment',
                    'searchQuery',
                    'sourceValidation',
                ].sort(),
            );
            expect(payload).not.toHaveProperty('workId');
            expect(payload).not.toHaveProperty('userId');
            expect(payload).not.toHaveProperty('evil');
        });

        it('forwards undefined fields verbatim without any default coercion', async () => {
            // Pinned current behaviour: the service does NOT apply `??`
            // or any default in the update path; the repository's
            // `createOrUpdate` decides what undefined means. A future
            // "default to null" refactor would change this contract.
            repository.createOrUpdate.mockResolvedValue(buildPrompts());

            await service.updateAdvancedPrompts('w-1', {} as UpdateWorkAdvancedPromptsDto, 'u-1');

            const [, payload] = repository.createOrUpdate.mock.calls[0];
            expect(payload.relevanceAssessment).toBeUndefined();
            expect(payload.itemGeneration).toBeUndefined();
            expect(payload.itemExtraction).toBeUndefined();
            expect(payload.searchQuery).toBeUndefined();
            expect(payload.categorization).toBeUndefined();
            expect(payload.deduplication).toBeUndefined();
            expect(payload.sourceValidation).toBeUndefined();
        });

        it('forwards explicit null values verbatim (the documented "clear this prompt" sentinel)', async () => {
            const clearAll: UpdateWorkAdvancedPromptsDto = {
                relevanceAssessment: null,
                itemGeneration: null,
                itemExtraction: null,
                searchQuery: null,
                categorization: null,
                deduplication: null,
                sourceValidation: null,
            };
            repository.createOrUpdate.mockResolvedValue(buildPrompts());

            await service.updateAdvancedPrompts('w-1', clearAll, 'u-1');

            const [, payload] = repository.createOrUpdate.mock.calls[0];
            expect(payload).toEqual(clearAll);
        });

        it('returns the updated row mapped through toResponseDto using the caller workId', async () => {
            repository.createOrUpdate.mockResolvedValue(
                buildPrompts({ workId: 'OTHER-WORK', updatedAt: new Date('2026-05-09T00:00:00.000Z') }),
            );

            const result = await service.updateAdvancedPrompts('w-1', dto, 'u-1');

            expect(result.workId).toBe('w-1');
            expect(result.updatedAt).toBe('2026-05-09T00:00:00.000Z');
        });

        it('short-circuits and skips createOrUpdate when ensureCanEdit rejects', async () => {
            const err = new Error('forbidden');
            ownershipService.ensureCanEdit.mockRejectedValueOnce(err);

            await expect(service.updateAdvancedPrompts('w-1', dto, 'u-1')).rejects.toBe(err);
            expect(repository.createOrUpdate).not.toHaveBeenCalled();
        });

        it('propagates repository rejection verbatim', async () => {
            const err = new Error('db down');
            repository.createOrUpdate.mockRejectedValueOnce(err);

            await expect(service.updateAdvancedPrompts('w-1', dto, 'u-1')).rejects.toBe(err);
        });
    });

    describe('getPromptsForGeneration', () => {
        it('forwards workId to repository.findByWorkId WITHOUT calling ownershipService (pipeline-internal)', async () => {
            // Pinned current behaviour: this method is documented as
            // "no auth" because it is invoked by the items-generator
            // pipeline AFTER the user-facing access check has run on
            // the work itself. A future tightening to also gate this
            // method would be a deliberate change.
            repository.findByWorkId.mockResolvedValue(null);

            await service.getPromptsForGeneration('w-1');

            expect(repository.findByWorkId).toHaveBeenCalledWith('w-1');
            expect(ownershipService.ensureAccess).not.toHaveBeenCalled();
            expect(ownershipService.ensureCanEdit).not.toHaveBeenCalled();
        });

        it('returns the row reference verbatim (no defensive copy, no toResponseDto mapping)', async () => {
            const row = buildPrompts();
            repository.findByWorkId.mockResolvedValue(row);

            const result = await service.getPromptsForGeneration('w-1');

            // identity check — pipeline consumers rely on the entity
            // shape (Date objects on createdAt/updatedAt etc.), not the
            // ISO-string projection used by the HTTP response DTO.
            expect(result).toBe(row);
        });

        it('returns null when no row exists', async () => {
            repository.findByWorkId.mockResolvedValue(null);

            const result = await service.getPromptsForGeneration('w-1');

            expect(result).toBeNull();
        });

        it('propagates repository rejection verbatim', async () => {
            const err = new Error('db down');
            repository.findByWorkId.mockRejectedValueOnce(err);

            await expect(service.getPromptsForGeneration('w-1')).rejects.toBe(err);
        });
    });

    describe('deleteAdvancedPrompts', () => {
        it('calls ensureCanEdit before repository.delete and forwards positional args', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
            });
            repository.delete.mockImplementation(async () => {
                order.push('delete');
                return true;
            });

            await service.deleteAdvancedPrompts('w-1', 'u-1');

            expect(order).toEqual(['ensureCanEdit', 'delete']);
            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'u-1');
            expect(repository.delete).toHaveBeenCalledWith('w-1');
        });

        it('returns repository.delete result verbatim — true on success', async () => {
            repository.delete.mockResolvedValue(true);

            const result = await service.deleteAdvancedPrompts('w-1', 'u-1');

            expect(result).toBe(true);
        });

        it('returns repository.delete result verbatim — false when no row was deleted', async () => {
            repository.delete.mockResolvedValue(false);

            const result = await service.deleteAdvancedPrompts('w-1', 'u-1');

            expect(result).toBe(false);
        });

        it('short-circuits and skips repository.delete when ensureCanEdit rejects', async () => {
            const err = new Error('forbidden');
            ownershipService.ensureCanEdit.mockRejectedValueOnce(err);

            await expect(service.deleteAdvancedPrompts('w-1', 'u-1')).rejects.toBe(err);
            expect(repository.delete).not.toHaveBeenCalled();
        });

        it('propagates repository rejection verbatim', async () => {
            const err = new Error('db down');
            repository.delete.mockRejectedValueOnce(err);

            await expect(service.deleteAdvancedPrompts('w-1', 'u-1')).rejects.toBe(err);
        });
    });
});
