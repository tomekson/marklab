// Prohlížečový engine: deterministický Unicode cleanup + česká pravidla + normalizovaný report v1.
// Nic neopouští prohlížeč. Statistická mitigace zde není (jen přes lokální bridge).
import { inspectText, sanitizeTextWithReport } from "../lib/dewatermark-unicode/sanitizer.mjs?v=0.2.1";
import { POLICY_VERSION } from "../lib/dewatermark-unicode/unicode-policy.mjs?v=0.2.1";
import { wordDiff, diffStats } from "./diff.js?v=0.2.1";

export const SCHEMA_VERSION = "1.0";
export const ENGINE_VERSION = "0.1.0";
const NBSP = " ", NNBSP = " ";
const CZ_NBSP_WORDS = new Set("k s v z o u a i K S V Z O U A I".split(" "));

export const LIMITS = {
  unicode_not_statistical: "Unicode cleanup neodstraňuje statistický (token-sampling) vodoznak typu SynthID / KGW.",
  detector_scoped: "Úspěch je vždy vázaný na konkrétní detektor; neexistuje univerzální důkaz odstranění.",
  vendor_unverifiable: "Produkční vodoznak Claude / Gemini nelze prohlásit za odstraněný: kompatibilní nezávislý detektor není veřejně dostupný.",
  czech_rewrite_risk: "U češtiny může přepis zhoršit styl, skloňování nebo posunout význam (čísla, negace, terminologie).",
  experimental: "Statistická mitigace je experimentální a nedeterministická; výsledek se mezi běhy liší.",
  browser_only: "Tento výsledek vznikl v prohlížeči; Python nástroje nebyly spuštěny. Tabulka Unicode rozsahů pochází z projektu dewatermark (" + POLICY_VERSION + "), který je málo ověřený (7★), proto je výchozí přísný profil odpovídající watermarks-remover.",
};

// ---------------------------------------------------------------- HTML entity / tagy
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{1,31});/g;
const ta = typeof document !== "undefined" ? document.createElement("textarea") : null;

export function decodeEntities(text) {
  const counts = {};
  const out = text.replace(ENTITY_RE, (m) => {
    if (!ta) return m;
    ta.innerHTML = m;
    const dec = ta.value;
    if (dec !== m) counts[m] = (counts[m] || 0) + 1;
    return dec;
  });
  return { text: out, counts };
}

export function stripHtml(text) {
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

// ---------------------------------------------------------------- česká typografie
const WORD_SEP_RE = /(\S+)(\s*)/gu;
function isNbspContext(w) { return CZ_NBSP_WORDS.has(w) || /^\d+[.,]?$/.test(w); }

export function czechNbspPairs(original) {
  const toks = [...original.matchAll(WORD_SEP_RE)].map((m) => [m[1], m[2]]);
  const pairs = new Set();
  for (let i = 0; i + 1 < toks.length; i++) {
    const [w, sep] = toks[i];
    if ((sep === NBSP || sep === NNBSP) && isNbspContext(w)) pairs.add(w + "\u0000" + toks[i + 1][0]);
  }
  return pairs;
}

export function restoreCzechNbsp(cleaned, pairs) {
  if (!pairs.size) return { text: cleaned, restored: 0 };
  const toks = [...cleaned.matchAll(WORD_SEP_RE)];
  if (!toks.length) return { text: cleaned, restored: 0 };
  let restored = 0;
  let out = cleaned.slice(0, toks[0].index);
  for (let i = 0; i < toks.length; i++) {
    let [, w, sep] = toks[i];
    const nxt = i + 1 < toks.length ? toks[i + 1][1] : null;
    if (sep === " " && nxt !== null && pairs.has(w + "\u0000" + nxt)) { sep = NBSP; restored++; }
    out += w + sep;
  }
  return { text: out, restored };
}

// ---------------------------------------------------------------- strict sweep (druhá pipeline)
const CF_RE = /\p{Cf}/gu;
const PICTO = /\p{Extended_Pictographic}/u;

/** Přísnější deterministický průchod: odstraní každý zbývající formátovací znak (Cf),
 *  kromě ZWJ uvnitř emoji sekvence. Zhruba odpovídá politice watermarks-remover Layer A. */
export function strictSweep(text) {
  let removed = 0;
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (CF_RE.test(c)) {
      CF_RE.lastIndex = 0;
      const keepZwj = c === "‍" && PICTO.test(chars[i - 1] || "") && PICTO.test(chars[i + 1] || "");
      if (!keepZwj) { removed++; continue; }
    }
    CF_RE.lastIndex = 0;
    out.push(c);
  }
  return { text: out.join(""), removed };
}

