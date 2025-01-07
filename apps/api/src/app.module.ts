import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DataGeneratorModule } from './data-generator/data-generator.module';
import { AiEngineModule } from './ai-engine/ai-engine.module';
import { GithubModule } from './github/github.module';
import { MarkdownGeneratorModule } from './markdown-generator/markdown-generator.module';

@Module({
  imports: [DataGeneratorModule, AiEngineModule, GithubModule, MarkdownGeneratorModule],
  controllers: [AppController],
})
export class AppModule {}
