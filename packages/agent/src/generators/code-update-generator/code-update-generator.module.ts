import { Module } from '@nestjs/common';
import { FacadesModule } from '../../facades/facades.module';
import { DatabaseModule } from '../../database';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { CodeUpdateGeneratorService } from './code-update-generator.service';

@Module({
    imports: [FacadesModule, DatabaseModule, WebsiteGeneratorModule],
    providers: [CodeUpdateGeneratorService],
    exports: [CodeUpdateGeneratorService],
})
export class CodeUpdateGeneratorModule {}
