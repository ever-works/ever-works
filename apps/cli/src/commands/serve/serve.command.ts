import { Command, CommandRunner, Option } from 'nest-commander';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import chalk from 'chalk';
import ora from 'ora';
import { AgentHTTPModule } from '@packages/agent';

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

    async run(passedParams: string[], options?: ServeOptions): Promise<void> {
        try {
            console.log(chalk.cyan.bold('\n🚀 Starting API Server\n'));

            const port = parseInt(options?.port || '3001', 10);
            const host = options?.host || 'localhost';

            console.log(chalk.cyan('--- Server Configuration ---'));
            console.log(chalk.gray('Host:'), chalk.white(host));
            console.log(chalk.gray('Port:'), chalk.white(port));
            console.log(
                chalk.gray('Environment:'),
                chalk.white(process.env.NODE_ENV || 'development'),
            );

            try {
                // Create NestJS application
                const app = await NestFactory.create(AgentHTTPModule, {
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

                // Enable CORS for development
                app.enableCors({
                    origin: true,
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
