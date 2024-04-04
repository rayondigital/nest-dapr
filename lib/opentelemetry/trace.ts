import { Attributes, context, SpanKind, trace } from '@opentelemetry/api';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { DAPR_TRACE_ID_KEY, DaprContextService } from '../dapr-context-service';
export async function withTracedContext<T>(
  contextService: ClsService | DaprContextService | undefined,
  operationName: string,
  operation: () => Promise<T>,
  spanKind: SpanKind = SpanKind.INTERNAL,
  spanAttributes: Attributes = undefined,
  tracerName = 'nest-dapr',
): Promise<T> {
  const tracer = trace.getTracer(tracerName);

  const activeContext = context.active();
  if (!activeContext) {
    return await operation();
  }

  const currentSpan = trace.getSpan(context.active());
  // Determine if a new span needs to be started or use the existing one.
  const span =
    currentSpan ?? tracer.startSpan(operationName, { attributes: spanAttributes, kind: spanKind ?? SpanKind.SERVER });
  const isNewSpan = !currentSpan; // True if a new span was created, false if using the existing span.

  // Obtain the context service manually if not provided
  if (contextService === undefined) {
    contextService = ClsServiceManager.getClsService();
  }

  const spanContext = span.spanContext();
  // Version is set to '00' for the current version of the Trace Context spec.
  // Trace ID from the current span context
  // Span ID from the current span context
  // Trace flags to indicate if the trace is sampled
  const traceId = `00-${spanContext.traceId}-${spanContext.spanId}-0${spanContext.traceFlags.toString(16)}`;

  // Force the trace ID to be set in the context service
  if (contextService instanceof ClsService) {
    contextService.set(DAPR_TRACE_ID_KEY, traceId);
  } else {
    contextService.setTraceId(traceId);
  }

  return context.with(trace.setSpan(activeContext, span), async () => {
    try {
      const result = await operation();
      if (isNewSpan) {
        span.end(); // End the span only if it was created in this function.
      }
      return result;
    } catch (error) {
      span.recordException(error);
      if (isNewSpan) {
        span.end(); // Ensure span ends if it was created in this function.
      }
      throw error; // Rethrow the error after recording it in the span.
    }
  });
}
