const project = "gromesh-ci-123-1";
const id = "test-run-123456789";
const secret = "fixture-secret-never-in-diagnostics";
export function fixture() {
  const env = {
    COMPOSE_PROJECT_NAME: project, GROMESH_DISPOSABLE_ID: id,
    COMPOSE_FILE: "deploy/compose/docker-compose.yml:deploy/compose/disposable.yml",
    UI_URL: "http://127.0.0.1:5174", CP_URL: "http://127.0.0.1:3000/api/v1",
    CLICKHOUSE_URL: "http://127.0.0.1:8123", POSTGRES_PORT: "55442",
    KONG_PROXY_URL: "http://127.0.0.1:8000", KONG_STATUS_URL: "http://127.0.0.1:8100/status/ready",
    KONG_METRICS_URL: "http://127.0.0.1:8100", ECHO_URL: "http://127.0.0.1:8080",
    KONG_VALIDATOR_URL: "http://127.0.0.1:8011", KONG_PROXY_TLS_PORT: "8443",
    POSTGRES_PASSWORD: secret, BOOTSTRAP_ADMIN_PASSWORD: secret, BOOTSTRAP_ADMIN_EMAIL: "ci@example.test",
    CLICKHOUSE_PASSWORD: secret, CLICKHOUSE_READER_PASSWORD: secret, CLICKHOUSE_WRITER_PASSWORD: secret,
    GROMESH_COLLECTOR_TOKEN: secret, GROMESH_ENCRYPTION_KEY: `ci:${Buffer.alloc(32, 1).toString("base64")}`,
    GROMESH_FINGERPRINT_KEY: Buffer.alloc(32, 2).toString("base64"),
  };
  const volumes = [{ name: `${project}_pg-data`, project, disposableId: id }];
  const own = (service, ports, environment = {}) => ({ id: service, project, service, disposableId: id, ports, bindings: ports.map(port => ({ port, host: "127.0.0.1", protocol: "tcp" })), networks: [`${project}_default`], environment, mounts: [], running: true });
  const containers = [own("ui", [5174]), own("control-plane", [3000], {
      CLICKHOUSE_URL: "http://clickhouse:8123", KONG_VALIDATOR_URL: "http://kong-validator:8001",
      DATABASE_URL: `postgres://gromesh:${secret}@postgres:5432/gromesh`, BOOTSTRAP_ADMIN_PASSWORD: secret,
      CLICKHOUSE_PASSWORD: secret, GROMESH_ENCRYPTION_KEY: env.GROMESH_ENCRYPTION_KEY, GROMESH_FINGERPRINT_KEY: env.GROMESH_FINGERPRINT_KEY,
    }), own("clickhouse", [8123], { CLICKHOUSE_PASSWORD: secret }), own("postgres", [55442], { POSTGRES_PASSWORD: secret }),
    own("kong", [8000, 8443, 8100], { GROMESH_COLLECTOR_TOKEN: secret }), own("kong-validator", [8011]), own("echo", [8080]),
    own("vector", [], { CLICKHOUSE_PASSWORD: secret, GROMESH_COLLECTOR_TOKEN: secret })];
  containers.find(c => c.service === "postgres").mounts = [{ type: "volume", name: volumes[0].name, destination: "/var/lib/postgresql/data" }];
  const labels = { "com.grometis.gromesh.disposable": id };
  const compose = {name: project, services: {}, volumes: {"pg-data": {name: `${project}_pg-data`, labels}}, networks: {default: {name: `${project}_default`, labels}}};
  const images = {};
  for (const service of [...containers.map(c => c.service), "smoke", "clickhouse-init", "observability-acceptance"]) {
    compose.services[service] = {image: `fixture/${service}`, labels, networks: {default: {}}};
    images[`fixture/${service}`] = [];
  }
  compose.services.smoke.volumes = [{type: "bind", source: new URL("../scripts", import.meta.url).pathname, target: "/repo/scripts", read_only: true}];
  return { env, containers, volumes, compose, images, context: {Endpoints: {docker: {Host: "unix:///var/run/docker.sock"}}}, networks: [{ name: `${project}_default`, project, disposableId: id }] };
}
export function remappedFixture() {
  const f = fixture();
  f.env.CLICKHOUSE_PORT = "18124";
  f.env.KONG_VALIDATOR_PORT = "18012";
  for (const [service, variable, port] of [
    ["clickhouse", "CLICKHOUSE_URL", 18124],
    ["kong-validator", "KONG_VALIDATOR_URL", 18012],
    ["postgres", "POSTGRES_PORT", 55443],
  ]) {
    const container = f.containers.find(c => c.service === service);
    const original = container.ports[0];
    f.env[variable] = variable === "POSTGRES_PORT" ? String(port) : `http://127.0.0.1:${port}`;
    container.ports = [port];
    container.bindings[0].port = port;
    // The development stack publishes these ports but is never a destination of this run.
    f.containers.push({ ...container, id: `shared-${service}`, project: "gromesh", disposableId: "",
      ports: [service === "postgres" ? 55433 : original],
      bindings: [{ port: service === "postgres" ? 55433 : original, host: "127.0.0.1", protocol: "tcp" }],
      mounts: [], networks: ["gromesh_default"] });
  }
  return f;
}
