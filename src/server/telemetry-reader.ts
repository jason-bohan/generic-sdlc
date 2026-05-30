import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';
import { getActiveProject } from './project-config';
import type { TelemetrySnapshot, Anomaly } from '../shared/telemetry';

const TELEMETRY_TIMEOUT_MS = 10_000;

async function fetchTelemetry(url: string): Promise<TelemetrySnapshot | null> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS) });
        if (!res.ok) return null;
        const body = (await res.json()) as TelemetrySnapshot;
        return body;
    } catch {
        return null;
    }
}

function detectAnomalies(snapshot: TelemetrySnapshot): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const now = new Date().toISOString();

    for (const svc of snapshot.services) {
        if (svc.metrics.errorRate > 0.02) {
            anomalies.push({
                id: `anomaly-error-rate-${svc.name}-${Date.now()}`,
                severity: 'critical',
                service: svc.name,
                title: `High error rate on ${svc.name}`,
                description: `Error rate is ${(svc.metrics.errorRate * 100).toFixed(2)}%, exceeding 2.0% threshold.`,
                metric: 'error_rate',
                observedValue: svc.metrics.errorRate,
                threshold: 0.02,
                detectedAt: now,
            });
        }
        if (svc.metrics.p99Latency > 3000) {
            anomalies.push({
                id: `anomaly-p99-${svc.name}-${Date.now()}`,
                severity: 'critical',
                service: svc.name,
                title: `P99 latency spike on ${svc.name}`,
                description: `P99 latency is ${svc.metrics.p99Latency}ms, exceeding 3000ms threshold.`,
                metric: 'p99_latency',
                observedValue: svc.metrics.p99Latency,
                threshold: 3000,
                detectedAt: now,
            });
        }
        if (svc.metrics.p95Latency > 2000) {
            anomalies.push({
                id: `anomaly-p95-${svc.name}-${Date.now()}`,
                severity: 'warning',
                service: svc.name,
                title: `Elevated P95 latency on ${svc.name}`,
                description: `P95 latency is ${svc.metrics.p95Latency}ms, exceeding 2000ms threshold.`,
                metric: 'p95_latency',
                observedValue: svc.metrics.p95Latency,
                threshold: 2000,
                detectedAt: now,
            });
        }
    }

    const errorRateMetrics = snapshot.metrics.filter((m) => m.metric === 'error.rate');
    for (const series of errorRateMetrics) {
        const recent = series.points.slice(-3);
        if (recent.length >= 2) {
            const avg = recent.reduce((s, p) => s + p.value, 0) / recent.length;
            const max = Math.max(...recent.map((p) => p.value));
            if (max > avg * 3 && max > 0.01) {
                anomalies.push({
                    id: `anomaly-spike-${series.tags.service}-${Date.now()}`,
                    severity: 'warning',
                    service: series.tags.service,
                    title: `Error rate spike on ${series.tags.service}`,
                    description: `Recent error rate spiked to ${(max * 100).toFixed(2)}% vs average ${(avg * 100).toFixed(2)}%.`,
                    metric: 'error_rate_spike',
                    observedValue: max,
                    threshold: avg * 3,
                    detectedAt: now,
                });
            }
        }
    }

    return anomalies;
}

export interface TelemetryResult {
    snapshot: TelemetrySnapshot | null;
    anomalies: Anomaly[];
    error: string | null;
}

export async function readTelemetry(configFile: string): Promise<TelemetryResult> {
    const base = await resolveTelemetryBase(configFile);
    if (!base) {
        return { snapshot: null, anomalies: [], error: 'No telemetry source configured' };
    }

    const snapshot = await fetchTelemetry(`${base}/api/telemetry/metrics`);
    if (!snapshot) {
        return { snapshot: null, anomalies: [], error: 'Telemetry source unreachable' };
    }

    const anomalies = detectAnomalies(snapshot);
    return { snapshot, anomalies, error: null };
}

async function resolveTelemetryBase(configFile: string): Promise<string | null> {
    if (!existsSync(configFile)) return null;
    try {
        const cfg = parseJsonUtf8File(configFile);
        if (cfg.telemetry?.baseUrl) return cfg.telemetry.baseUrl;

        const profile = getActiveProject(configFile);
        if (profile?.workspacePath) {
            const portFile = resolve(profile.workspacePath, '.server-port');
            if (existsSync(portFile)) {
                const { readFileSync } = await import('fs');
                const port = readFileSync(portFile, 'utf-8').trim();
                if (port) return `http://localhost:${port}`;
            }
        }
        return 'http://localhost:3000';
    } catch {
        return null;
    }
}
