import { Module } from '@nestjs/common';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { GitModule } from '../git/git.module';

@Module({
  imports: [DataGeneratorModule, GitModule],
  providers: [MarkdownGeneratorService],
  exports: [MarkdownGeneratorService],
})
export class MarkdownGeneratorModule {}
