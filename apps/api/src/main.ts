import { NestFactory } from '@nestjs/core';
import { AgentHTTPModule } from '@packages/agent';
import { configDotenv } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
    configDotenv();

    const app = await NestFactory.create(AgentHTTPModule);

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

    await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
