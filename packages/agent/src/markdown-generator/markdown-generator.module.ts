import { Module } from '@nestjs/common';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { GitModule } from '../git/git.module';
import { DatabaseModule } from '../database';
import { DirectoryOperationsModule } from '@src/directory-operations';

@Module({
    imports: [DataGeneratorModule, GitModule, DatabaseModule, DirectoryOperationsModule],
    providers: [MarkdownGeneratorService],
    exports: [MarkdownGeneratorService],
})
export class MarkdownGeneratorModule {}
