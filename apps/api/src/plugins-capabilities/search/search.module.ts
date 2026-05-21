import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '../../auth/auth.module';
import { WorkModule } from '@ever-works/agent/services';

@Module({
    imports: [FacadesModule, AuthModule, WorkModule],
    controllers: [SearchController],
})
export class SearchModule {}
