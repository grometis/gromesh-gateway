import { useId, useState } from "react";
import { axisLeft, axisValue, chartDate, chartPeriod, chartTime, chartValue, ticks, useChartWidth } from "./chart-utils";

export interface HourBucket {
  ts: string;
  ok: number;
  errors: number;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28 };
const RADIUS = 4;
const ERROR_PRESENCE = "Ponto acima da barra: erro abaixo de 1 px (presença, sem escala).";

const number = (v: number) => chartValue(v);

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
  const { ref: plotRef, width } = useChartWidth();
  const max = buckets.reduce((max, b) => Math.max(max, b.ok + b.errors), 0);
  const yTicks = ticks(max, 1);
  const top = yTicks.at(-1)!;
  const left = axisLeft(yTicks);
  const plotW = Math.max(1, width - left - PAD.right);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 80))));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const hasTinyErrors = buckets.some((b) => b.errors > 0 && (b.errors / top) * plotH < 1);
  const slot = plotW / Math.max(1, buckets.length);
  const barW = Math.min(24, slot * 0.62);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const active = hover === null ? null : buckets[hover];

  return (
    <figure className="chart hourly" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{title}</figcaption>
      <p className="chart-context">Escala linear · requisições por hora</p>
      <p className="chart-context" id={`${id}-period`}>{chartPeriod(buckets)}</p>
      {buckets.length === 0 && <p className="muted">Sem dados no período.</p>}
      <ul className="chart-legend" aria-label="Legenda">
        <li>
          <span className="chart-swatch ok" aria-hidden="true" /> Sucesso
        </li>
        <li>
          <span className="chart-swatch err" aria-hidden="true" /> Erro (4xx + 5xx)
        </li>
        {hasTinyErrors && <li>
          <svg className="chart-swatch" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2.5" fill="var(--accent)" /></svg>{" "}{ERROR_PRESENCE}
        </li>}
      </ul>
      <div className="chart-plot" ref={plotRef} onMouseLeave={() => setHover(null)}>
        {buckets.length > 0 && <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-labelledby={`${id}-plot-title`} aria-describedby={`${id}-description ${id}-period`}>
          <title id={`${id}-plot-title`}>{`${title}: gráfico de barras`}</title>
          <desc id={`${id}-description`}>Sucesso e erro (4xx + 5xx) empilhados. Escala linear a partir de zero. Valores exatos na tabela abaixo. {hasTinyErrors ? ERROR_PRESENCE : ""}</desc>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-tick" x={left - 6} y={y(t) + 4} textAnchor="end">
                {axisValue(t)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = left + i * slot + (slot - barW) / 2;
            const okH = (b.ok / top) * plotH;
            const errH = (b.errors / top) * plotH;
            const floor = PAD.top + plotH;
            return (
              <g key={b.ts} className={hover === i ? "bar active" : "bar"}>
                <title>{`${chartTime(b.ts, true)} · Sucesso: ${number(b.ok)} · Erro: ${number(b.errors)}`}</title>
                <path className="bar-ok" d={column(x, floor - okH, barW, okH, b.errors === 0)} />
                <path className="bar-err" d={column(x, floor - okH - errH, barW, errH, true)} />
                {b.errors > 0 && errH < 1 && (
                  <circle className="bar-error-indicator" cx={x + barW / 2} cy={floor - okH - errH - 4} r={2.5} fill="var(--accent)">
                    <title>{`${chartTime(b.ts, true)} · Erro: ${number(b.errors)} · indicador de presença (sem escala)`}</title>
                  </circle>
                )}
                {((i % labelEvery === 0 && i < buckets.length - Math.ceil(labelEvery / 2)) || i === buckets.length - 1) && (
                  <text className="chart-tick" x={x + barW / 2} y={HEIGHT - 8} textAnchor={buckets.length === 1 ? "middle" : i === 0 ? "start" : i === buckets.length - 1 ? "end" : "middle"}>
                    {chartTime(b.ts)}
                  </text>
                )}
                {/* Larger than the mark: the whole slot answers the pointer. */}
                <rect className="hit" x={left + i * slot} y={PAD.top} width={slot} height={plotH} onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>}
        {active && hover !== null && (
          <div className="chart-tooltip" style={{ left: `${Math.max(0, Math.min(width - 200, left + (hover + 0.5) * slot - 100))}px` }} aria-hidden="true">
            <strong>{chartDate(active.ts)} {chartTime(active.ts)}</strong>
            <span>
              <span className="chart-swatch ok" /> {number(active.ok)} sucesso
            </span>
            <span>
              <span className="chart-swatch err" /> {number(active.errors)} erro
            </span>
          </div>
        )}
      </div>
      {buckets.length > 0 && <details className="chart-table">
        <summary aria-label={`Ver como tabela: ${title}`}>Ver como tabela</summary>
        <div className="chart-table-scroll" tabIndex={0} role="region" aria-label={`Tabela: ${title}`}><table aria-label={title}>
          <thead>
            <tr>
              <th scope="col">Data e hora local</th>
              <th scope="col">Sucesso</th>
              <th scope="col">Erro</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.ts}>
                <th scope="row" className="mono">{chartTime(b.ts, true)}</th>
                <td className="mono">{number(b.ok)}</td>
                <td className="mono">{number(b.errors)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </details>}
    </figure>
  );
}
