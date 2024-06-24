import { ConsoleSpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export function registerTracerProvider(otelEndpoint?: string) {
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'nest-dapr',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: 'test',
      [SemanticResourceAttributes.HOST_NAME]: 'nest-dapr-0',
      [SemanticResourceAttributes.K8S_POD_NAME]: 'nest-dapr-0',
    }),
  });

  const consoleExporter = new ConsoleSpanExporter();
  provider.addSpanProcessor(new SimpleSpanProcessor(consoleExporter));

  // Configure the external exporter
  const exporter = new OTLPTraceExporter({
    // Specify the URL of your OpenTelemetry collector or backend
    url: otelEndpoint ?? process.env.OTEL_ENDPOINT ?? 'http://localhost:4317',
  });
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

  // Automatically register all instrumentations
  registerInstrumentations({
    instrumentations: [
      getNodeAutoInstrumentations(), // This will auto-instrument supported libraries
    ],
    tracerProvider: provider,
  });

  // Important: Initialize the provider
  provider.register();
}
