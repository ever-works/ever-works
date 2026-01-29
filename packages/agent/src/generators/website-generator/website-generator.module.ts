import { Module } from '@nestjs/common';
import { WebsiteGeneratorService } from './website-generator.service';
import { WebsiteUpdateService } from './website-update.service';
import { GitModule } from '../../git/git.module';

@Module({
    imports: [GitModule],
    providers: [WebsiteGeneratorService, WebsiteUpdateService],
    exports: [WebsiteGeneratorService, WebsiteUpdateService],
})
export class WebsiteGeneratorModule {}
