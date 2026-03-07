import { Module } from '@nestjs/common';
import { OpenApiLoaderService } from './openapi-loader.service.js';
import { SchemaConverterService } from './schema-converter.service.js';

@Module({
	providers: [OpenApiLoaderService, SchemaConverterService],
	exports: [OpenApiLoaderService, SchemaConverterService]
})
export class OpenApiToolsModule {}
