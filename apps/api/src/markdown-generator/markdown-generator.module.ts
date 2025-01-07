import { Module } from '@nestjs/common';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [DataGeneratorModule, GithubModule],
  providers: [MarkdownGeneratorService],
  exports: [MarkdownGeneratorService],
})
export class MarkdownGeneratorModule {}
