import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generate a throwaway self-signed TLS certificate using the system openssl.
 * Returns { key, cert } as PEM strings.
 */
export function createSelfSignedCertificate({ commonName = "localhost" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-v2-tls-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "1",
      "-nodes",
      "-subj", `/CN=${commonName}`,
      "-addext", `subjectAltName=DNS:${commonName},IP:127.0.0.1`,
    ], { stdio: "ignore" });
    const key = readFileSync(keyPath, "utf8");
    const cert = readFileSync(certPath, "utf8");
    return { key, cert };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
