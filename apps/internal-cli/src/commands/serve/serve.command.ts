import { Command, CommandRunner, Option } from 'nest-commander';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import chalk from 'chalk';
import { ConfigCheckService } from '../work/config-check.service';
import { WorksModule } from '../../works/works.module';
import { CliTokenGuard } from '../../works/cli-token.guard';
import { isLoopbackHost, ServeTokenService } from '../../works/serve-token.service';

interface ServeOptions {
    port?: string;
    host?: string;
    allowRemote?: boolean;
}

const DEFAULT_HOST = '127.0.0.1';

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
            const requestedHost = options?.host;
            const allowRemote = options?.allowRemote === true;

            // Security: this server mounts WorksController, which runs every
            // handler as the local user. We now gate it with a per-start token
            // (see below), but loopback-by-default is still the right posture:
            // binding to a non-loopback interface widens the attack surface to
            // the LAN, so it must be an explicit opt-in.
            //
            // Default to 127.0.0.1 (unambiguous loopback). A non-loopback host
            // is only honoured when `--allow-remote` is passed; otherwise we
            // refuse rather than silently downgrade the operator's intent.
            const host = requestedHost || DEFAULT_HOST;
            if (requestedHost && !isLoopbackHost(requestedHost) && !allowRemote) {
                console.log(
                    chalk.red.bold(
                        `\n✗ Refusing to bind to non-loopback host (${requestedHost}) ` +
                            'without --allow-remote.',
                    ),
                );
                console.log(
                    chalk.yellow(
                        'Binding to a remote-reachable interface exposes the work ' +
                            'API beyond this machine. Re-run with --allow-remote if ' +
                            'you really intend this, and only on a trusted network ' +
                            'behind a firewall.',
                    ),
                );
                process.exit(1);
            }
            if (requestedHost && !isLoopbackHost(requestedHost) && allowRemote) {
                console.log(
                    chalk.red.bold(
                        `\n⚠ SECURITY WARNING: binding to a non-loopback host (${host}).`,
                    ),
                );
                console.log(
                    chalk.yellow(
                        'The work API is reachable from the network. Every request ' +
                            'still requires the per-start CLI token, but treat that ' +
                            'token as a network secret and run behind a firewall.',
                    ),
                );
            }

            // Security: generate a random per-start token and require it on
            // every request via a global guard. This means even loopback/local
            // callers (other processes on this machine, drive-by web pages
            // hitting the localhost port) must present a secret they can only
            // learn by reading the 0600 token file we write below.
            const cliToken = ServeTokenService.generateToken();
            const tokenPath = await ServeTokenService.writeToken(cliToken);

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

                // Security: require the per-start token on EVERY request. The
                // guard is constructed with the token generated above and
                // registered globally so it covers every WorksController route
                // (and any future ones) without per-handler opt-in.
                app.useGlobalGuards(new CliTokenGuard(cliToken));

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

                console.log(chalk.yellow('\n--- Authentication ---'));
                console.log(
                    chalk.gray('Every request requires this per-start token via'),
                    chalk.white('Authorization: Bearer <token>'),
                    chalk.gray('or'),
                    chalk.white('X-EW-CLI-Token: <token>'),
                );
                console.log(chalk.gray('Token file (0600):'), chalk.white(tokenPath));

                console.log(chalk.yellow('\n--- Controls ---'));
                console.log(
                    chalk.gray('Press'),
                    chalk.white('Ctrl+C'),
                    chalk.gray('to stop the server'),
                );

                const shutdown = () => {
                    console.log(chalk.yellow('\n\n⚠ Shutting down server...'));
                    app.close()
                        .then(() => ServeTokenService.removeToken())
                        .then(() => {
                            console.log(chalk.green('✓ Server stopped successfully'));
                            process.exit(0);
                        })
                        .catch(() => {
                            // Even if close/cleanup fails, exit so the operator
                            // isn't left with a hung process.
                            process.exit(0);
                        });
                };

                // Keep the process alive until interrupted.
                process.on('SIGINT', shutdown);
                process.on('SIGTERM', shutdown);
            } catch (startupError) {
                // The server never came up (e.g. EADDRINUSE). Remove the token
                // file we wrote so a stale, never-listened-on token isn't left
                // readable on disk. Best-effort; rethrow the original error.
                await ServeTokenService.removeToken();
                throw startupError;
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
        description: 'Host to bind the server to (defaults to 127.0.0.1)',
    })
    parseHost(val: string): string {
        if (!val || val.trim().length === 0) {
            throw new Error('Host cannot be empty');
        }
        return val.trim();
    }

    @Option({
        flags: '--allow-remote',
        description:
            'Permit binding to a non-loopback host (e.g. 0.0.0.0). Required ' +
            'to expose the API beyond this machine; otherwise loopback-only.',
    })
    parseAllowRemote(): boolean {
        return true;
    }
}
