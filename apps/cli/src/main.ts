import { NestFactory, NestContainer } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config';

async function bootstrap() {
    // Load config into environment variables
    const config = await NestFactory.createApplicationContext(ConfigModule, { logger: false });
    const configService = config.get(ConfigService);
    await configService.loadConfigIntoEnv();
    await config.close(); // we can close the config app context now

    // Run the CLI app
    await CommandFactory.run(AppModule);
}

bootstrap();
