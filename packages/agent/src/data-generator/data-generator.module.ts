import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { GitModule } from '../git/git.module';
import { ItemsGeneratorModule } from 'src/items-generator/items-generator.module';
import { DatabaseModule } from '@src/database';
import { DirectoryOperationsModule } from '@src/directory-operations';

@Module({
    imports: [GitModule, ItemsGeneratorModule, DatabaseModule, DirectoryOperationsModule],
    providers: [DataGeneratorService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
