import { Module } from '@nestjs/common';
import { DatabaseModule, UserRepository } from '@ever-works/agent/database';
import { UsersController } from './controllers/users.controller';
import { UsernameAllocatorService } from './services/username-allocator.service';

/**
 * EW-652 (Tenants & Organizations Phase 0) — Users module.
 *
 * Provides:
 * - `UsernameAllocatorService` for both programmatic (e.g.
 *   `GitHubAppOnboardingService` — see [github-app-onboarding.service.ts]
 *   suffix loop refactor) and interactive (UI signup form) flows.
 * - `UsersController` with the public `GET /api/users/check-username`.
 *
 * The module exports `UsernameAllocatorService` so other modules
 * (auth, onboarding, integrations) can inject it without duplicating
 * provider declarations.
 */
@Module({
	imports: [DatabaseModule],
	providers: [UserRepository, UsernameAllocatorService],
	controllers: [UsersController],
	exports: [UsernameAllocatorService],
})
export class UsersModule {}
