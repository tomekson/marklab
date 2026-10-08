import * as engine from "./engine.js";
import * as bridge from "./bridge.js";
import { docxToText } from "./docx.js";

const $ = (s) => document.querySelector(s);
const input = $("#input"), status = $("#status");
let current = null;         // poslední report
let bridgeTools = null;     // capabilities z bridge

// ---------------------------------------------------------------- theme
$("#theme-toggle").addEventListener("click", () => {
  const d = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = d;
  try { localStorage.setItem("twl-theme", d); } catch (_) { /* soukromý režim */ }
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = d === "dark" ? "#141A1E" : "#F2EFE6";
});

// ---------------------------------------------------------------- input
function setText(t) { input.value = t; updateMeta(); }
function updateMeta() {
  const n = Array.from(input.value).length;
  const inv = (input.value.match(/\p{Cf}/gu) || []).length;
  $("#input-meta").textContent = `${n.toLocaleString("cs")} znaků` + (inv ? ` · ${inv} formátovacích (Cf) znaků` : "");
}
input.addEventListener("input", updateMeta);
$("#btn-clear").addEventListener("click", () => { setText(""); hideResults(); });

async function loadFile(file) {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".docx")) {
      setText(await docxToText(await file.arrayBuffer()));
      say(`Načteno z .docx: ${file.name}`);
    } else {
      const t = await file.text();
      if (name.endsWith(".html") || name.endsWith(".htm") || file.type === "text/html") $("#opt-strip").checked = true;
      setText(t);
      say(`Načteno: ${file.name}`);
    }
  } catch (e) { say("Soubor se nepodařilo načíst: " + e.message, true); }
}
$("#file").addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

// ukázky
const SAMPLES = ["01-bezny-odstavec", "02-zero-width", "03-html-entity", "04-smisena-interpunkce", "05-odborny-text"];
const sel = $("#sample-select");
for (const s of SAMPLES) { const o = document.createElement("option"); o.value = s; o.textContent = s.slice(3).replace(/-/g, " "); sel.append(o); }
sel.addEventListener("change", async () => {
  if (!sel.value) return;
  try {
    const r = await fetch(`demo/${sel.value}.compare.json`);
    const rep = await r.json();
    setText(rep.input_text);
    say("Ukázka načtena. Spusťte Analyzovat nebo Očistit Unicode.");
  } catch (e) { say("Ukázku se nepodařilo načíst: " + e.message, true); }
});

// ---------------------------------------------------------------- options
function opts() {
  return {
    czechNbsp: $("#opt-czech").checked, czech_nbsp: $("#opt-czech").checked,
    decodeEntities: $("#opt-entities").checked, decode_entities: $("#opt-entities").checked,
    stripHtml: $("#opt-strip").checked, strip_html: $("#opt-strip").checked,
    profile: $("#opt-strict").checked ? "strict" : "safe",
    tactic: $("#opt-tactic").value, method: "perturb",
  };
}
function engineName() { return document.querySelector('input[name="engine"]:checked').value; }

// ---------------------------------------------------------------- bridge
async function initBridge() {
  const pill = $("#bridge-pill");
  const h = await bridge.detect();
  if (!h) {
    pill.textContent = "bridge: nepřipojen (jen prohlížeč)"; pill.className = "pill pill-off";
    $("#act-stat").disabled = true;
    return;
  }
  bridgeTools = await bridge.capabilities();
  pill.textContent = "bridge: připojen · " + h.version; pill.className = "pill pill-ok";
  pill.title = Object.entries(bridgeTools).map(([k, v]) => `${k}: ${v.available ? "ok" : "chybí (" + v.reason + ")"}`).join("\n");
  for (const [k, v] of Object.entries(bridgeTools)) {
    const r = document.querySelector(`input[name="engine"][value="${k}"]`);
    if (r) { r.disabled = !v.available; r.title = v.available ? "" : v.reason || ""; }
  }
  $("#act-stat").disabled = false;
}

// ---------------------------------------------------------------- actions
function say(msg, err = false) { status.textContent = msg; status.className = "status" + (err ? " err" : ""); }
function hideResults() { $("#results").hidden = true; }

document.querySelectorAll(".actions button").forEach((b) => b.addEventListener("click", () => runMode(b.dataset.mode)));

