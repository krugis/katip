// SPDX-License-Identifier: AGPL-3.0-only
// OpenTelemetry traces (LLD-03 §7). Without an endpoint these calls do nothing. Attributes are
// chosen one by one, and an error only gives its code: messages can quote what someone typed.
// A path of its own, so only a service that traces loads this.
import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';

export { trace, type Tracer };
/** For a service's tests, to look at what it traced. */
export { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor };

export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      const { code, name: errorName } = e as { code?: unknown; name?: string };
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: typeof code === 'string' ? code : (errorName ?? 'error'),
      });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Sends traces to an OTLP endpoint. The service's name comes from OTEL_SERVICE_NAME. */
export function startTracing(url: string): () => Promise<void> {
  const provider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url }))],
  });
  provider.register();
  return () => provider.shutdown();
}
