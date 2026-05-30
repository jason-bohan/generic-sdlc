import React from 'react';

export interface GaugeZone {
    /** Upper bound of this zone as a fraction of max (0..1). */
    upTo: number;
    color: string;
}

interface GaugeProps {
    value: number;
    max: number;
    /** Caption under the gauge (e.g. "AI Spend / Budget"). */
    label?: string;
    /** Pre-formatted big number in the center (e.g. "$1.4k"). Falls back to the raw value. */
    valueLabel?: string;
    /** Colored arc zones, ascending by `upTo`. Defaults to green→amber→red. */
    zones?: GaugeZone[];
    size?: number;
}

const DEFAULT_ZONES: GaugeZone[] = [
    { upTo: 0.6, color: '#10b981' },  // healthy
    { upTo: 0.85, color: '#f59e0b' }, // watch
    { upTo: 1, color: '#ef4444' },    // over
];

// 270° sweep (a speedometer), from 135° (bottom-left) clockwise to 405°/45° (bottom-right).
const START_ANGLE = 135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const [x1, y1] = polar(cx, cy, r, startDeg);
    const [x2, y2] = polar(cx, cy, r, endDeg);
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/**
 * Zero-dependency SVG speedometer gauge. Renders a single value against a max as
 * a 270° dial with colored zones, tick marks, a needle, and a center readout.
 * Pure presentation — it does not compute anything; feed it a server-aggregated value.
 */
export function Gauge({ value, max, label, valueLabel, zones = DEFAULT_ZONES, size = 180 }: GaugeProps) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 16;
    const safeMax = max > 0 ? max : 1;
    const frac = Math.min(1, Math.max(0, value / safeMax));
    const needleDeg = START_ANGLE + frac * SWEEP;

    // Colored zone arcs across the full sweep.
    let zoneStartFrac = 0;
    const zoneArcs = zones.map((z, i) => {
        const a0 = START_ANGLE + zoneStartFrac * SWEEP;
        const a1 = START_ANGLE + Math.min(1, z.upTo) * SWEEP;
        zoneStartFrac = z.upTo;
        return <path key={i} d={arcPath(cx, cy, r, a0, a1)} fill="none" stroke={z.color} strokeWidth={10} strokeLinecap="butt" opacity={0.85} />;
    });

    // Tick marks at each zone boundary plus 0 and max.
    const tickFracs = [0, ...zones.map(z => z.upTo)];
    const ticks = tickFracs.map((f, i) => {
        const deg = START_ANGLE + Math.min(1, f) * SWEEP;
        const [ix, iy] = polar(cx, cy, r - 9, deg);
        const [ox, oy] = polar(cx, cy, r + 2, deg);
        return <line key={i} x1={ix} y1={iy} x2={ox} y2={oy} stroke="#94a3b8" strokeWidth={1.5} />;
    });

    const [nx, ny] = polar(cx, cy, r - 14, needleDeg);
    const overBudget = value > safeMax;

    return (
        <svg width={size} height={size * 0.78} viewBox={`0 0 ${size} ${size * 0.78}`} role="img"
            aria-label={`${label ?? 'gauge'}: ${valueLabel ?? value} of ${max}`} data-testid="ai-cost-gauge">
            {/* track */}
            <path d={arcPath(cx, cy, r, START_ANGLE, START_ANGLE + SWEEP)} fill="none" stroke="#e2e8f0" strokeWidth={10} opacity={0.35} />
            {zoneArcs}
            {ticks}
            {/* needle */}
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={overBudget ? '#ef4444' : '#0f172a'} strokeWidth={3} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={5} fill={overBudget ? '#ef4444' : '#0f172a'} />
            {/* center readout */}
            <text x={cx} y={cy + 30} textAnchor="middle" fontSize={size * 0.16} fontWeight={700}
                fill={overBudget ? '#ef4444' : 'currentColor'}>{valueLabel ?? String(value)}</text>
            {label && (
                <text x={cx} y={cy + 30 + size * 0.12} textAnchor="middle" fontSize={size * 0.075} fill="#64748b">{label}</text>
            )}
        </svg>
    );
}
