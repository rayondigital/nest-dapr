import { Attributes, context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { DAPR_TRACE_ID_KEY, DaprContextService } from '../dapr-context-service';

/**
 * Gets the current trace ID from OpenTelemetry's active span context.
 * Returns the trace ID formatted as W3C traceparent (00-traceId-spanId-traceFlags).
 * Returns undefined if there is no active span or if an error occurs.
 */
export function getTraceId(): string | undefined {
  try {
    if (!trace || !context) {
      return undefined;
    }

    const activeContext = context.active();

    // First try to get span context from an active span
    const activeSpan = trace.getSpan(activeContext);
    if (activeSpan) {
      const spanContext = activeSpan.spanContext();
      if (spanContext && spanContext.traceId && spanContext.spanId) {
        const traceFlags = spanContext.traceFlags.toString(16).padStart(2, '0');
        return `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
      }
    }

    // Fallback: try to get span context directly (works for extracted/remote contexts)
    const spanContext = trace.getSpanContext(activeContext);
    if (spanContext && spanContext.traceId && spanContext.spanId) {
      const traceFlags = spanContext.traceFlags.toString(16).padStart(2, '0');
      return `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export async function withTracedContext<T>(
  contextService: ClsService | DaprContextService | undefined,
  operationName: string,
  operation: () => Promise<T>,
  spanKind: SpanKind = SpanKind.INTERNAL,
  spanAttributes: Attributes = undefined,
  tracerName = 'nest-dapr',
): Promise<T> {
  // If there is no trace provider, execute the operation without tracing.
  if (!trace || !context) {
    return await operation();
  }

  const tracer = trace.getTracer(tracerName);
  const activeContext = context.active();
  // If there is no active context, execute the operation without tracing.
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

  return context.with(trace.setSpan(activeContext, span), async () => {
    // Get the trace ID now that the span is active in the context
    const traceId = getTraceId();

    // Force the trace ID to be set in the context service
    if (traceId) {
      if (contextService instanceof ClsService) {
        contextService.set(DAPR_TRACE_ID_KEY, traceId);
      } else {
        contextService.setTraceId(traceId);
      }
    }

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

/**
 * Extracts OpenTelemetry context from incoming HTTP headers and executes
 * the operation within that context. If OpenTelemetry is not available or
 * extraction fails, the operation is executed normally without tracing.
 *
 * @param headers - The incoming HTTP request headers (e.g., req.headers)
 * @param operation - The async operation to execute
 * @returns The result of the operation
 */
export async function withExtractedContext<T>(
  headers: Record<string, string | string[] | undefined>,
  operation: () => Promise<T>,
): Promise<T> {
  // If no request provided, just run the operation
  if (!headers) {
    return await operation();
  }

  // If OpenTelemetry is not available, just run the operation
  if (!propagation || !context) {
    return await operation();
  }

  // Extract trace context from headers (traceparent, tracestate)
  const extractedContext = propagation.extract(context.active(), headers);

  // Run the operation within the extracted context
  return await context.with(extractedContext, operation);
}
