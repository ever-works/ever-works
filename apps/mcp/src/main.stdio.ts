import 'reflect-metadata';

process.env.MCP_TRANSPORT = 'stdio';

async function bootstrap() {
	const { NestFactory } = await import('@nestjs/core');
	const { AppModule } = await import('./app.module.js');

	await NestFactory.createApplicationContext(AppModule, { logger: false });
}

bootstrap().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