// ---------------------------------------------------------------- report
function nowIso() { return new Date().toISOString(); }

export function makeReport(p) {
  const diff = wordDiff(p.input_text, p.output_text);
  const st = diffStats(diff);
  const removed = p.removed_unicode_count ?? p.findings.filter((f) => ["delete", "space", "replace"].includes(f.action)).reduce((a, f) => a + f.count, 0);
  const changes = p.changes_count ?? (p.kind === "deterministic"
    ? p.findings.filter((f) => f.action && !["none", "preserve"].includes(f.action)).reduce((a, f) => a + f.count, 0)
    : st.changedSegments);
  return {
    schema_version: SCHEMA_VERSION,
    tool: p.tool, tool_version: p.tool_version || "", mode: p.mode, kind: p.kind,
    input_text: p.input_text, output_text: p.output_text,
    changes_count: changes, removed_unicode_count: removed,
    rewritten_segments_count: p.rewritten_segments_count ?? (p.kind === "statistical" ? st.changedSegments : 0),
    findings: p.findings, diff,
    verification_status: p.verification_status, verification_note: p.verification_note || "",
    limitations: p.limitations, language: "cs", elapsed_ms: p.elapsed_ms, created_at: nowIso(),
    options: p.options || {},
  };
}

function findingsFromInspect(matches) {
  const by = new Map();
  for (const m of matches) {
    const key = m.codepoint + "|" + m.disposition + "|" + m.context;
    const sev = { actionable: "high", contextual: "medium", informational: "info" }[m.disposition] || "low";
    const action = m.disposition === "informational" ? "preserve" : (m.safeAction === "preserve" ? "preserve" : m.safeAction);
    if (!by.has(key)) by.set(key, { category: m.category, label: `${m.codepoint} ${m.label}`, codepoint: m.codepoint, count: 0, severity: sev, action, positions: [], note: m.context });
    const f = by.get(key); f.count++; if (f.positions.length < 50) f.positions.push(m.index);
  }
  return [...by.values()];
}

function preprocess(text, opts) {
  const findings = [];
  let t = text;
  if (opts.stripHtml) t = stripHtml(t);
  if (opts.decodeEntities !== false) {
    const r = decodeEntities(t); t = r.text;
    for (const [ent, n] of Object.entries(r.counts)) findings.push({ category: "html_entity", label: `HTML entita ${ent}`, count: n, severity: "low", action: "replace", note: "Dekódováno na znak před analýzou." });
  }
  return { text: t, findings };
}

export function analyze(input, opts = {}) {
  const t0 = performance.now();
  const pre = preprocess(input, opts);
  const matches = inspectText(pre.text);
  const findings = [...pre.findings, ...findingsFromInspect(matches)];
  const cz = czechNbspPairs(pre.text).size;
  if (cz) findings.push({ category: "czech_typography", label: "Pevná mezera v českém kontextu (předložka, číslo)", count: cz, severity: "info", action: "preserve", note: "Správná česká typografie, nejde o vodoznak." });
  return makeReport({
    tool: "browser (dewatermark-js tabulka)", tool_version: POLICY_VERSION, mode: "analyze", kind: "deterministic",
    input_text: input, output_text: input, findings, removed_unicode_count: 0, changes_count: 0,
    verification_status: "not_applicable", limitations: [LIMITS.unicode_not_statistical, LIMITS.detector_scoped, LIMITS.browser_only],
    elapsed_ms: +(performance.now() - t0).toFixed(2), options: opts,
  });
}

