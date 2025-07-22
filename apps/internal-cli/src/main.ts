import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';
import { CLIModule } from './cli.module';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config';

async function bootstrap() {
    // Determine if we should show debug logs (only in development or when explicitly requested)
    const isDevelopment = process.env.NODE_ENV === 'development';
    const isVerbose = process.env.CLI_VERBOSE === 'true' || process.argv.includes('--verbose');
    const shouldLog = isDevelopment || isVerbose;

    // Load config into environment variables
    const ac = await NestFactory.createApplicationContext(ConfigModule, {
        logger: ['error'],
    });
    const configService = ac.get(ConfigService);
    await configService.loadConfigIntoEnv();
    await ac.close();

    // Run the CLI app with minimal logging for production CLI
    await CommandFactory.run(CLIModule, {
        logger: ['error'],
    });
}

bootstrap().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
