import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LineChart, ticks, type ChartPoint } from "./Chart";
import { HourlyBars } from "./HourlyBars";
import * as chartUtils from "./chart-utils";

const ts = "2026-10-17T09:00:00Z";
const lines = [{ key: "value", label: "Latência p95", color: "#0b2a2a" }];
const render = (points: ChartPoint[]) => renderToStaticMarkup(<LineChart title="Latência total" points={points} lines={lines} unit="ms" />);

afterEach(() => vi.restoreAllMocks());

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

function columnBounds(html: string, className: string) {
  const path = html.match(new RegExp(`<path class="${className}" d="([^"]+)"`))![1]!;
  const values = [...path.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]));
  return { left: values[0]!, right: values[8]!, top: values[4]!, bottom: values[1]! };
}

it("gives table controls distinct chart names without repeating the control label in SVG descriptions", () => {
  const titles = ["Requisições", "Erros", "Latência total"];
  const html = renderToStaticMarkup(<>
    {titles.map((title) => <LineChart key={title} title={title} points={[{ ts, value: 1 }]} lines={lines} />)}
    <HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 1, errors: 0 }]} />
  </>);
  for (const title of [...titles, "Requisições por hora"]) {
    expect(html).toContain(`<summary aria-label="Ver como tabela: ${title}">Ver como tabela</summary>`);
  }
  const descriptions = [...html.matchAll(/<desc[^>]*>([^<]*)<\/desc>/g)];
  expect(descriptions).toHaveLength(4);
  for (const description of descriptions) expect(description[1]).not.toContain("Ver como tabela");
});

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

  it("shows a separate visible presence marker without enlarging a subpixel error segment", () => {
    const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 1_000_000, errors: 1 }]} />);
    const ok = columnBounds(html, "bar-ok");
    const error = columnBounds(html, "bar-err");
    const errorHeight = error.bottom - error.top;
    expect(errorHeight).toBeGreaterThan(0);
    expect(errorHeight).toBeLessThan(1);
    expect(errorHeight / (ok.bottom - ok.top)).toBeCloseTo(1 / 1_000_000, 10);
    expect(error.bottom).toBeCloseTo(ok.top, 10);
    const marker = html.match(/<circle class="bar-error-indicator" cx="([^"]+)" cy="([^"]+)" r="([^"]+)" fill="([^"]+)"><title>([^<]+)<\/title><\/circle>/);
    expect(marker).not.toBeNull();
    const [, cx, cy, r, fill, title] = marker!;
    expect(Number(cx)).toBeCloseTo((error.left + error.right) / 2);
    expect(Number(r)).toBeGreaterThanOrEqual(2);
    expect(Number(cy) + Number(r)).toBeLessThan(error.top);
    expect(Number(cy) - Number(r)).toBeGreaterThanOrEqual(0);
    expect(fill).toBe("var(--accent)");
    expect(title).toContain("Erro: 1");
    expect(title).toContain("presença");
    expect(html).toMatch(/<desc[^>]*>[^<]*Ponto acima da barra: erro abaixo de 1 px/);
    expect(html).toMatch(/<li>.*Ponto acima da barra: erro abaixo de 1 px/);
    expect(html).toContain('class="mono">1</td>');
  });

  it.each([0, 1, 8, 9])("only marks positive errors whose segment is below 1 px (%s errors)", (errors) => {
    const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 1000 - errors, errors }]} />);
    const expected = errors > 0 && errors <= 8;
    expect(html.includes('class="bar-error-indicator"')).toBe(expected);
    expect(html.includes("Ponto acima da barra")).toBe(expected);
  });

  it.each([320, 640, 1280])("centers hour ticks on their bars and anchors edge labels inward at %s px", (width) => {
    vi.spyOn(chartUtils, "useChartWidth").mockReturnValue({ ref: { current: null }, width });
    for (const count of [1, 2, 24]) {
      const buckets = Array.from({ length: count }, (_, i) => ({ ts: new Date(Date.parse(ts) + i * 3_600_000).toISOString(), ok: 600, errors: 0 }));
      const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={buckets} />);
      const bars = [...html.matchAll(/<g class="bar">(.*?)<\/g>/g)];
      expect(bars).toHaveLength(count);
      let labels = 0;
      bars.forEach((bar, i) => {
        const tick = bar[1]!.match(/<text class="chart-tick" x="([^"]+)" y="212" text-anchor="([^"]+)">([^<]+)<\/text>/);
        if (!tick) return;
        labels++;
        const bounds = columnBounds(bar[1]!, "bar-ok");
        expect(Number(tick[1])).toBeCloseTo((bounds.left + bounds.right) / 2);
        expect(tick[2]).toBe(count === 1 ? "middle" : i === 0 ? "start" : i === count - 1 ? "end" : "middle");
        expect(tick[3]).toBe(chartUtils.chartTime(buckets[i]!.ts));
      });
      expect(labels).toBeGreaterThanOrEqual(Math.min(count, 2));
    }
  });

  it("reports empty buckets as absent, but keeps zero buckets as measured values", () => {
    expect(renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[]} />)).toContain("Sem dados no período.");
    const html = renderToStaticMarkup(<HourlyBars title="Requisições por hora" buckets={[{ ts, ok: 0, errors: 0 }]} />);
    expect(html).not.toContain("Sem dados no período.");
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
