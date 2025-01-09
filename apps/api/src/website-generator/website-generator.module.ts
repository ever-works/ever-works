import { Module } from '@nestjs/common';
import { WebsiteGeneratorService } from './website-generator.service';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [GithubModule],
  providers: [WebsiteGeneratorService],
  exports: [WebsiteGeneratorService],
})
export class WebsiteGeneratorModule {}
