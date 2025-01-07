import { Controller, Get } from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';

@Controller()
export class AppController {
  constructor(private readonly dataGenerator: DataGeneratorService) {}

  @Get()
  async generateData() {
    await this.dataGenerator.generate('awesome-timers');
    return { success: true };
  }
}
