import { Module } from '@nestjs/common';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { FacadesModule } from '../../facades/facades.module';
import { DatabaseModule } from '../../database';
import { WorkOperationsModule } from '@src/work-operations';

@Module({
    imports: [DataGeneratorModule, FacadesModule, DatabaseModule, WorkOperationsModule],
    providers: [MarkdownGeneratorService],
    exports: [MarkdownGeneratorService],
})
export class MarkdownGeneratorModule {}
