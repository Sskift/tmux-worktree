import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The controlled-attach proxy is an embedded standalone Python program
// (spawned via spawnSync against the daemon socket). This test extracts the
// proxy's definition prefix (globals + request()/renew_lease()/error
// classification, stopping before the forkpty main loop) and drives the
// renewal/write state machine against a real fake Unix-socket daemon.
function proxyPrefix() {
  const src = readFileSync(
    new URL("../src/terminalControl/attach.ts", import.meta.url),
    "utf8",
  );
  const match = src.match(/const CONTROLLED_ATTACH_PROXY = String\.raw`([\s\S]*?)`;\n/);
  assert.ok(match, "embedded proxy source must be present");
  const cut = match[1].indexOf("pid, master_fd = os.forkpty()");
  assert.ok(cut > 0, "forkpty marker must exist");
  return match[1].slice(0, cut);
}

const DRIVER = `
import sys, os, json, socket, threading, time, importlib.util

prefix_path, scenario = sys.argv[1], sys.argv[2]
sock_dir = os.path.join("/tmp", "twa-" + str(os.getpid()) + "-" + scenario)
os.makedirs(sock_dir, exist_ok=True)
sock_path = os.path.join(sock_dir, "d.sock")

state = {"renew_calls": 0, "input_calls": 0}

def daemon_thread():
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(8)
    server.settimeout(10)
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            conn, _ = server.accept()
        except socket.timeout:
            return
        try:
            conn.settimeout(5)
            buf = b""
            while b"\\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
            frame = json.loads(buf.split(b"\\n", 1)[0].decode("utf-8"))
            kind = frame.get("type")
            if kind == "lease.renew":
                state["renew_calls"] += 1
                if scenario == "denied":
                    out = {"protocolVersion": 1, "requestId": frame["requestId"], "ok": False,
                           "error": {"code": "PERMISSION_DENIED", "message": "ownership taken"}}
                else:
                    # Fail the first four renews with the retryable lock code,
                    # then answer successfully (enough to exhaust the budget and
                    # then self-heal).
                    if state["renew_calls"] <= 4:
                        out = {"protocolVersion": 1, "requestId": frame["requestId"], "ok": False,
                               "error": {"code": "RESOURCE_EXHAUSTED", "message": "lock wait", "retryable": True}}
                    else:
                        out = {"protocolVersion": 1, "requestId": frame["requestId"], "ok": True,
                               "result": {"lease": frame.get("lease")}}
            elif kind == "input.raw":
                state["input_calls"] += 1
                if scenario == "input-transient":
                    out = {"protocolVersion": 1, "requestId": frame["requestId"], "ok": False,
                           "error": {"code": "RESOURCE_EXHAUSTED", "message": "lock wait", "retryable": True}}
                else:
                    out = {"protocolVersion": 1, "requestId": frame["requestId"], "ok": True,
                           "result": {}}
            else:
                out = {"protocolVersion": 1, "requestId": frame["requestId"], "ok": True, "result": {}}
            conn.sendall((json.dumps(out) + "\\n").encode("utf-8"))
        finally:
            conn.close()

threading.Thread(target=daemon_thread, daemon=True).start()
# wait for the listener
for _ in range(50):
    if os.path.exists(sock_path):
        break
    time.sleep(0.02)

# Load the proxy prefix with a config that points at the fake socket.
config_path = os.path.join(sock_dir, "config.json")
with open(config_path, "w", encoding="utf-8") as handle:
    json.dump({"socketPath": sock_path, "sessionName": "s", "tmuxBin": "/bin/true",
               "lease": {"controlTargetId": "t", "leaseId": "l", "fence": "1"}}, handle)
sys.argv = ["proxy", config_path]
spec = importlib.util.spec_from_file_location("proxy", prefix_path)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
proxy.notice = lambda message: None  # keep driver stdout clean for the result line

failures = []
def check(name, cond):
    if not cond:
        failures.append(name)

if scenario == "retry":
    proxy.next_renewal = 0.0
    proxy.renew_lease()
    check("writable after 1 transient fail", proxy.writable is True)
    proxy.next_renewal = 0.0
    proxy.renew_lease()
    check("writable after 2 transient fails", proxy.writable is True)
    check("not confirmed read-only while under budget", getattr(proxy, "read_only_confirmed", False) is False)
    # Exhaust the transient budget: failures reaching the limit flip read-only
    # but keep renewing (no deterministic latch).
    proxy.renew_failures = 2
    proxy.next_renewal = 0.0
    proxy.renew_lease()   # call 3 -> transient fail, budget exhausted
    check("read-only after budget exhausted", proxy.writable is False)
    check("still renews (no deterministic latch)", getattr(proxy, "deterministic_lease_loss", None) is False)
    proxy.next_renewal = 0.0
    proxy.renew_lease()   # call 4 -> transient fail, stays read-only
    check("remains read-only while failures continue", proxy.writable is False)
    # Next renew succeeds (call 5) -> self-heal back to writable.
    proxy.next_renewal = 0.0
    proxy.renew_lease()
    check("self-heals writable on later success", proxy.writable is True)
elif scenario == "denied":
    proxy.next_renewal = 0.0
    proxy.renew_lease()
    check("PERMISSION_DENIED latches read-only", proxy.writable is False)
    check("PERMISSION_DENIED marks deterministic lease loss", getattr(proxy, "deterministic_lease_loss", None) is True)
    before = state["renew_calls"]
    proxy.next_renewal = 0.0
    proxy.renew_lease()
    check("deterministic loss stops further renew requests", state["renew_calls"] == before)
elif scenario == "input-transient":
    proxy.controlled_input(b"x")
    check("transient write failure keeps writable", proxy.writable is True)
    proxy.controlled_input(b"y")
    check("subsequent write is still attempted", state["input_calls"] == 2)

print(json.dumps({"failures": failures}))
try:
    import shutil
    shutil.rmtree(sock_dir, ignore_errors=True)
except Exception:
    pass
sys.exit(1 if failures else 0)
`;

function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), "tw-attach-"));
  const prefixPath = join(root, "proxy_prefix.py");
  const driverPath = join(root, "driver.py");
  writeFileSync(prefixPath, proxyPrefix(), { mode: 0o600 });
  writeFileSync(driverPath, DRIVER, { mode: 0o700 });
  const result = spawnSync("python3", [driverPath, prefixPath, scenario], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: root },
  });
  if (result.status !== 0) {
    throw new Error(`scenario ${scenario} failed: ${result.stderr || result.stdout}`);
  }
  const lines = result.stdout.trim().split("\n");
  const jsonLine = lines.reverse().find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine);
}

test("attach proxy tolerates transient renewal failures then self-heals", () => {
  assert.deepEqual(runScenario("retry"), { failures: [] });
});

test("attach proxy stays read-only after deterministic ownership denial", () => {
  assert.deepEqual(runScenario("denied"), { failures: [] });
});

test("attach proxy keeps writable through a transient write failure", () => {
  assert.deepEqual(runScenario("input-transient"), { failures: [] });
});
