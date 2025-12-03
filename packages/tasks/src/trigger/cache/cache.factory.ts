import { CacheModule } from '@nestjs/cache-manager';
import { TriggerInternalApiClient } from '../trigger-internal-api.client';
import { TriggerInternalModule } from '../trigger-internal.module';
import { InternalAPIAdapter } from './internal-api.adapter';

type CacheOptions = {
	ttl?: number;
	isGlobal?: boolean;
};

export const TriggerCacheFactory = {
	register(options?: CacheOptions) {
		return CacheModule.registerAsync({
			imports: [TriggerInternalModule],
			inject: [TriggerInternalApiClient],
			isGlobal: options?.isGlobal,
			useFactory: async (apiClient: TriggerInternalApiClient) => {
				// Create the adapter
				const internalApiAdapter = new InternalAPIAdapter({
					apiClient,
					ttl: options?.ttl
				});

				return { stores: [internalApiAdapter] };
			}
		});
	}
};
