import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerWorkerModule } from '../../trigger/trigger-worker.module';
import { DirectoryScheduleDispatcherService } from '@packages/agent/services';
import { config } from '@packages/agent/config';

const interval = Math.max(1, config.subscriptions.getDispatchIntervalMinutes());
const cronExpression = `*/${interval} * * * *`;

export const directoryScheduleDispatcherTask = schedules.task({
	id: 'directory-schedule-dispatcher',
	cron: cronExpression,
	run: async () => {
		const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
			logger: ['error', 'fatal', 'warn']
		});

		try {
			const dispatcher = appContext.get(DirectoryScheduleDispatcherService);
			const dispatched = await dispatcher.dispatchDue();

			return {
				dispatched,
				intervalMinutes: interval
			};
		} finally {
			await appContext.close();
		}
	}
});