export function sanitize(input, opts = {}) {
  const t0 = performance.now();
  const pre = preprocess(input, opts);
  const before = inspectText(pre.text);
  const rep = sanitizeTextWithReport(pre.text);
  let out = rep.cleanedText;
  const findings = [...pre.findings, ...findingsFromInspect(before)];
  let strictRemoved = 0;
  if (opts.profile === "strict") {
    const s = strictSweep(out); out = s.text; strictRemoved = s.removed;
    if (strictRemoved) findings.push({ category: "format_char", label: "Zbývající formátovací znaky (Cf) odstraněny přísným průchodem", count: strictRemoved, severity: "medium", action: "delete", note: "Např. Word Joiner U+2060, soft hyphen U+00AD; safe profil je zachovává." });
  }
  let restored = 0;
  if (opts.czechNbsp !== false) {
    const r = restoreCzechNbsp(out, czechNbspPairs(pre.text)); out = r.text; restored = r.restored;
    if (restored) findings.push({ category: "czech_typography", label: "Pevná mezera obnovena (česká typografie)", count: restored, severity: "info", action: "preserve", note: "NBSP za jednopísmennou předložkou nebo v čísle je správně; vrácena zpět." });
  }
  const after = inspectText(out).filter((m) => m.disposition === "actionable");
  const status = after.length === 0 ? "unicode_verified" : "failed";
  const lim = [LIMITS.unicode_not_statistical, LIMITS.detector_scoped, LIMITS.browser_only];
  return makeReport({
    tool: opts.profile === "strict" ? "browser-strict" : "browser-safe (dewatermark-js)", tool_version: POLICY_VERSION, mode: "sanitize", kind: "deterministic",
    input_text: input, output_text: out, findings,
    removed_unicode_count: rep.edits.length + strictRemoved + pre.findings.reduce((a, f) => a + f.count, 0),
    verification_status: status,
    verification_note: after.length === 0 ? "Po očištění inspekce nehlásí žádný actionable znak." : `Po očištění zbývá ${after.length} actionable znaků.`,
    limitations: lim, elapsed_ms: +(performance.now() - t0).toFixed(2), options: { ...opts, policy: POLICY_VERSION },
  });
}

/** Porovnání prohlížečových pipeline (safe vs strict). */
export function compareLocal(input, opts = {}) {
  const t0 = performance.now();
  const pipelines = [
    sanitize(input, { ...opts, profile: "strict" }),
    sanitize(input, { ...opts, profile: "safe" }),
  ];
  const best = pipelines.find((p) => p.verification_status === "unicode_verified") || pipelines[0];
  const rep = makeReport({
    tool: "twl-browser", tool_version: ENGINE_VERSION, mode: "compare", kind: "deterministic",
    input_text: input, output_text: best.output_text,
    findings: pipelines.map((p) => ({ category: "pipeline", label: `${p.tool} / ${p.mode}: ${p.verification_status}`, count: p.changes_count, severity: "info", action: "none" })),
    changes_count: best.changes_count, removed_unicode_count: best.removed_unicode_count,
    verification_status: best.verification_status, verification_note: "output_text = první pipeline se stavem unicode_verified.",
    limitations: [...new Set(pipelines.flatMap((p) => p.limitations))], elapsed_ms: +(performance.now() - t0).toFixed(2), options: opts,
  });
  rep.pipelines = pipelines;
  rep.summary = pipelines.map(summaryRow);
  return rep;
}

export function summaryRow(p) {
  return { tool: p.tool, mode: p.mode, kind: p.kind, changes_count: p.changes_count, removed_unicode_count: p.removed_unicode_count, rewritten_segments_count: p.rewritten_segments_count, verification_status: p.verification_status, elapsed_ms: p.elapsed_ms };
}
