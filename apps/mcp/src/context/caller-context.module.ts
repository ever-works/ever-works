import { Module, Global } from '@nestjs/common';
import { CallerContextService } from './caller-context.service.js';

/**
 * `@Global` so both `ApiKeyGuard` (which seeds the caller identity) and
 * `ApiClientService` (which reads it) resolve the SAME singleton without
 * every module having to import this one. Two instances would mean two
 * `AsyncLocalStorage`s and the identity would never arrive — the exact
 * class of silent seam failure this module exists to close.
 */
@Global()
@Module({
	providers: [CallerContextService],
	exports: [CallerContextService]
})
export class CallerContextModule {}
