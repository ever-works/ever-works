import { Injectable } from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';

/**
 * EW-652 (Tenants & Organizations Phase 0) — shared allocator for
 * URL-safe, collision-free `username` / `slug` values.
 *
 * Two callers today:
 *
 * 1. **Programmatic flows** (OAuth callbacks, GitHub App install, social
 *    auth, anonymous claim). The existing inline loop at
 *    `github-app-onboarding.service.ts:223-229` is migrated to call
 *    `allocateUsername()`; user never sees a "username taken" error and
 *    gets `ever`, `ever-2`, `ever-3` automatically.
 *
 * 2. **Interactive UI flow** (signup forms, settings rename). The
 *    `GET /api/users/check-username` endpoint calls `suggest()` to return
 *    `{ available, suggestion? }`.
 *
 * The `normalize` step matches the spec ([spec.md §3.3](../../../../docs/specs/features/tenants-and-organizations/spec.md#33-url-safety)):
 *   1. Lowercase.
 *   2. Replace any non-`[a-z0-9-]` with `-`.
 *   3. Collapse runs of `-` to a single `-`.
 *   4. Strip leading/trailing `-`.
 *   5. Fallback to `u-` + 8 hex chars if empty after normalization.
 *
 * Once `organizations.slug` lands in EW-653 (Phase 1), this service will
 * also check cross-table collisions via a new `OrganizationRepository`
 * dependency; for now it only checks `users.username` / `users.slug`.
 */
@Injectable()
export class UsernameAllocatorService {
	constructor(private readonly userRepository: UserRepository) {}

	/**
	 * Normalize an arbitrary string into a URL-safe form (lowercase ASCII +
	 * hyphens, never starts or ends with a hyphen).
	 *
	 * Examples:
	 *   "Alice O'Brien"     → "alice-o-brien"
	 *   "GITHUB.USER@x.io"  → "github-user-x-io"
	 *   "--"                → "u-<8-hex>" (fallback)
	 *   ""                  → "u-<8-hex>" (fallback)
	 */
	normalize(input: string): string {
		const fallback = (): string => `u-${this.randomHex(8)}`;

		if (!input || typeof input !== 'string') {
			return fallback();
		}

		const normalized = input
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '');

		return normalized.length > 0 ? normalized : fallback();
	}

	/**
	 * Allocate a unique username given a desired base. Used by programmatic
	 * registration paths (OAuth, GitHub App, etc.) where collisions must be
	 * resolved silently with a numeric suffix.
	 *
	 * Loop bound: caller-supplied `base` is normalized first, then suffixes
	 * `-2, -3, …` are tried until one is free. The DB UNIQUE constraint
	 * (case-insensitive on `lower(username)`) is the source of truth; this
	 * method does a lookup-then-insert race-prone check, but the constraint
	 * will reject any racing duplicate at commit time, so the caller can
	 * safely retry by re-invoking this method.
	 */
	async allocateUsername(base: string): Promise<string> {
		const normalized = this.normalize(base || 'user');
		let candidate = normalized;
		let suffix = 1;

		// Check BOTH `users.username` (case-insensitive) AND `users.slug` for
		// collisions — the slug column is auto-derived from username at
		// insert time via the User entity's `@BeforeInsert` hook, so a free
		// username with a colliding slug would still fail the INSERT. The
		// loop has to skip past either kind of collision to guarantee the
		// row will actually land.
		while (await this.collides(candidate)) {
			suffix += 1;
			candidate = `${normalized}-${suffix}`;
			if (suffix > 10_000) {
				// Safety valve. If we somehow can't find a free slot in
				// 10k attempts, fall back to a random one.
				candidate = `${normalized}-${this.randomHex(6)}`;
				break;
			}
		}

		return candidate;
	}

	/**
	 * Suggest a username/slug for an interactive UI flow.
	 *
	 * - If `desired` is available (normalized form does not collide with
	 *   any existing `users.username` case-insensitive OR `users.slug`),
	 *   returns `{ available: true, normalized }`.
	 *
	 * - If it collides, returns `{ available: false, normalized, suggestion }`
	 *   where `suggestion` is the next-free `-N` variant.
	 */
	async suggest(desired: string): Promise<{
		available: boolean;
		normalized: string;
		suggestion?: string;
	}> {
		const normalized = this.normalize(desired);

		const collides = await this.collides(normalized);
		if (!collides) {
			return { available: true, normalized };
		}

		const suggestion = await this.allocateUsername(normalized);
		return { available: false, normalized, suggestion };
	}

	private async collides(candidate: string): Promise<boolean> {
		const byUsername = await this.userRepository.findByUsernameCaseInsensitive(candidate);
		if (byUsername) {
			return true;
		}
		const bySlug = await this.userRepository.findBySlug(candidate);
		return bySlug !== null;
	}

	private randomHex(length: number): string {
		const bytes = Math.ceil(length / 2);
		// crypto is Node's built-in; not imported at top to keep this file
		// portable to environments that polyfill it differently.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { randomBytes } = require('node:crypto');
		return randomBytes(bytes).toString('hex').slice(0, length);
	}
}
