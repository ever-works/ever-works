import { LessThan } from 'typeorm';
import { ApiKeyRepository } from './api-key.repository';

describe('ApiKeyRepository', () => {
    let repository: {
        delete: jest.Mock;
    };
    let apiKeyRepository: ApiKeyRepository;

    beforeEach(() => {
        repository = {
            delete: jest.fn(),
        };

        apiKeyRepository = new ApiKeyRepository(repository as any);
    });

    it('uses Date values when deleting expired timestamp-transformed keys', async () => {
        repository.delete.mockResolvedValue({ affected: 2 });

        const deletedCount = await apiKeyRepository.deleteExpiredKeys();

        expect(deletedCount).toBe(2);

        const where = repository.delete.mock.calls[0][0];
        const expiresAt = where.expiresAt;
        const lessThanOperator = expiresAt._value[1];

        expect(lessThanOperator).toEqual(LessThan(expect.any(Date)));
    });
});
