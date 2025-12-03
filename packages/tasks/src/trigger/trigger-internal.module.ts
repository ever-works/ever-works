import { Module } from '@nestjs/common';
import { TriggerInternalApiClient } from './trigger-internal-api.client';

@Module({
	providers: [TriggerInternalApiClient],
	exports: [TriggerInternalApiClient]
})
export class TriggerInternalModule {}
