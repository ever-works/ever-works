import { defineConfig } from '@trigger.dev/sdk';
import { emitDecoratorMetadata } from '@trigger.dev/build/extensions/typescript';
import { additionalPackages, additionalFiles } from '@trigger.dev/build/extensions/core';
import { collectPluginDependencies } from './src/build/collect-plugin-deps';

const canRetry = process.env.TRIGGER_DEV_ENABLE_RETRIES === 'true';

export default defineConfig({
    // Project ref is read from the environment so the same task bundle can be
    // deployed to either the Trigger.dev CLOUD project or our self-hosted
    // instance (trigger.ever.co, org "Ever"). Falls back to the original cloud
    // project ref when TRIGGER_PROJECT_REF is unset (e.g. legacy cloud CI).
    project: process.env.TRIGGER_PROJECT_REF || 'proj_uevrbfmpvojzzazvhffy',
    runtime: 'node-22',
    logLevel: 'log',
    // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
    // You can override this on an individual task.
    // See https://trigger.dev/docs/runs/max-duration
    maxDuration: 3600 * 5, // 5 hours
    retries: canRetry
        ? {
              enabledInDev: true,
              default: {
                  maxAttempts: 3,
                  minTimeoutInMs: 1000,
                  maxTimeoutInMs: 10000,
                  factor: 2,
                  randomize: true,
              },
          }
        : undefined,
    dirs: ['./src/tasks/trigger'],
    machine: 'medium-1x',
    build: {
        external: [
            // NestJS optional peer dependencies that we don't use
            '@nestjs/websockets',
            '@nestjs/websockets/socket-module',
            '@nestjs/microservices',
            '@nestjs/microservices/microservices-module',
            '@grpc/grpc-js',
            '@grpc/proto-loader',
            'kafkajs',
            'mqtt',
            'nats',
            'amqplib',
            'amqp-connection-manager',
            'class-transformer',
        ],
        extensions: [
            // Enable TypeScript decorator metadata for TypeORM
            emitDecoratorMetadata(),
            // Copy built plugin artifacts into the deployment
            additionalFiles({
                files: ['./plugins/**'],
            }),
            // Install plugin dependencies without modifying package.json
            additionalPackages({
                packages: collectPluginDependencies(),
            }),
        ],
    },
});
