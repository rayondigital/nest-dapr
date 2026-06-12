import { createServer, Server } from 'http';

/**
 * A Zipkin v2 span as emitted by the Dapr sidecar's zipkin exporter.
 * Only the fields the tests use are typed.
 */
export interface ZipkinSpan {
  traceId: string;
  id: string;
  parentId?: string;
  name: string;
  duration?: number;
  localEndpoint?: { serviceName?: string };
  tags?: Record<string, string>;
}

/**
 * Minimal in-process collector that accepts Zipkin v2 JSON spans on
 * POST /api/v2/spans. Point a Dapr tracing Configuration at it
 * (zipkin.endpointAddress: http://localhost:<port>/api/v2/spans) to capture the
 * spans a chain of actor/service calls produces — no external backend
 * (Zipkin/SigNoz/OTLP collector) required, so the e2e is fully self-contained.
 */
export class ZipkinTraceCollector {
  private server?: Server;
  readonly spans: ZipkinSpan[] = [];

  constructor(readonly port = 9499) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/api/v2/spans')) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '[]');
            if (Array.isArray(parsed)) this.spans.push(...parsed);
          } catch {
            // Ignore malformed batches — the test will simply not see those spans.
          }
          res.statusCode = 202;
          res.end();
        });
      });
      this.server.on('error', reject);
      this.server.listen(this.port, resolve);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  /** All collected spans belonging to the given 32-hex trace id. */
  spansForTrace(traceId: string): ZipkinSpan[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  /** Finds a span whose name contains the given fragment (case-insensitive). */
  findSpanByName(traceId: string, nameFragment: string): ZipkinSpan | undefined {
    const needle = nameFragment.toLowerCase();
    return this.spansForTrace(traceId).find((s) => s.name?.toLowerCase().includes(needle));
  }

  /**
   * Polls until at least `count` spans for the trace have arrived (export is
   * asynchronous and batched), or the timeout elapses. Returns the spans seen.
   */
  async waitForSpans(traceId: string, count: number, timeoutMs = 15000): Promise<ZipkinSpan[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const spans = this.spansForTrace(traceId);
      if (spans.length >= count) return spans;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.spansForTrace(traceId);
  }

  /**
   * Renders the trace as an indented tree (root spans first, children nested),
   * so the whole waterfall is visible in the test output without any UI.
   */
  renderTree(traceId: string): string {
    const spans = this.spansForTrace(traceId);
    const ids = new Set(spans.map((s) => s.id));
    const childrenOf = (parentId?: string) =>
      spans.filter((s) => s.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    const walk = (span: ZipkinSpan, depth: number) => {
      const dur = span.duration !== undefined ? ` ${(span.duration / 1000).toFixed(1)}ms` : '';
      lines.push(`${'  '.repeat(depth)}- ${span.name} (id=${span.id}${dur})`);
      for (const child of childrenOf(span.id)) walk(child, depth + 1);
    };

    // Roots = spans whose parent is outside this collected set (e.g. the client span).
    const roots = spans.filter((s) => !s.parentId || !ids.has(s.parentId));
    for (const root of roots) walk(root, 0);
    return lines.join('\n');
  }
}
