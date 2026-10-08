// Klient lokálního bridge (tools/twl/bridge.py). Když dashboard běží z bridge
// (stejná origin), používá relativní /api. Jinak zkusí http://127.0.0.1:8777.
const CANDIDATES = [location.origin, "http://127.0.0.1:8777"];
let base = null;

export async function detect() {
  for (const b of CANDIDATES) {
    try {
      const r = await fetch(b + "/api/health", { signal: AbortSignal.timeout(1500) });
      if (r.ok) { base = b; return (await r.json()); }
    } catch (_) { /* další kandidát */ }
  }
  base = null;
  return null;
}

export function available() { return base !== null; }
export function baseUrl() { return base; }

export async function capabilities() {
  const r = await fetch(base + "/api/capabilities");
  return (await r.json()).tools;
}

export async function run(text, mode, tool, options = {}) {
  const r = await fetch(base + "/api/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode, tool, options }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "bridge error");
  return j.report;
}

export async function compare(text, options = {}, statistical = true) {
  const r = await fetch(base + "/api/compare", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, options, statistical }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "bridge error");
  return j.report;
}
