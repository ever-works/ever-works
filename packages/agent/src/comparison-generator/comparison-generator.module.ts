import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { ComparisonGenerationService } from './comparison-generation.service';

@Module({
	imports: [DatabaseModule, FacadesModule],
	providers: [ComparisonGenerationService],
	exports: [ComparisonGenerationService],
})
export class ComparisonGeneratorModule {}
