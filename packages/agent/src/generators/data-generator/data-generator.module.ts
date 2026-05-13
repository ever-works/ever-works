import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { FacadesModule } from '../../facades/facades.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { DatabaseModule } from '@src/database';
import { WorkOperationsModule } from '@src/work-operations';
import { WorksConfigService } from '@src/works-config/services/works-config.service';
import { WorksConfigWriterService } from '@src/works-config/services/works-config-writer.service';
import { CategoryIconModule } from '../../services/category-icon/category-icon.module';

@Module({
    imports: [
        FacadesModule,
        PipelineModule,
        DatabaseModule,
        WorkOperationsModule,
        CategoryIconModule,
    ],
    providers: [DataGeneratorService, WorksConfigService, WorksConfigWriterService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
