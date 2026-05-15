import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { DeployReadyPollerService } from '@ever-works/agent/services';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * EW-617 G8 — polls works currently mid-deploy, flips them to READY once
 * their slug-based health endpoint responds 200, and emits the
 * `deploy_ready` funnel event for any work that carries a persisted
 * `lastDeployCorrelationId`.
 *
 * Runs every two minutes. The poller itself is idempotent — works
 * already in READY are skipped on subsequent ticks because the SELECT
 * filters on the pending-states only.
 */
export const deployReadyPollerTask = schedules.task({
    id: 'deploy-ready-poller',
    cron: '*/2 * * * *',
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);

        appContext.useLogger(createTriggerLogger('DeployReadyPoller'));

        try {
            const poller = appContext.get(DeployReadyPollerService);
            const summary = await poller.pollOnce();
            return summary;
        } finally {
            await appContext.close();
        }
    },
});
