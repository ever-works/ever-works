import { defineConfig } from '@trigger.dev/sdk';
import { emitDecoratorMetadata } from '@trigger.dev/build/extensions/typescript';
import { esbuildPlugin } from '@trigger.dev/build/extensions';
import path from 'path';
import fs from 'fs';

// Custom esbuild plugin to resolve pnpm workspace package imports
function pnpmWorkspaceResolver() {
    return esbuildPlugin(
        {
            name: 'pnpm-workspace-resolver',
            setup(build) {
                // Resolve @packages/* imports to the actual workspace paths
                build.onResolve({ filter: /^@packages\// }, (args) => {
                    const packageMatch = args.path.match(/^@packages\/([^/]+)(\/.*)?$/);
                    if (!packageMatch) return null;

                    const packageName = packageMatch[1]; // e.g., 'agent'
                    const subpath = packageMatch[2] || ''; // e.g., '/entities'

                    // Path to the workspace package
                    const workspaceRoot = path.resolve(__dirname, '../..');
                    const packageDir = path.resolve(workspaceRoot, 'packages', packageName);

                    // Read the package.json to get the exports mapping
                    const packageJsonPath = path.join(packageDir, 'package.json');
                    if (!fs.existsSync(packageJsonPath)) {
                        return null;
                    }

                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

                    // If there's a subpath, look it up in exports
                    if (subpath && packageJson.exports) {
                        const exportKey = '.' + subpath;
                        const exportEntry = packageJson.exports[exportKey];

                        if (exportEntry) {
                            // Get the default/main entry point
                            const exportPath =
                                typeof exportEntry === 'string'
                                    ? exportEntry
                                    : exportEntry.default ||
                                      exportEntry.import ||
                                      exportEntry.require;

                            if (exportPath) {
                                const resolvedPath = path.resolve(packageDir, exportPath);
                                return { path: resolvedPath };
                            }
                        }
                    }

                    // Fallback to main entry point
                    const mainPath = packageJson.main || 'dist/index.js';
                    return { path: path.resolve(packageDir, mainPath) };
                });
            },
        },
        { target: 'deploy' },
    );
}

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
            // Resolve pnpm workspace packages for monorepo support
            pnpmWorkspaceResolver(),
        ],
    },
});
