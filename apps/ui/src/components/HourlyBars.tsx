import { useEffect, useId, useRef, useState } from "react";
import { ticks } from "./Chart";

export interface HourBucket {
  ts: string;
  ok: number;
  errors: number;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 44 };
/** Between stacked segments, in the surface colour: the segments read apart without a stroke. */
const GAP = 2;
const RADIUS = 4;

const hour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const number = (v: number) => v.toLocaleString("pt-BR");

/** A column whose top corners are rounded (the data end) and whose base is square (the baseline). */
function column(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return "";
  const r = round ? Math.min(RADIUS, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Requests per hour, successes stacked under errors (4xx + 5xx), as inline SVG. Hovering a column shows its
 * numbers; the same data is available as a table for screen readers and for reading exact values.
 */
export function HourlyBars({ title, buckets }: { title: string; buckets: HourBucket[] }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so text stays at its CSS size instead of scaling with the SVG.
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry!.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const max = Math.max(0, ...buckets.map((b) => b.ok + b.errors));
  // The axis ends on the first round step at or above the tallest column, never below it.
  const base = ticks(max);
  const step = base.length > 1 ? base[1]! - base[0]! : Math.max(1, max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const yTicks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const labelEvery = width < 520 ? 6 : 3;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, buckets.length);
  const barW = Math.min(24, slot * 0.62);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const active = hover === null ? null : buckets[hover];

  return (
    <figure className="chart hourly" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{title}</figcaption>
      <ul className="chart-legend" aria-label="Legenda">
        <li>
          <span className="chart-swatch ok" aria-hidden="true" /> Sucesso
        </li>
        <li>
          <span className="chart-swatch err" aria-hidden="true" /> Erro (4xx + 5xx)
        </li>
      </ul>
      <div className="chart-plot" ref={plotRef} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`${title}: gráfico de barras; os valores estão na tabela abaixo`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-tick" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                {number(t)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const okH = (b.ok / top) * plotH;
            const errH = (b.errors / top) * plotH;
            // The gap comes out of the upper segment so the column's total height stays true to the axis.
            const errDrawn = b.ok > 0 && b.errors > 0 ? Math.max(0, errH - GAP) : errH;
            const floor = PAD.top + plotH;
            return (
              <g key={b.ts} className={hover === i ? "bar active" : "bar"}>
                <path className="bar-ok" d={column(x, floor - okH, barW, okH, b.errors === 0)} />
                <path className="bar-err" d={column(x, floor - okH - errH, barW, errDrawn, true)} />
                {i % labelEvery === 0 && (
                  <text className="chart-tick" x={x + barW / 2} y={HEIGHT - 8} textAnchor="middle">
                    {hour(b.ts)}
                  </text>
                )}
                {/* Larger than the mark: the whole slot answers the pointer. */}
                <rect className="hit" x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {active && hover !== null && (
          <div className="chart-tooltip" style={{ left: `${((PAD.left + (hover + 0.5) * slot) / width) * 100}%` }} aria-hidden="true">
            <strong>{hour(active.ts)}</strong>
            <span>
              <span className="chart-swatch ok" /> {number(active.ok)} sucesso
            </span>
            <span>
              <span className="chart-swatch err" /> {number(active.errors)} erro
            </span>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Ver como tabela</summary>
        <table aria-label={title}>
          <thead>
            <tr>
              <th scope="col">Hora</th>
              <th scope="col">Sucesso</th>
              <th scope="col">Erro</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.ts}>
                <td className="mono">{hour(b.ts)}</td>
                <td className="mono">{number(b.ok)}</td>
                <td className="mono">{number(b.errors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
