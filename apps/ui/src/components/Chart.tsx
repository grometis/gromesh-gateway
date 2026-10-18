import { useId } from "react";

export interface ChartLine {
  key: string;
  label: string;
  /** CSS colour (a variable is fine). */
  color: string;
}

export interface ChartPoint {
  ts: string;
  [key: string]: number | null | string;
}

const WIDTH = 640;
const HEIGHT = 180;
const PAD = { top: 10, right: 12, bottom: 24, left: 44 };

/** A few round steps for the y axis. */
export function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const shortTime = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/**
 * Lines over time, one per `lines` entry, drawn as inline SVG: no chart library, the data is small
 * (at most 2000 points per series) and the page only needs to be readable, not interactive.
 */
export function LineChart({ title, points, lines, unit = "" }: { title: string; points: ChartPoint[]; lines: ChartLine[]; unit?: string }) {
  const id = useId();
  const values = points.flatMap((p) => lines.map((l) => p[l.key])).filter((v): v is number => typeof v === "number");
  const max = Math.max(0, ...values);
  const yTicks = ticks(max);
  const top = yTicks.at(-1) || 1;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const path = (key: string) => {
    let d = "";
    let open = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (typeof v !== "number") {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      open = true;
    });
    return d.trim();
  };
  const first = points[0]?.ts;
  const last = points.at(-1)?.ts;

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{title}</figcaption>
      {points.length === 0 ? (
        <p className="muted">Sem dados no período.</p>
      ) : (
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title}: ${lines.map((l) => l.label).join(", ")}`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="chart-tick">
                {t}{unit}
              </text>
            </g>
          ))}
          {lines.map((l) => (
            <path key={l.key} d={path(l.key)} fill="none" stroke={l.color} strokeWidth={2} data-series={l.key} />
          ))}
          {first && (
            <text x={PAD.left} y={HEIGHT - 6} className="chart-tick">
              {shortTime(first)}
            </text>
          )}
          {last && last !== first && (
            <text x={WIDTH - PAD.right} y={HEIGHT - 6} textAnchor="end" className="chart-tick">
              {shortTime(last)}
            </text>
          )}
        </svg>
      )}
      <ul className="chart-legend">
        {lines.map((l) => (
          <li key={l.key}>
            <svg className="chart-swatch" aria-hidden="true" viewBox="0 0 10 10">
              <rect width="10" height="10" rx="2" fill={l.color} />
            </svg>{" "}
            {l.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}
