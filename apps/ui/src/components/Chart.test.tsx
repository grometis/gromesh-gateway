import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineChart, ticks, type ChartPoint } from "./Chart";
import { HourlyBars } from "./HourlyBars";

const ts = "2026-10-17T09:00:00Z";
const lines = [{ key: "value", label: "Latência p95", color: "#0b2a2a" }];
const render = (points: ChartPoint[]) => renderToStaticMarkup(<LineChart title="Latência total" points={points} lines={lines} unit="ms" />);

// These fail if the last tick is below the data, or if small values are rounded to zero.
describe("chart scale", () => {
  it.each([0, 1, 650, 131.5, 600, 0.13, 0.00000013, 1_234_567_890_123, 1e300])("contains %s with a finite ceiling and room above a nonzero maximum", (max) => {
    const result = ticks(max);
    expect(result[0]).toBe(0);
    expect(result.at(-1)).toBeGreaterThan(max);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.length).toBeLessThanOrEqual(7);
    expect(result.every(Number.isFinite)).toBe(true);
    expect(result.every((tick, i) => i === 0 || tick > result[i - 1]!)).toBe(true);
  });

  it("keeps distinct decimal ticks without floating point noise", () => {
    expect(ticks(0.13)).toEqual([0, 0.05, 0.1, 0.15]);
  });
});

function coordinates(html: string) {
  return [...html.matchAll(/<path[^>]*d="([^"]*)"[^>]*data-series/g)].flatMap((path) => [...path[1]!.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) })));
}

describe("LineChart", () => {
  it("keeps a non-round maximum and the zero baseline in the plot", () => {
    const html = render([{ ts, value: 0 }, { ts: "2026-10-17T10:00:00Z", value: 131.5 }]);
    expect(coordinates(html)).toHaveLength(2);
    for (const point of coordinates(html)) expect(point.y).toBeGreaterThan(10);
    expect(html).toContain("131,5 ms");
  });

  it("shows a lone point and isolated observations on either side of null", () => {
    const html = render([{ ts, value: 131.5 }]);
    expect(html).toContain("<circle");
    expect(html).toContain("<title");
    const gap = render([{ ts, value: 1 }, { ts: "2026-10-17T10:00:00Z", value: null }, { ts: "2026-10-17T11:00:00Z", value: 2 }]);
    expect(gap.match(/d="M[^\"]* M[^\"]*"/)).not.toBeNull();
    expect(gap).toContain("Sem dado");
  });

  it("distinguishes absent values from a measured zero", () => {
    expect(render([])).toContain("Sem dados no período.");
    expect(render([{ ts, value: null }])).toContain("Sem dados no período.");
    expect(render([{ ts, value: 0 }])).not.toContain("Sem dados no período.");
    expect(render([{ ts, value: 0 }])).toContain("0 ms");
  });

  it("does not let non-finite values poison valid series", () => {
    const html = render([{ ts, value: NaN }, { ts: "2026-10-17T10:00:00Z", value: 1 }, { ts: "2026-10-17T11:00:00Z", value: Infinity }]);
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain("1 ms");
  });

  it("keeps every point and the extreme in a dense series, with exact accessible values", () => {
    const points = Array.from({ length: 2000 }, (_, i) => ({ ts: new Date(Date.parse(ts) + i * 60_000).toISOString(), value: i === 1001 ? 1_234_567_890_123 : 1 }));
    const html = render(points);
    expect(coordinates(html)).toHaveLength(2000);
    expect(Math.min(...coordinates(html).map((p) => p.y))).toBeGreaterThan(10);
    expect(html).toContain("1.234.567.890.123 ms");
    expect(html).toContain("Ver como tabela");
    expect(html).toContain('aria-label="Legenda"');
    expect(html).toContain("Horário local");
    expect(html).toContain("17/10/2026");
    expect(html).toContain("18/10/2026");
  });

  it("marks each series' extreme even in a dense chart", () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ ts: new Date(Date.parse(ts) + i * 60_000).toISOString(), value: i === 50 ? 131.5 : 1 }));
    const html = render(points);
    expect(html.match(/<circle/g)).toHaveLength(1);
    expect(html).toContain("Latência p95: 131,5 ms</title>");
  });

  it("uses the maximum across series and preserves each series' values", () => {
    const html = renderToStaticMarkup(<LineChart title="Erros" points={[{ ts, success: 650, errors: 3 }]} lines={[{ key: "success", label: "Sucesso", color: "green" }, { key: "errors", label: "Erro", color: "red" }]} />);
    for (const point of coordinates(html)) expect(point.y).toBeGreaterThan(10);
    expect(html).toContain(">650</td>");
    expect(html).toContain(">3</td>");
  });
});

describe("HourlyBars", () => {
  it("scales the stacked total, with headroom even for a round maximum", () => {
    const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 600, errors: 400 }]} />);
    const ys = [...html.matchAll(/<path[^>]* d="M[\d.]+,[\d.]+V([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(2);
    expect(Math.min(...ys)).toBeGreaterThan(16);
    expect(html).toContain("600");
    expect(html).toContain("400");
  });

  it("keeps a small error segment instead of subtracting it as a visual gap", () => {
    const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 1_000_000, errors: 1 }]} />);
    expect(html).toMatch(/class="bar-err" d="M/);
  });

  it("reports empty buckets as absent, but keeps zero buckets as measured values", () => {
    expect(renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[]} />)).toContain("Sem dados no período.");
    const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 0, errors: 0 }]} />);
    expect(html).not.toContain("Sem dados no período.");
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
