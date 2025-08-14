import { CommandFactory } from 'nest-commander';
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
    console.error('Unhandled error:', error);
    process.exit(1);
});
