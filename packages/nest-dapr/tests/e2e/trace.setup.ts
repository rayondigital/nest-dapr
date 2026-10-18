import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export function setupTrace() {
  const otlpExporter = new OTLPTraceExporter({
    url: process.env.OTEL_ENDPOINT ?? 'http://localhost:4317',
  });
  const resources = getNodeAutoInstrumentations();
  const sdk = new NodeSDK({
    traceExporter: otlpExporter,
    spanProcessors: [new SimpleSpanProcessor(otlpExporter)],
    metricReader: new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
    }),
    instrumentations: [
      ...resources,
      new NestInstrumentation(),
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();
  return sdk;
}
