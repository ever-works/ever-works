jest.mock('@ever-works/agent/database', () => ({}));

import { UsernameAllocatorService } from './username-allocator.service';

describe('UsernameAllocatorService', () => {
	const create = (existingUsernames: string[] = [], existingSlugs: string[] = []) => {
		const usernameSet = new Set(existingUsernames.map((u) => u.toLowerCase()));
		const slugSet = new Set(existingSlugs);

		const userRepository = {
			findByUsername: jest.fn(),
			findByUsernameCaseInsensitive: jest
				.fn()
				.mockImplementation(async (name: string) =>
					usernameSet.has(name.toLowerCase()) ? { id: 'taken', username: name } : null,
				),
			findBySlug: jest
				.fn()
				.mockImplementation(async (slug: string) =>
					slugSet.has(slug) ? { id: 'taken', slug } : null,
				),
		};

		const service = new UsernameAllocatorService(userRepository as any);
		return { service, userRepository };
	};

	describe('normalize', () => {
		it('lowercases', () => {
			const { service } = create();
			expect(service.normalize('Alice')).toBe('alice');
			expect(service.normalize('OCTOCAT')).toBe('octocat');
		});

		it('replaces non-[a-z0-9-] with hyphen', () => {
			const { service } = create();
			expect(service.normalize('alice.bob')).toBe('alice-bob');
			expect(service.normalize("alice o'brien")).toBe('alice-o-brien');
			expect(service.normalize('user@example.com')).toBe('user-example-com');
		});

		it('collapses runs of hyphens to one', () => {
			const { service } = create();
			expect(service.normalize('a---b')).toBe('a-b');
			expect(service.normalize('foo!!!bar')).toBe('foo-bar');
		});

		it('strips leading and trailing hyphens', () => {
			const { service } = create();
			expect(service.normalize('---alice---')).toBe('alice');
			expect(service.normalize('-bob')).toBe('bob');
			expect(service.normalize('charlie-')).toBe('charlie');
		});

		it('falls back to u-<hex> when input is empty or all non-allowed', () => {
			const { service } = create();
			expect(service.normalize('')).toMatch(/^u-[0-9a-f]{8}$/);
			expect(service.normalize('!!!')).toMatch(/^u-[0-9a-f]{8}$/);
			expect(service.normalize('---')).toMatch(/^u-[0-9a-f]{8}$/);
		});

		it('falls back to u-<hex> when input is null or non-string (defensive)', () => {
			const { service } = create();
			expect(service.normalize(null as unknown as string)).toMatch(/^u-[0-9a-f]{8}$/);
			expect(service.normalize(undefined as unknown as string)).toMatch(/^u-[0-9a-f]{8}$/);
			expect(service.normalize(42 as unknown as string)).toMatch(/^u-[0-9a-f]{8}$/);
		});

		it('preserves digits and hyphens', () => {
			const { service } = create();
			expect(service.normalize('user-123')).toBe('user-123');
			expect(service.normalize('2026-cohort')).toBe('2026-cohort');
		});
	});

	describe('allocateUsername', () => {
		it('returns normalized base when no collision', async () => {
			const { service } = create();
			await expect(service.allocateUsername('Alice')).resolves.toBe('alice');
			await expect(service.allocateUsername("O'Brien")).resolves.toBe('o-brien');
		});

		it('suffixes -2, -3, … on case-insensitive collisions', async () => {
			const { service } = create(['alice']);
			await expect(service.allocateUsername('alice')).resolves.toBe('alice-2');
			await expect(service.allocateUsername('ALICE')).resolves.toBe('alice-2');
		});

		it('finds the next free slot beyond -2', async () => {
			const { service } = create(['alice', 'alice-2', 'alice-3']);
			await expect(service.allocateUsername('alice')).resolves.toBe('alice-4');
		});

		it('falls back to "user" base when input is empty/falsy', async () => {
			const { service } = create();
			await expect(service.allocateUsername('')).resolves.toBe('user');
			await expect(service.allocateUsername(null as unknown as string)).resolves.toBe('user');
		});

		it('uses random suffix after 10k attempts (safety valve)', async () => {
			// Construct a userRepository that says everything from `bob` through
			// `bob-10000` is taken, then anything past that is free.
			const userRepository = {
				findByUsernameCaseInsensitive: jest
					.fn()
					.mockImplementation(async (name: string) => {
						const match = name.match(/^bob(?:-(\d+))?$/);
						if (!match) return { id: 'taken' };
						const n = match[1] ? Number(match[1]) : 1;
						return n <= 10000 ? { id: 'taken', username: name } : null;
					}),
				findBySlug: jest.fn().mockResolvedValue(null),
			};
			const service = new UsernameAllocatorService(userRepository as any);
			const result = await service.allocateUsername('bob');
			// After 10k attempts the safety valve kicks in and produces a
			// random 6-hex suffix.
			expect(result).toMatch(/^bob-[0-9a-f]{6}$/);
		}, 30_000);
	});

	describe('suggest', () => {
		it('returns available=true with no suggestion when free', async () => {
			const { service } = create();
			const result = await service.suggest('Alice');
			expect(result).toEqual({ available: true, normalized: 'alice' });
		});

		it('returns available=false with a suggestion when taken', async () => {
			const { service } = create(['alice']);
			const result = await service.suggest('alice');
			expect(result.available).toBe(false);
			expect(result.normalized).toBe('alice');
			expect(result.suggestion).toBe('alice-2');
		});

		it('reports the normalized form back to the caller', async () => {
			const { service } = create();
			const result = await service.suggest("Alice O'Brien!");
			expect(result.normalized).toBe('alice-o-brien');
			expect(result.available).toBe(true);
		});

		it('detects collision against users.slug too (not just username)', async () => {
			const { service } = create([], ['alice']); // username free, slug taken
			const result = await service.suggest('alice');
			expect(result.available).toBe(false);
			// The suffixed suggestion goes through the username check, so it
			// can land at 'alice-2' even though 'alice' was only in the slug
			// table — the cross-table collision was the trigger, not the
			// resolution path.
			expect(result.suggestion).toBeDefined();
			expect(result.suggestion).not.toBe('alice');
		});
	});
});
