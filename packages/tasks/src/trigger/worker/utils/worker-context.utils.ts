import { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TriggerWorkerModule } from '../modules/trigger-worker.module';
import { createTriggerLogger } from '../trigger-logger';

/**
 * Bootstrap a NestJS application context, run the provided function, and
 * ensure the context is always closed — even if the function throws.
 */
export async function withWorkerContext<T>(
    loggerName: string,
    fn: (appContext: INestApplicationContext) => Promise<T>,
    module: Type<any> = TriggerWorkerModule,
): Promise<T> {
    const appContext = await NestFactory.createApplicationContext(module, {
        logger: createTriggerLogger(loggerName),
    });

    try {
        return await fn(appContext);
    } finally {
        await appContext.close();
    }
}
