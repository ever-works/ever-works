import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';
import { CLIModule } from './cli.module';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config';

async function bootstrap() {
    // Load config into environment variables
    const ac = await NestFactory.createApplicationContext(ConfigModule, {
        logger: ['error', 'warn'],
    });
    const configService = ac.get(ConfigService);
    await configService.loadConfigIntoEnv();
    await ac.close();

    // Run the CLI app with explicit logging
    await CommandFactory.run(CLIModule, {
        logger: ['error', 'warn'],
    });
}

bootstrap().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
