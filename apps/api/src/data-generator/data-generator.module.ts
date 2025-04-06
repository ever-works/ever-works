import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { GitModule } from '../git/git.module';

@Module({
    imports: [GitModule],
    providers: [DataGeneratorService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
