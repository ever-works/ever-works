import { Module } from '@nestjs/common';
import { WebsiteGeneratorService } from './website-generator.service';
import { GitModule } from '../git/git.module';

@Module({
  imports: [GitModule],
  providers: [WebsiteGeneratorService],
  exports: [WebsiteGeneratorService],
})
export class WebsiteGeneratorModule {}