async function runMode(mode) {
  const text = input.value;
  if (!text.trim()) { say("Nejdřív vložte text.", true); return; }
  const o = opts(), eng = engineName();
  const btns = document.querySelectorAll(".actions button"); btns.forEach((b) => (b.disabled = true));
  say("Pracuji…");
  try {
    let rep;
    if (mode === "statistical") {
      if (!bridge.available()) throw new Error("Statistická mitigace vyžaduje lokální bridge (scripts/run-local.sh).");
      const tool = eng === "browser" ? "watermarks-remover" : eng;
      rep = await bridge.run(text, "statistical", tool, o);
    } else if (mode === "compare") {
      rep = bridge.available() ? await bridge.compare(text, o, true) : engine.compareLocal(text, o);
      if (bridge.available()) { // přidej i prohlížečové pipeline pro úplnost
        const loc = engine.compareLocal(text, o);
        rep.pipelines = [...loc.pipelines, ...rep.pipelines];
        rep.summary = rep.pipelines.map(engine.summaryRow);
      }
    } else if (eng === "browser" || !bridge.available()) {
      rep = mode === "analyze" ? engine.analyze(text, o) : engine.sanitize(text, o);
    } else {
      rep = await bridge.run(text, mode, eng, o);
    }
    current = rep;
    render(rep);
    say(`Hotovo za ${rep.elapsed_ms} ms (${rep.tool}).`);
  } catch (e) {
    say("Chyba: " + e.message, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
    $("#act-stat").disabled = !bridge.available();
  }
}

// ---------------------------------------------------------------- render
const STATUS_TXT = {
  unicode_verified: ["ok", "Unicode ověřeno", "Po očištění inspekce stejnou politikou nehlásí žádný actionable znak. Neříká nic o statistickém vodoznaku."],
  not_applicable: ["info", "Jen analýza", "Text nebyl změněn. Nálezy níže ukazují, co by očištění udělalo."],
  mitigation_unverified: ["warn", "Přepsáno, neověřeno", "Text byl změněn modelem, ale žádný kompatibilní nezávislý detektor nepotvrdil, že vodoznak zmizel."],
  mitigation_verified: ["ok", "Mitigace ověřena detektorem", "Pojmenovaný detektor byl pozitivní před a čistý po přepisu. Platí jen pro ten detektor."],
  unsupported: ["warn", "Nepodporováno v této konfiguraci", "Nástroj text nepřepsal: chybí lokální model, backend nebo kompatibilní detektor. Vstup byl vrácen beze změny."],
  failed: ["bad", "Selhalo", "Operace skončila chybou nebo po očištění zbývají actionable znaky."],
};

function render(rep) {
  $("#results").hidden = false;
  $("#result-title").textContent = `Výsledek · ${rep.tool} · ${rep.mode}`;
  const det = rep.kind === "deterministic";
  const cards = [
    ["Změn celkem", rep.changes_count, det ? "deterministické" : "segmentů přepisu", rep.changes_count ? "" : "ok"],
    ["Odstraněné Unicode", rep.removed_unicode_count, "znaků / entit", ""],
    ["Přepsané segmenty", rep.rewritten_segments_count, det ? "0 u cleanupu" : "statistický přepis", rep.rewritten_segments_count ? "warn" : ""],
    ["Typ", det ? "DET" : "EXP", det ? "deterministický" : "experimentální", det ? "ok" : "warn"],
    ["Čas", rep.elapsed_ms, "ms", ""],
  ];
  $("#summary-cards").innerHTML = cards.map(([k, v, s, c]) => `<div class="stat ${c}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");

  const [cls, title, desc] = STATUS_TXT[rep.verification_status] || ["info", rep.verification_status, ""];
  $("#verify-box").className = "verify " + cls;
  $("#verify-box").innerHTML = `<div><strong>${esc(title)}</strong><span>${esc(desc)}${rep.verification_note ? " " + esc(rep.verification_note) : ""}</span></div>`;

  const fl = $("#findings"); fl.innerHTML = "";
  $("#findings-count").textContent = rep.findings.length;
  if (!rep.findings.length) fl.innerHTML = `<li class="empty">Žádné nálezy.</li>`;
  for (const f of rep.findings) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="sev sev-${f.severity}">${esc(f.severity)}</span><span class="lbl">${esc(f.label)}${f.note ? `<small>${esc(f.note)}</small>` : ""}</span><span><span class="n">${f.count}×</span> <span class="act">${esc(f.action || "")}</span></span>`;
    fl.append(li);
  }
  $("#limits").innerHTML = rep.limitations.map((l) => `<li>${esc(l)}</li>`).join("") || `<li class="empty">—</li>`;

  renderDiff(rep);

  const cp = $("#compare-panel");
  if (rep.pipelines) {
    cp.hidden = false;
    const tb = $("#compare-table tbody"); tb.innerHTML = "";
    rep.pipelines.forEach((p, i) => {
      const tr = document.createElement("tr");
      const k = p.kind === "deterministic";
      tr.innerHTML = `<td>${esc(p.tool)}</td><td>${esc(p.mode)}</td><td><span class="kind ${k ? "tag-det" : "tag-exp"}">${k ? "det" : "exp"}</span></td><td class="num">${p.changes_count}</td><td class="num">${p.removed_unicode_count}</td><td class="num">${p.rewritten_segments_count}</td><td>${esc(p.verification_status)}</td><td class="num">${p.elapsed_ms}</td><td><button class="btn-sec btn-sm" type="button" data-i="${i}">Zobrazit</button></td>`;
      tb.append(tr);
    });
    tb.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const p = rep.pipelines[+b.dataset.i];
      const merged = { ...p, pipelines: rep.pipelines };
      current = merged; render(merged);
      tb.querySelectorAll("tr").forEach((r, j) => r.classList.toggle("active", j === +b.dataset.i));
      window.scrollTo({ top: $("#results").offsetTop - 70, behavior: "smooth" });
    }));
  } else cp.hidden = true;
}

