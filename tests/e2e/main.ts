import { NestFactory } from '@nestjs/core';
import { TestModule } from './test.module';
import { setupTrace } from './trace.setup';

const sdk = setupTrace();

async function bootstrap() {
  const app = await NestFactory.create(TestModule);
  await app.listen(3000);
}
bootstrap();
