import { useEffect, useRef, useState } from "react";

export const isChartValue = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Round upward with headroom; never use a tick below the maximum as the plot's ceiling. */
export function ticks(max: number, minStep = 0): number[] {
  if (!isChartValue(max) || max === 0) return [0, 1];
  const target = max <= Number.MAX_VALUE / 1.1 ? max * 1.1 : max;
  const raw = target / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? max);
  // At the limits of IEEE-754 there may be no representable round ceiling above the maximum.
  if (!Number.isFinite(step) || step <= 0) return [0, max];
  const count = Math.ceil(target / step);
  if (!Number.isFinite(count * step)) return [0, max / 2, max];
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(15)));
}

const axisNumber = new Intl.NumberFormat("pt-BR", { maximumSignificantDigits: 4 });
const scientific = new Intl.NumberFormat("pt-BR", { notation: "scientific", maximumSignificantDigits: 4 });
const exactNumber = new Intl.NumberFormat("pt-BR", { maximumSignificantDigits: 21 });
export const axisValue = (value: number) => (value >= 1e6 || (value > 0 && value < 0.001) ? scientific : axisNumber).format(value);
export const chartValue = (value: unknown, unit = "") => isChartValue(value) ? `${exactNumber.format(value)}${unit ? ` ${unit}` : ""}` : "Sem dado";
export const axisLeft = (values: number[], unit = "") => Math.max(44, ...values.map((v) => (axisValue(v).length + (unit ? unit.length + 1 : 0)) * 7 + 12));

export const chartTime = (iso: string, full = false) => new Date(iso).toLocaleString("pt-BR", full
  ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }
  : { hour: "2-digit", minute: "2-digit" });
export const chartDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
export function chartPeriod(points: { ts: string }[]) {
  const first = points[0]?.ts;
  const last = points.at(-1)?.ts;
  if (!first || !last) return "";
  const zone = new Intl.DateTimeFormat("pt-BR", { timeZoneName: "short" }).formatToParts(new Date(first)).find((p) => p.type === "timeZoneName")?.value;
  return `Pontos de ${chartTime(first, true)}${last !== first ? ` a ${chartTime(last, true)}` : ""} · Horário local (${zone})`;
}

/** Observe real CSS pixels so SVG labels do not shrink with the container. */
export function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.max(1, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
