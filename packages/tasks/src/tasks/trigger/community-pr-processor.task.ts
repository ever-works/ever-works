import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerWorkerModule } from '../../trigger/worker/modules/trigger-worker.module';
import { CommunityPrProcessorService } from '@ever-works/agent/community-pr';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export const communityPrProcessorTask = schedules.task({
	id: 'community-pr-processor',
	cron: '0 */1 * * *',
	run: async () => {
		const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
			logger: createTriggerLogger('CommunityPrProcessor'),
		});

		try {
			const processor = appContext.get(CommunityPrProcessorService);
			const result = await processor.processAllDirectories();

			return {
				processed: result.processed,
				errors: result.errors.length,
			};
		} finally {
			await appContext.close();
		}
	},
});
