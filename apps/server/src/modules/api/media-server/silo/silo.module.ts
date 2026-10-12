import { Module } from '@nestjs/common';
import { SiloAdapterService } from './silo-adapter.service';

@Module({
  providers: [SiloAdapterService],
  exports: [SiloAdapterService],
})
export class SiloModule {}
