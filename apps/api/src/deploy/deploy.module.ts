import { Module } from '@nestjs/common';
import { DeployController } from './deploy.controller';
import { VercelService } from './vercel.service';
import { GitModule } from '../git/git.module';

@Module({
  imports: [GitModule],
  providers: [VercelService],
  controllers: [DeployController]
})
export class DeployModule {}
