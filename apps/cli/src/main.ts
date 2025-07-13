import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';
import { CLIModule } from './cli.module';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config';

async function bootstrap() {
    // Load config into environment variables
    const config = await NestFactory.createApplicationContext(ConfigModule, {
        logger: ['error', 'warn'],
    });
    const configService = config.get(ConfigService);
    await configService.loadConfigIntoEnv();

    // Run the CLI app with explicit logging
    await CommandFactory.run(CLIModule, {
        logger: ['error', 'warn'],
    });
}

bootstrap().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
