import type { Repository } from 'typeorm';
import { WorkAdvancedPromptsRepository } from '../work-advanced-prompts.repository';
import { WorkAdvancedPrompts } from '../../../entities/work-advanced-prompts.entity';

type Mocked = jest.Mocked<
    Pick<Repository<WorkAdvancedPrompts>, 'findOne' | 'update' | 'create' | 'save' | 'delete'>
>;

describe('WorkAdvancedPromptsRepository', () => {
    let repository: Mocked;
    let service: WorkAdvancedPromptsRepository;

    beforeEach(() => {
        repository = {
            findOne: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
        };
        service = new WorkAdvancedPromptsRepository(
            repository as unknown as Repository<WorkAdvancedPrompts>,
        );
    });

    describe('findByWorkId', () => {
        it('forwards workId into the where clause', async () => {
            const row = { id: 'a', workId: 'w1' } as WorkAdvancedPrompts;
            repository.findOne.mockResolvedValueOnce(row);

            await expect(service.findByWorkId('w1')).resolves.toBe(row);
            expect(repository.findOne).toHaveBeenCalledWith({ where: { workId: 'w1' } });
        });

        it('returns null when no row exists', async () => {
            repository.findOne.mockResolvedValueOnce(null);
            await expect(service.findByWorkId('missing')).resolves.toBeNull();
        });
    });

    describe('createOrUpdate', () => {
        it('updates by primary key and refetches when a row already exists for the workId', async () => {
            const existing = { id: 'a', workId: 'w1' } as WorkAdvancedPrompts;
            const refreshed = {
                id: 'a',
                workId: 'w1',
                categorization: 'p',
            } as unknown as WorkAdvancedPrompts;
            repository.findOne
                .mockResolvedValueOnce(existing) // initial findByWorkId
                .mockResolvedValueOnce(refreshed); // refetch after update

            const result = await service.createOrUpdate('w1', { categorization: 'p' });

            expect(result).toBe(refreshed);
            expect(repository.update).toHaveBeenCalledWith(existing.id, { categorization: 'p' });
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.save).not.toHaveBeenCalled();
            expect(repository.findOne).toHaveBeenNthCalledWith(2, { where: { workId: 'w1' } });
        });

        it('creates a new row with workId merged into the data when none exists', async () => {
            const created = { workId: 'w1' } as WorkAdvancedPrompts;
            const saved = { id: 'a', workId: 'w1' } as WorkAdvancedPrompts;
            repository.findOne.mockResolvedValueOnce(null);
            repository.create.mockReturnValueOnce(created);
            repository.save.mockResolvedValueOnce(saved);

            const result = await service.createOrUpdate('w1', { itemGeneration: 'item' });

            expect(result).toBe(saved);
            expect(repository.create).toHaveBeenCalledWith({
                workId: 'w1',
                itemGeneration: 'item',
            });
            expect(repository.save).toHaveBeenCalledWith(created);
            expect(repository.update).not.toHaveBeenCalled();
        });
    });

    describe('delete', () => {
        it('returns true when the delete affected rows', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 1, raw: {} });
            await expect(service.delete('w1')).resolves.toBe(true);
            expect(repository.delete).toHaveBeenCalledWith({ workId: 'w1' });
        });

        it('returns false when affected is 0', async () => {
            repository.delete.mockResolvedValueOnce({ affected: 0, raw: {} });
            await expect(service.delete('w1')).resolves.toBe(false);
        });

        it('treats undefined affected as falsy (>0 short-circuits)', async () => {
            repository.delete.mockResolvedValueOnce({ raw: {} } as never);
            await expect(service.delete('w1')).resolves.toBe(false);
        });
    });
});
