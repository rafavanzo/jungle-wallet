import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { HttpExceptionFilter } from './http/http-exception.filter.js';
import { createValidationPipe } from './http/validation.js';
import { WageringModule } from './http/wagering.module.js';

@Module({
  imports: [WageringModule],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
