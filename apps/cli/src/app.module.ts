import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseConfigurations } from '@packages/agent';

@Module({
    imports: [DatabaseConfigurations.cli()],
    providers: [AppService],
    controllers: [],
})
export class AppModule {}
