import { Module } from '@nestjs/common';
import { ItemsGeneratorService } from './items-generator.service';

@Module({
  providers: [ItemsGeneratorService],
  exports: [ItemsGeneratorService],
})
export class ItemsGeneratorModule {}
