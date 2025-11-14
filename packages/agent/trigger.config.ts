import { defineConfig } from '@trigger.dev/sdk';
import { emitDecoratorMetadata } from '@trigger.dev/build/extensions/typescript';

export default defineConfig({
    project: 'proj_uevrbfmpvojzzazvhffy',
    runtime: 'node',
    logLevel: 'log',
    // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
    // You can override this on an individual task.
    // See https://trigger.dev/docs/runs/max-duration
    maxDuration: 3600 * 3, // 3 hours
    retries: {
        enabledInDev: true,
        default: {
            maxAttempts: 3,
            minTimeoutInMs: 1000,
            maxTimeoutInMs: 10000,
            factor: 2,
            randomize: true,
        },
    },
    dirs: ['./src/tasks/trigger'],
    machine: 'medium-1x',
    build: {
        external: [
            // NestJS optional peer dependencies that we don't use
            '@nestjs/websockets',
            '@nestjs/websockets/socket-module',
            '@nestjs/microservices',
            '@grpc/grpc-js',
            '@grpc/proto-loader',
            'kafkajs',
            'mqtt',
            'nats',
            'amqplib',
            'amqp-connection-manager',
        ],
        extensions: [
            // Enable TypeScript decorator metadata for TypeORM
            emitDecoratorMetadata(),
        ],
    },
});
