import { useId } from "react";
import { axisLeft, axisValue, chartDate, chartPeriod, chartTime, chartValue, isChartValue, ticks, useChartWidth } from "./chart-utils";
export { ticks } from "./chart-utils";

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

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28 };

/** Linear scale over every observation; null breaks the path instead of becoming a measured zero. */
export function LineChart({ title, points, lines, unit = "" }: { title: string; points: ChartPoint[]; lines: ChartLine[]; unit?: string }) {
  const id = useId();
  const { ref, width } = useChartWidth();
  let max = 0;
  let hasData = false;
  for (const point of points) for (const line of lines) {
    const value = point[line.key];
    if (isChartValue(value)) {
      max = Math.max(max, value);
      hasData = true;
    }
  }
  const yTicks = ticks(max, unit ? 0 : 1);
  const top = yTicks.at(-1)!;
  const left = axisLeft(yTicks, unit);
  const innerW = Math.max(1, width - left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const path = (key: string) => {
    let d = "";
    let open = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (!isChartValue(v)) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)} `;
      open = true;
    });
    return d.trim();
  };
  const first = points[0]?.ts;
  const last = points.at(-1)?.ts;
  const acrossDays = first && last && new Date(first).toDateString() !== new Date(last).toDateString();
  const timeLabel = (ts: string) => acrossDays ? `${chartDate(ts)} ${chartTime(ts)}` : chartTime(ts);

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{title}</figcaption>
      <p className="chart-context">Escala linear · {unit || "quantidade por intervalo"}</p>
      <p className="chart-context" id={`${id}-period`}>{chartPeriod(points)}</p>
      {!hasData && <p className="muted">Sem dados no período.</p>}
      <div className="chart-plot" ref={ref}>
        {hasData && (
          <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-labelledby={`${id}-plot-title`} aria-describedby={`${id}-description ${id}-period`}>
            <title id={`${id}-plot-title`}>{`${title}: ${lines.map((l) => l.label).join(", ")}`}</title>
            <desc id={`${id}-description`}>Escala linear a partir de zero. Lacunas indicam ausência de dado. Valores exatos na tabela abaixo.</desc>
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
                <text x={left - 6} y={y(t) + 4} textAnchor="end" className="chart-tick">{axisValue(t)}{unit ? ` ${unit}` : ""}</text>
              </g>
            ))}
            {lines.map((l, series) => {
              const peak = points.reduce((best, point, i) => {
                const value = point[l.key];
                const previous = points[best]?.[l.key];
                return isChartValue(value) && (!isChartValue(previous) || value > previous) ? i : best;
              }, -1);
              return (
                <g key={l.key}>
                  <path d={path(l.key)} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray={series === 0 ? undefined : series === 1 ? "6 3" : "2 3"} data-series={l.key}>
                    <title>{l.label}</title>
                  </path>
                  {points.map((p, i) => {
                    const value = p[l.key];
                    if (!isChartValue(value)) return null;
                    const isolated = !isChartValue(points[i - 1]?.[l.key]) && !isChartValue(points[i + 1]?.[l.key]);
                    if (points.length > 60 && i !== peak && !isolated) return null;
                    return (
                      <circle key={p.ts} cx={x(i)} cy={y(value)} r={3} fill={l.color}>
                        <title>{`${chartTime(p.ts, true)} · ${l.label}: ${chartValue(value, unit)}`}</title>
                      </circle>
                    );
                  })}
                </g>
              );
            })}
            {first && <text x={points.length === 1 ? x(0) : left} y={HEIGHT - 6} textAnchor={points.length === 1 ? "middle" : "start"} className="chart-tick">{timeLabel(first)}</text>}
            {last && last !== first && <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="chart-tick">{timeLabel(last)}</text>}
          </svg>
        )}
      </div>
      <ul className="chart-legend" aria-label="Legenda">
        {lines.map((l, series) => (
          <li key={l.key}>
            <svg className="chart-swatch" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
              <path d="M0,5H10" stroke={l.color} strokeWidth={2} strokeDasharray={series === 0 ? undefined : series === 1 ? "6 3" : "2 3"} />
            </svg>{" "}{l.label}
          </li>
        ))}
      </ul>
      {points.length > 0 && (
        <details className="chart-table">
          <summary aria-label={`Ver como tabela: ${title}`}>Ver como tabela</summary>
          <div className="chart-table-scroll" tabIndex={0} role="region" aria-label={`Tabela: ${title}`}>
            <table aria-label={title}>
              <thead>
                <tr>
                  <th scope="col">Data e hora local</th>
                  {lines.map((l) => <th key={l.key} scope="col">{l.label}{unit ? ` (${unit})` : ""}</th>)}
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.ts}>
                    <th scope="row" className="mono">{chartTime(p.ts, true)}</th>
                    {lines.map((l) => <td key={l.key} className="mono">{chartValue(p[l.key], unit)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