const NAMES = { "​": "ZWSP", "‌": "ZWNJ", "‍": "ZWJ", "⁠": "WJ", "﻿": "BOM", "­": "SHY", "‎": "LRM", "‏": "RLM", "⁡": "FA", "⁢": "IT", "⁣": "IS", "⁤": "IP", "᠎": "MVS", "͏": "CGJ" };
const SPACES = { " ": "NBSP", " ": "NNBSP", " ": "THIN", " ": "HAIR", " ": "EN", " ": "EM", " ": "3/M", " ": "4/M", " ": "6/M", " ": "FIG", " ": "PUNC", " ": "MMSP", "　": "IDSP", " ": "OGH" };
function reveal(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (NAMES[ch]) out += `<span class="inv">${NAMES[ch]}</span>`;
    else if (SPACES[ch]) out += `<span class="inv sp">${SPACES[ch]}</span>`;
    else if (cp >= 0xe0000 && cp <= 0xe007f) out += `<span class="inv">TAG ${cp === 0xe007f ? "END" : String.fromCodePoint(cp - 0xe0000)}</span>`;
    else if (cp >= 0xfe00 && cp <= 0xfe0f) out += `<span class="inv">VS${cp - 0xfe00 + 1}</span>`;
    else if (cp >= 0x2066 && cp <= 0x2069 || cp >= 0x202a && cp <= 0x202e) out += `<span class="inv">BIDI U+${cp.toString(16).toUpperCase()}</span>`;
    else if (/\p{Cf}/u.test(ch)) out += `<span class="inv">U+${cp.toString(16).toUpperCase().padStart(4, "0")}</span>`;
    else if (ch === " ") out += `<span class="sp-mark">·</span>`;
    else out += esc(ch);
  }
  return out;
}

function renderDiff(rep) {
  const inl = $("#diff-inline");
  if (!rep.diff.some((d) => d.op !== "equal")) inl.innerHTML = `<span class="empty">Beze změny.</span>` + (rep.mode === "analyze" ? "" : "");
  else inl.innerHTML = rep.diff.map((d) => d.op === "equal" ? esc(d.text) : d.op === "delete" ? `<del>${reveal(d.text)}</del>` : `<ins>${reveal(d.text)}</ins>`).join("");
  $("#side-in").innerHTML = reveal(rep.input_text);
  $("#side-out").innerHTML = reveal(rep.output_text);
  $("#reveal-pre").innerHTML = reveal(rep.mode === "analyze" ? rep.input_text : rep.output_text);
}
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  for (const v of ["inline", "side", "reveal"]) $(`#diff-${v}`).hidden = v !== b.dataset.view;
}));

// ---------------------------------------------------------------- export
function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
$("#dl-txt").addEventListener("click", () => current && download(`vodoznak-lab-${current.mode}-${stamp()}.txt`, current.output_text, "text/plain;charset=utf-8"));
$("#dl-json").addEventListener("click", () => current && download(`vodoznak-lab-${current.mode}-${stamp()}.json`, JSON.stringify(current, null, 1), "application/json"));
$("#copy-out").addEventListener("click", async (e) => {
  if (!current) return;
  try { await navigator.clipboard.writeText(current.output_text); e.target.textContent = "Zkopírováno"; setTimeout(() => (e.target.textContent = "Kopírovat výstup"), 1200); }
  catch (_) { say("Kopírování selhalo.", true); }
});

// ---------------------------------------------------------------- demo
async function initDemo() {
  const box = $("#demo-list");
  try {
    const idx = await (await fetch("demo/index.json")).json();
    for (const s of idx.samples) {
      const b = document.createElement("button"); b.type = "button"; b.className = "demo-card";
      const det = s.pipelines.filter((p) => p.kind === "deterministic");
      b.innerHTML = `<b>${esc(s.title)}</b><span class="meta">${s.chars} znaků · ${s.pipelines.length} pipeline</span><div class="row">${det.map((p) => `<span class="mini">${esc(p.tool.replace("watermarks-remover", "wm-remover"))}: ${p.changes_count}</span>`).join("")}</div>`;
      b.addEventListener("click", async () => {
        const rep = await (await fetch(`demo/${s.file}`)).json();
        setText(rep.input_text); current = rep; render(rep);
        say(`Načten ukázkový report (${new Date(rep.created_at).toLocaleString("cs")}).`);
        window.scrollTo({ top: $("#results").offsetTop - 70, behavior: "smooth" });
      });
      box.append(b);
    }
  } catch (_) { box.innerHTML = `<span class="empty">Ukázky nejsou k dispozici (spusťte scripts/export-demo-results.sh).</span>`; }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

initBridge(); initDemo(); updateMeta();
