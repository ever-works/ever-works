import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DataGeneratorModule } from './data-generator/data-generator.module';
import { AiEngineModule } from './ai-engine/ai-engine.module';
import { GitModule } from './git/git.module';
import { MarkdownGeneratorModule } from './markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from './website-generator/website-generator.module';

@Module({
  imports: [DataGeneratorModule, AiEngineModule, GitModule, MarkdownGeneratorModule, WebsiteGeneratorModule],
  controllers: [AppController],
})
export class AppModule {}
