export interface TimeWindow {
    start: string;
    end: string;
    granularity: '1m' | '5m' | '1h' | '1d';
}

export interface MetricPoint {
    timestamp: string;
    value: number;
}

export interface MetricSeries {
    metric: string;
    tags: Record<string, string>;
    unit: string;
    points: MetricPoint[];
}

export interface TraceSpan {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    operationName: string;
    service: string;
    resource: string;
    startTime: string;
    durationMs: number;
    status: 'ok' | 'error';
    tags: Record<string, string>;
}

export interface ErrorEvent {
    id: string;
    message: string;
    stack: string | null;
    service: string;
    environment: string;
    timestamp: string;
    tags: Record<string, string>;
}

export interface ServiceNode {
    name: string;
    type: 'api' | 'db' | 'cache' | 'queue' | 'external';
    metrics: {
        requestRate: number;
        errorRate: number;
        p50Latency: number;
        p95Latency: number;
        p99Latency: number;
    };
    dependencies: string[];
}

export interface TelemetrySnapshot {
    services: ServiceNode[];
    metrics: MetricSeries[];
    traces: TraceSpan[];
    errors: ErrorEvent[];
    window: TimeWindow;
    generatedAt: string;
}

export interface Anomaly {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    service: string;
    title: string;
    description: string;
    metric: string;
    observedValue: number;
    threshold: number;
    detectedAt: string;
}

export interface TelemetrySourceConfig {
    baseUrl: string;
    projectName: string;
}

export const FINANCIAL_SERVICES: ServiceNode[] = [
    { name: 'payments-api', type: 'api', metrics: { requestRate: 1420, errorRate: 0.003, p50Latency: 45, p95Latency: 180, p99Latency: 420 }, dependencies: ['ledger-service', 'auth-service', 'db-primary'] },
    { name: 'ledger-service', type: 'api', metrics: { requestRate: 3100, errorRate: 0.001, p50Latency: 12, p95Latency: 48, p99Latency: 120 }, dependencies: ['db-primary'] },
    { name: 'auth-service', type: 'api', metrics: { requestRate: 5200, errorRate: 0.002, p50Latency: 8, p95Latency: 35, p99Latency: 90 }, dependencies: ['redis-cache', 'db-primary'] },
    { name: 'card-processor', type: 'api', metrics: { requestRate: 890, errorRate: 0.008, p50Latency: 320, p95Latency: 1200, p99Latency: 2800 }, dependencies: ['auth-service', 'ach-gateway', 'db-primary'] },
    { name: 'billing-engine', type: 'api', metrics: { requestRate: 430, errorRate: 0.004, p50Latency: 210, p95Latency: 850, p99Latency: 1800 }, dependencies: ['ledger-service', 'db-primary'] },
    { name: 'ach-gateway', type: 'external', metrics: { requestRate: 220, errorRate: 0.015, p50Latency: 580, p95Latency: 2400, p99Latency: 5000 }, dependencies: [] },
    { name: 'db-primary', type: 'db', metrics: { requestRate: 18500, errorRate: 0.0005, p50Latency: 3, p95Latency: 15, p99Latency: 60 }, dependencies: [] },
    { name: 'redis-cache', type: 'cache', metrics: { requestRate: 28000, errorRate: 0.0001, p50Latency: 1, p95Latency: 4, p99Latency: 12 }, dependencies: [] },
];

export function generateDefaultTimeWindow(): TimeWindow {
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString(), granularity: '5m' };
}

export function generateMockSnapshot(window?: TimeWindow): TelemetrySnapshot {
    const w = window ?? generateDefaultTimeWindow();
    const services = FINANCIAL_SERVICES.map((svc) => {
        const jitter = () => 0.85 + Math.random() * 0.3;
        const errorJitter = () => Math.random() * 2;
        return {
            ...svc,
            metrics: {
                requestRate: Math.round(svc.metrics.requestRate * jitter()),
                errorRate: +(svc.metrics.errorRate * errorJitter()).toFixed(4),
                p50Latency: Math.round(svc.metrics.p50Latency * jitter()),
                p95Latency: Math.round(svc.metrics.p95Latency * jitter()),
                p99Latency: Math.round(svc.metrics.p99Latency * jitter()),
            },
        };
    });

    const series: MetricSeries[] = services.map((svc) => ({
        metric: 'request.duration',
        tags: { service: svc.name, env: 'production' },
        unit: 'ms',
        points: Array.from({ length: 12 }, (_, i) => ({
            timestamp: new Date(Date.parse(w.start) + i * 300_000).toISOString(),
            value: svc.metrics.p50Latency * (0.7 + Math.random() * 0.6),
        })),
    }));

    const traces: TraceSpan[] = Array.from({ length: 10 }, (_, i) => {
        const svc = services[Math.floor(Math.random() * services.length)];
        return {
            traceId: `trace-${i}-${Date.now()}`,
            spanId: `span-${i}`,
            parentSpanId: i === 0 ? null : `span-${i - 1}`,
            operationName: i === 0 ? 'process.payment' : ['validate.auth', 'check.balance', 'deduct.funds', 'log.transaction'][i % 4],
            service: i === 0 ? 'payments-api' : svc.name,
            resource: '/api/payments/transfer',
            startTime: new Date(Date.now() - i * 5000).toISOString(),
            durationMs: Math.round(10 + Math.random() * 490),
            status: Math.random() > 0.9 ? 'error' : 'ok',
            tags: { http_method: 'POST', http_status: Math.random() > 0.9 ? '500' : '200' },
        };
    });

    const errors: ErrorEvent[] = [
        { id: 'err-1', message: 'ACH gateway timeout after 5000ms', stack: null, service: 'ach-gateway', environment: 'production', timestamp: new Date(Date.now() - 120_000).toISOString(), tags: { error_type: 'timeout' } },
        { id: 'err-2', message: 'Insufficient funds for transfer #TX-44902', stack: null, service: 'ledger-service', environment: 'production', timestamp: new Date(Date.now() - 300_000).toISOString(), tags: { error_type: 'business_rule' } },
        { id: 'err-3', message: 'Card authorization declined: expired card', stack: null, service: 'card-processor', environment: 'production', timestamp: new Date(Date.now() - 600_000).toISOString(), tags: { error_type: 'authorization_declined' } },
        { id: 'err-4', message: 'Database connection pool exhausted', stack: null, service: 'db-primary', environment: 'production', timestamp: new Date(Date.now() - 900_000).toISOString(), tags: { error_type: 'connection_pool' } },
    ];

    return { services, metrics: series, traces, errors, window: w, generatedAt: new Date().toISOString() };
}
