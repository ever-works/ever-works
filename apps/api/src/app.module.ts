import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { DataGeneratorModule } from './data-generator/data-generator.module';
import { GitModule } from './git/git.module';
import { MarkdownGeneratorModule } from './markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from './website-generator/website-generator.module';
import { DeployModule } from './deploy/deploy.module';

@Module({
  imports: [
    DataGeneratorModule,
    GitModule,
    MarkdownGeneratorModule,
    WebsiteGeneratorModule,
    DeployModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
