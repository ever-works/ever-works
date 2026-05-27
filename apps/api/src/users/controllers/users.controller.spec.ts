jest.mock('@ever-works/agent/database', () => ({}));

import { UsersController } from './users.controller';

describe('UsersController', () => {
	const create = () => {
		const usernameAllocator = {
			suggest: jest.fn(),
			allocateUsername: jest.fn(),
			normalize: jest.fn(),
		};
		const controller = new UsersController(usernameAllocator as any);
		return { controller, usernameAllocator };
	};

	describe('GET /api/users/check-username', () => {
		it('returns the allocator suggest() result on available', async () => {
			const { controller, usernameAllocator } = create();
			usernameAllocator.suggest.mockResolvedValue({
				available: true,
				normalized: 'alice',
			});

			const result = await controller.checkUsername({ value: 'Alice' });

			expect(result).toEqual({ available: true, normalized: 'alice' });
			expect(usernameAllocator.suggest).toHaveBeenCalledWith('Alice');
		});

		it('returns suggestion when not available', async () => {
			const { controller, usernameAllocator } = create();
			usernameAllocator.suggest.mockResolvedValue({
				available: false,
				normalized: 'alice',
				suggestion: 'alice-2',
			});

			const result = await controller.checkUsername({ value: 'Alice' });

			expect(result).toEqual({
				available: false,
				normalized: 'alice',
				suggestion: 'alice-2',
			});
		});

		it('passes the raw query value through to the allocator (allocator owns normalization)', async () => {
			const { controller, usernameAllocator } = create();
			usernameAllocator.suggest.mockResolvedValue({
				available: true,
				normalized: 'oct-o-cat',
			});

			await controller.checkUsername({ value: 'Oct.o Cat!' });

			expect(usernameAllocator.suggest).toHaveBeenCalledWith('Oct.o Cat!');
		});
	});
});
