// Run from repository root: tests/load/run.sh (official grafana/k6:0.57.0).
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
const overhead = new Trend('kong_proxy_latency_ms', true);
const serverErrors = new Counter('kong_5xx');
const invalid = new Counter('invalid_responses');
const missingLatency = new Counter('missing_proxy_latency');
const negativeLatency = new Counter('negative_proxy_latency');
export const options = {
  scenarios: { proxy: { executor: 'constant-arrival-rate', rate: 1000, timeUnit: '1s', duration: '60s', preAllocatedVUs: 2500, maxVUs: 2500, gracefulStop: '20s' } },
  thresholds: {
    kong_5xx: ['count==0'], invalid_responses: ['count==0'], missing_proxy_latency: ['count==0'],
    http_req_failed: ['rate==0'], dropped_iterations: ['count==0'], iterations: ['count>=60000'],
  },
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};
export function setup() { console.log('W8_LOAD_READY'); }
export default function () {
  const response = http.get(__ENV.K6_URL, { headers: { apikey: __ENV.K6_API_KEY }, timeout: '15s', redirects: 0 });
  const raw = response.headers['X-Kong-Proxy-Latency'];
  const latency = Number(raw);
  // Proxy latency excludes upstream time; adding upstream latency would measure backend work too.
  missingLatency.add(raw === undefined || raw === '' || !Number.isFinite(latency) ? 1 : 0);
  // Preserve signed raw samples; record observed negative headers separately.
  negativeLatency.add(raw !== undefined && raw !== '' && latency < 0 ? 1 : 0);
  if (raw !== undefined && raw !== '' && Number.isFinite(latency)) overhead.add(latency);
  serverErrors.add(response.status >= 500 ? 1 : 0);
  invalid.add(response.status !== 200 || response.headers['X-Ratelimit-Limit-Minute'] !== '6000000' ? 1 : 0);
}
export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data, null, 2) };
}
