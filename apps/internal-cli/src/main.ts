import { CommandFactory } from 'nest-commander';
import { Logger } from '@nestjs/common';
import { CLIModule } from './cli.module';
import { ConfigService } from './config';

async function bootstrap() {
    // Load config into environment variables
    const configService = new ConfigService();
    await configService.loadConfigIntoEnv();

    // Run the CLI app with minimal logging for production CLI
    await CommandFactory.run(CLIModule, {
        logger: ['error'],
    });
}

bootstrap().catch((error) => {
    // Security: log only error.message to avoid exposing internal stack traces and
    // file paths in shared/aggregated log environments; full stack is intentionally omitted.
    const logger = new Logger('bootstrap');
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
