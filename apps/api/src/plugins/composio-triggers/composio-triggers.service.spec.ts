import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ComposioTriggerSubscription } from '@ever-works/agent/entities';
import { ComposioTriggersService } from './composio-triggers.service';

function buildRepoStub() {
    return {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn((data: Partial<ComposioTriggerSubscription>) => data),
        save: jest.fn((row: Partial<ComposioTriggerSubscription>) => ({
            ...row,
            id: 'sub-1',
        })),
        delete: jest.fn(),
        increment: jest.fn(),
        update: jest.fn(),
    };
}

describe('ComposioTriggersService', () => {
    let service: ComposioTriggersService;
    let repo: ReturnType<typeof buildRepoStub>;

    beforeEach(async () => {
        repo = buildRepoStub();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ComposioTriggersService,
                { provide: getRepositoryToken(ComposioTriggerSubscription), useValue: repo },
            ],
        }).compile();
        service = module.get(ComposioTriggersService);
    });

    describe('create', () => {
        it('mints a 64-hex-char webhook secret and uppercases toolkit + trigger slugs', async () => {
            await service.create('user-1', 'tg_abc', {
                toolkitSlug: 'gmail',
                triggerSlug: 'gmail_new_email',
                composioConnectedAccountId: 'ca_1',
            });
            const saved = repo.save.mock.calls[0][0];
            expect(saved.toolkitSlug).toBe('GMAIL');
            expect(saved.triggerSlug).toBe('GMAIL_NEW_EMAIL');
            expect(saved.composioTriggerId).toBe('tg_abc');
            expect(saved.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('remove', () => {
        it('throws NotFoundException when the subscription is not owned by the caller', async () => {
            repo.findOne.mockResolvedValue(null);
            await expect(service.remove('user-1', 'sub-x')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('deletes when found and returns the composio trigger id for upstream teardown', async () => {
            repo.findOne.mockResolvedValue({
                id: 'sub-1',
                userId: 'user-1',
                composioTriggerId: 'tg_abc',
            });
            const result = await service.remove('user-1', 'sub-1');
            expect(repo.delete).toHaveBeenCalledWith({ id: 'sub-1' });
            expect(result).toBe('tg_abc');
        });
    });

    describe('recordDelivery', () => {
        it('increments deliveriesReceived and sets lastFiredAt on accepted', async () => {
            await service.recordDelivery('sub-1', 'accepted');
            expect(repo.increment).toHaveBeenCalledWith({ id: 'sub-1' }, 'deliveriesReceived', 1);
            expect(repo.update).toHaveBeenCalled();
            const updateArgs = repo.update.mock.calls[0][1];
            expect(updateArgs.lastFiredAt).toBeInstanceOf(Date);
        });

        it('increments deliveriesRejected (and does not touch lastFiredAt) on rejected', async () => {
            await service.recordDelivery('sub-1', 'rejected');
            expect(repo.increment).toHaveBeenCalledWith({ id: 'sub-1' }, 'deliveriesRejected', 1);
            expect(repo.update).not.toHaveBeenCalled();
        });
    });
});
