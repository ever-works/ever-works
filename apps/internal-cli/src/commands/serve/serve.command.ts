import { Command, CommandRunner, Option } from 'nest-commander';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import chalk from 'chalk';
import { ConfigCheckService } from '../work/config-check.service';
import { WorksModule } from '../../works/works.module';

interface ServeOptions {
    port?: string;
    host?: string;
}

@Command({
    name: 'serve',
    description: 'Start the localhost API server',
})
export class ServeCommand extends CommandRunner {
    private readonly logger = new Logger(ServeCommand.name);

    constructor(private readonly configCheck: ConfigCheckService) {
        super();
    }

    async run(passedParams: string[], options?: ServeOptions): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n🚀 Starting API Server\n'));

            // Check configuration first
            await this.configCheck.requireConfiguration();

            const port = parseInt(options?.port || '3100', 10);
            const host = options?.host || 'localhost';

            // Security: this server mounts WorksController, which has NO
            // authentication (every handler runs as the local user). Binding to
            // a non-loopback interface exposes full work CRUD + AI generation to
            // anyone who can reach the port. We don't block it (operators may
            // have a trusted-network reason), but loudly warn so it isn't done
            // by accident. Loopback-only is the safe default.
            const loopbackHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
            if (!loopbackHosts.includes(host.toLowerCase())) {
                console.log(
                    chalk.red.bold(
                        '\n⚠ SECURITY WARNING: binding to a non-loopback host ' +
                            `(${host}).`,
                    ),
                );
                console.log(
                    chalk.yellow(
                        'This API has NO authentication — anyone who can reach ' +
                            'this port can create, generate, and delete works as you. ' +
                            'Only do this on a fully trusted network, behind a ' +
                            'firewall/reverse-proxy that adds authentication.',
                    ),
                );
            }

            console.log(chalk.cyan('--- Server Configuration ---'));
            console.log(chalk.gray('Host:'), chalk.white(host));
            console.log(chalk.gray('Port:'), chalk.white(port));
            console.log(
                chalk.gray('Environment:'),
                chalk.white(process.env.NODE_ENV || 'development'),
            );

            try {
                // Create NestJS application
                const app = await NestFactory.create(WorksModule, {
                    logger: ['error', 'warn', 'log'],
                });

                // Configure global pipes
                app.useGlobalPipes(
                    new ValidationPipe({
                        whitelist: true,
                        transform: true,
                        forbidNonWhitelisted: true,
                    }),
                );

                // Security: do NOT reflect arbitrary origins. `{ origin: true,
                // credentials: true }` echoes any site's Origin back with
                // Access-Control-Allow-Credentials, so any web page the operator
                // visits could make credentialed cross-origin calls to this
                // unauthenticated localhost API (drive-by CSRF / data exfil).
                // Restrict to an explicit localhost allow-list, matching the
                // callback shape used by apps/api/src/main.ts (a static array
                // still makes the `cors` package emit ACAC:true for evil
                // origins, so use a callback that only echoes allow-listed ones).
                const configuredOrigins =
                    process.env.ALLOWED_ORIGINS?.split(',')
                        .map((o) => o.trim())
                        .filter(Boolean) ?? [];
                const allowedOrigins =
                    configuredOrigins.length > 0
                        ? configuredOrigins
                        : ['http://localhost:3000', 'http://127.0.0.1:3000'];
                app.enableCors({
                    origin: (
                        origin: string | undefined,
                        callback: (err: Error | null, allow?: boolean) => void,
                    ) => {
                        // Same-origin / non-browser requests have no Origin header.
                        if (!origin || allowedOrigins.includes(origin)) {
                            callback(null, true);
                        } else {
                            callback(null, false);
                        }
                    },
                    credentials: true,
                });

                // Start listening
                await app.listen(port, host);

                console.log(chalk.yellow('\n--- Controls ---'));
                console.log(
                    chalk.gray('Press'),
                    chalk.white('Ctrl+C'),
                    chalk.gray('to stop the server'),
                );

                // Keep the process alive
                process.on('SIGINT', () => {
                    console.log(chalk.yellow('\n\n⚠ Shutting down server...'));
                    app.close().then(() => {
                        console.log(chalk.green('✓ Server stopped successfully'));
                        process.exit(0);
                    });
                });

                process.on('SIGTERM', () => {
                    console.log(chalk.yellow('\n\n⚠ Shutting down server...'));
                    app.close().then(() => {
                        console.log(chalk.green('✓ Server stopped successfully'));
                        process.exit(0);
                    });
                });
            } catch (error) {
                throw error;
            }
        } catch (error) {
            this.logger.error('Failed to start API server:', error);
            console.log(chalk.red('\n✗ Failed to start API server:'), error.message);

            if (error.code === 'EADDRINUSE') {
                console.log(chalk.yellow('\n💡 Tip: The port might already be in use.'));
                console.log(
                    chalk.gray('Try using a different port with:'),
                    chalk.cyan('--port <number>'),
                );
            }

            process.exit(1);
        }
    }

    @Option({
        flags: '-p, --port <number>',
        description: 'Port to run the server on',
    })
    parsePort(val: string): number {
        const port = parseInt(val, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            throw new Error('Port must be a number between 1 and 65535');
        }
        return port;
    }

    @Option({
        flags: '-h, --host <string>',
        description: 'Host to bind the server to',
    })
    parseHost(val: string): string {
        if (!val || val.trim().length === 0) {
            throw new Error('Host cannot be empty');
        }
        return val.trim();
    }
}
