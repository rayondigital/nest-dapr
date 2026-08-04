import { Injectable } from '@nestjs/common';
import { DaprInvokerCallbackContent, HttpMethod } from '@dapr/dapr';
import { DaprHandler } from '../../lib';

@Injectable()
export class EchoService {
  @DaprHandler({ path: 'test-echo', method: HttpMethod.POST })
  async echo(data: DaprInvokerCallbackContent): Promise<any> {
    return {
      echoed: JSON.parse(data.body || '{}'),
      query: data.query,
    };
  }

  // No `method` supplied — should default to GET.
  @DaprHandler({ path: 'test-hello' })
  async hello(): Promise<any> {
    return { hello: 'world' };
  }

  @DaprHandler({ path: 'test-throw', method: HttpMethod.POST })
  async throwing(): Promise<void> {
    throw new Error('This is expected to fail.');
  }
}
