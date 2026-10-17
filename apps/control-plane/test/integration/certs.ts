import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test certificates made with the openssl CLI (Node cannot issue X.509). Only options OpenSSL 3.0 already has
 * (the CI runner's version): an expired certificate goes through `openssl ca -startdate/-enddate`.
 */
export interface TestCert {
  cert: string;
  key: string;
  /** The issuing root for chains; the certificate itself when self-signed. */
  root: string;
}

const EC = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];

function inTemp<T>(work: (dir: string, run: (...args: string[]) => void) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gromesh-certs-"));
  try {
    return work(dir, (...args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const san = (names: string[]) => `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`;

export function selfSigned(cn: string, names: string[] = [cn], days = 30): TestCert {
  return inTemp((dir, run) => {
    run("req", "-x509", ...EC, "-keyout", "k.pem", "-out", "c.pem", "-days", String(days), "-subj", `/CN=${cn}`, "-addext", san(names));
    const cert = readFileSync(join(dir, "c.pem"), "utf8");
    return { cert, key: readFileSync(join(dir, "k.pem"), "utf8"), root: cert };
  });
}

/** Root → intermediate → leaf; `cert` is the leaf followed by the intermediate, as the contract expects. */
export function chain(cn: string, names: string[] = [cn]): TestCert {
  return inTemp((dir, run) => {
    writeFileSync(join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
    writeFileSync(join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\n${san(names)}\n`);
    run("req", "-x509", ...EC, "-keyout", "root.key", "-out", "root.pem", "-days", "30", "-subj", "/CN=Gromesh Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    run("req", "-new", ...EC, "-keyout", "int.key", "-out", "int.csr", "-subj", "/CN=Gromesh Test Intermediate");
    run("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "int.pem", "-days", "30", "-extfile", "ca.ext");
    run("req", "-new", ...EC, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${cn}`);
    run("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "30", "-extfile", "leaf.ext");
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    return { cert: read("leaf.pem") + read("int.pem"), key: read("leaf.key"), root: read("root.pem") };
  });
}

/** A leaf valid for one day in 2020. */
export function expired(cn: string): TestCert {
  return inTemp((dir, run) => {
    writeFileSync(join(dir, "index.txt"), "");
    writeFileSync(join(dir, "serial"), "1000\n");
    writeFileSync(
      join(dir, "ca.cnf"),
      ["[ca]", "default_ca=d", "[d]", "dir=.", "database=index.txt", "new_certs_dir=.", "serial=serial", "default_md=sha256", "policy=p", "unique_subject=no", "[p]", "commonName=supplied", ""].join("\n"),
    );
    run("req", "-x509", ...EC, "-keyout", "ca.key", "-out", "ca.pem", "-days", "30", "-subj", "/CN=Gromesh Expired CA");
    run("req", "-new", ...EC, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${cn}`);
    run("ca", "-batch", "-config", "ca.cnf", "-cert", "ca.pem", "-keyfile", "ca.key", "-in", "leaf.csr", "-out", "leaf.pem", "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", "-notext");
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    return { cert: read("leaf.pem"), key: read("leaf.key"), root: read("ca.pem") };
  });
}
