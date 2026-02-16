import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { CommunityPrProcessorService } from './community-pr-processor.service';

@Module({
	imports: [DatabaseModule, FacadesModule],
	providers: [CommunityPrProcessorService],
	exports: [CommunityPrProcessorService],
})
export class CommunityPrModule {}
