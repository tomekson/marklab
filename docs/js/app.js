import * as engine from "./engine.js";
import * as bridge from "./bridge.js";
import { docxToText } from "./docx.js";

const $ = (s) => document.querySelector(s);
const input = $("#input"), status = $("#status");
let current = null;

// ---------------------------------------------------------------- theme
$("#theme-toggle").addEventListener("click", () => {
  const d = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = d;
  try { localStorage.setItem("marklab-theme", d); } catch (_) { /* soukromý režim */ }
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = d === "dark" ? "#0F1115" : "#F4F5F7";
});

// ---------------------------------------------------------------- rentgen (živý náhled skrytých znaků)
const NAMES = { "​": "ZWSP", "‌": "ZWNJ", "‍": "ZWJ", "⁠": "WJ", "﻿": "BOM", "­": "SHY", "‎": "LRM", "‏": "RLM", "⁡": "FA", "⁢": "IT", "⁣": "IS", "⁤": "IP", "᠎": "MVS", "͏": "CGJ" };
const SPACES = { " ": "NBSP", " ": "NNBSP", " ": "THIN", " ": "HAIR", " ": "EN", " ": "EM", " ": "3/M", " ": "4/M", " ": "6/M", " ": "FIG", " ": "PUNC", " ": "MMSP", "　": "IDSP", " ": "OGH" };
const HIDDEN_RE = /[\p{Cf}   -  　 ]/gu;

function reveal(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (NAMES[ch]) out += `<span class="inv">${NAMES[ch]}</span>`;
    else if (SPACES[ch]) out += `<span class="inv sp">${SPACES[ch]}</span>`;
    else if (cp >= 0xe0000 && cp <= 0xe007f) out += `<span class="inv">TAG ${cp === 0xe007f ? "END" : String.fromCodePoint(cp - 0xe0000)}</span>`;
    else if (cp >= 0xfe00 && cp <= 0xfe0f) out += `<span class="inv">VS${cp - 0xfe00 + 1}</span>`;
    else if ((cp >= 0x2066 && cp <= 0x2069) || (cp >= 0x202a && cp <= 0x202e)) out += `<span class="inv">BIDI U+${cp.toString(16).toUpperCase()}</span>`;
    else if (/\p{Cf}/u.test(ch)) out += `<span class="inv">U+${cp.toString(16).toUpperCase().padStart(4, "0")}</span>`;
    else if (ch === " ") out += `<span class="sp-mark">·</span>`;
    else out += esc(ch);
  }
  return out;
}

function updateXray() {
  const t = input.value;
  const n = Array.from(t).length;
  const hidden = (t.match(HIDDEN_RE) || []).length;
  const ent = (t.match(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{1,31});/g) || []).length;
  $("#xray-count").innerHTML = n === 0 ? "0 znaků" : `${n.toLocaleString("cs")} znaků · <b>${hidden}</b> skrytých${ent ? ` · ${ent} HTML entit` : ""}`;
  $("#xray-view").innerHTML = t.length > 20000 ? `<span class="empty">Text je delší než 20 000 znaků, živý náhled je vypnutý.</span>` : reveal(t);
}
function setText(t) { input.value = t; updateXray(); }
input.addEventListener("input", updateXray);
$("#btn-clear").addEventListener("click", () => { setText(""); $("#results").hidden = true; say(""); });

// ---------------------------------------------------------------- soubory a ukázky
async function loadFile(file) {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".docx")) { setText(await docxToText(await file.arrayBuffer())); say(`Načteno z .docx: ${file.name}`); }
    else {
      const t = await file.text();
      if (name.endsWith(".html") || name.endsWith(".htm") || file.type === "text/html") $("#opt-strip").checked = true;
      setText(t); say(`Načteno: ${file.name}`);
    }
  } catch (e) { say("Soubor se nepodařilo načíst: " + e.message, true); }
}
$("#file").addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
const bench = $("#bench");
["dragenter", "dragover"].forEach((ev) => bench.addEventListener(ev, (e) => { e.preventDefault(); bench.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => bench.addEventListener(ev, (e) => { e.preventDefault(); bench.classList.remove("over"); }));
bench.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

const SAMPLES = ["01-bezny-odstavec", "02-zero-width", "03-html-entity", "04-smisena-interpunkce", "05-odborny-text"];
const sel = $("#sample-select");
for (const s of SAMPLES) { const o = document.createElement("option"); o.value = s; o.textContent = s.slice(3).replace(/-/g, " "); sel.append(o); }
sel.addEventListener("change", async () => {
  if (!sel.value) return;
  try { const rep = await (await fetch(`demo/${sel.value}.compare.json`)).json(); setText(rep.input_text); say("Ukázka načtena."); }
  catch (e) { say("Ukázku se nepodařilo načíst: " + e.message, true); }
});

// ---------------------------------------------------------------- volby a bridge
function opts() {
  const cz = $("#opt-czech").checked, ent = $("#opt-entities").checked, strip = $("#opt-strip").checked;
  return { czechNbsp: cz, czech_nbsp: cz, decodeEntities: ent, decode_entities: ent, stripHtml: strip, strip_html: strip,
    profile: $("#opt-strict").checked ? "strict" : "safe", tactic: $("#opt-tactic").value, method: "perturb" };
}
const engineName = () => document.querySelector('input[name="engine"]:checked').value;

async function initBridge() {
  const pill = $("#bridge-pill");
  const h = await bridge.detect();
  if (!h) { pill.textContent = "bridge —"; pill.className = "pill pill-off"; pill.title = "Lokální bridge neběží. Prohlížečový režim funguje bez něj; Python nástroje a přepis modelem vyžadují scripts/run-local.sh."; $("#act-stat").disabled = true; return; }
  const tools = await bridge.capabilities();
  pill.textContent = "bridge " + h.version; pill.className = "pill pill-ok";
  pill.title = Object.entries(tools).map(([k, v]) => `${k}: ${v.available ? "ok" : "chybí (" + v.reason + ")"}`).join("\n");
  for (const [k, v] of Object.entries(tools)) { const r = document.querySelector(`input[name="engine"][value="${k}"]`); if (r) { r.disabled = !v.available; r.title = v.available ? "" : v.reason || ""; } }
  $("#act-stat").disabled = false;
}

// ---------------------------------------------------------------- akce
function say(msg, err = false) { status.textContent = msg; status.className = "status" + (err ? " err" : ""); }
document.querySelectorAll(".actions button[data-mode]").forEach((b) => b.addEventListener("click", () => runMode(b.dataset.mode)));

async function runMode(mode) {
  const text = input.value;
  if (!text.trim()) { say("Nejdřív vložte text.", true); input.focus(); return; }
  const o = opts(), eng = engineName();
  const btns = document.querySelectorAll(".actions button"); btns.forEach((b) => (b.disabled = true));
  say("Pracuji…");
  try {
    let rep;
    if (mode === "statistical") {
      if (!bridge.available()) throw new Error("Přepis modelem potřebuje lokální bridge (scripts/run-local.sh).");
      rep = await bridge.run(text, "statistical", eng === "browser" ? "watermarks-remover" : eng, o);
    } else if (mode === "compare") {
      const loc = engine.compareLocal(text, o);
      if (bridge.available()) { rep = await bridge.compare(text, o, true); rep.pipelines = [...loc.pipelines, ...rep.pipelines]; rep.summary = rep.pipelines.map(engine.summaryRow); }
      else rep = loc;
    } else if (eng === "browser" || !bridge.available()) {
      rep = mode === "analyze" ? engine.analyze(text, o) : engine.sanitize(text, o);
    } else rep = await bridge.run(text, mode, eng, o);
    current = rep;
    render(rep);
    say(feedback(rep));
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { say("Chyba: " + e.message, true); }
  finally { btns.forEach((b) => (b.disabled = false)); $("#act-stat").disabled = !bridge.available(); }
}

function feedback(rep) {
  const t = `${rep.tool}, ${rep.elapsed_ms} ms`;
  if (rep.mode === "analyze") return rep.findings.length ? `Analýza hotová: ${rep.findings.length} druhů nálezů (${t}).` : `Analýza hotová: nic skrytého (${t}).`;
  if (rep.mode === "compare") return `Porovnáno ${rep.pipelines.length} pipeline (${t}).`;
  if (rep.mode === "statistical") return rep.verification_status === "unsupported" ? `Přepis neproběhl, viz výsledek (${t}).` : `Přepsáno, neověřeno (${t}).`;
  return rep.changes_count === 0 ? `Nebylo co odstranit, text je beze změny (${t}).` : `Odstraněno ${rep.changes_count} znaků (${t}).`;
}

// ---------------------------------------------------------------- render
const VERDICT = {
  unicode_verified: ["ok", "Očištěno a ověřeno", "Po očištění stejná inspekce nehlásí žádný skrytý znak. O statistickém vodoznaku to nic neříká."],
  not_applicable: ["info", "Jen analýza, text beze změny", "Tabulka nálezů ukazuje, co by očištění odstranilo."],
  mitigation_unverified: ["warn", "Přepsáno, neověřeno", "Model text změnil, ale žádný kompatibilní nezávislý detektor nepotvrdil, že vodoznak zmizel."],
  mitigation_verified: ["ok", "Přepis ověřen detektorem", "Pojmenovaný detektor byl pozitivní před a čistý po přepisu. Platí jen pro ten detektor."],
  unsupported: ["warn", "Nepodporováno v této konfiguraci", "Nástroj text nepřepsal: chybí lokální model, backend nebo kompatibilní detektor. Vrácen původní text."],
  failed: ["bad", "Selhalo", "Operace skončila chybou nebo po očištění zbývají skryté znaky."],
};

function render(rep) {
  $("#results").hidden = false;
  $("#result-title").textContent = `Výsledek · ${rep.tool} · ${rep.mode}`;
  const det = rep.kind === "deterministic";
  const [cls, title, desc] = VERDICT[rep.verification_status] || ["info", rep.verification_status, ""];
  if (rep.mode === "sanitize" && rep.changes_count === 0 && cls === "ok") {
    $("#verify-box").className = "verdict info";
    $("#verify-box").innerHTML = `<div class="k"><b>Nebylo co odstranit</b><span class="eyebrow">${det ? "deterministické" : "experimentální"}</span></div><p>Text neobsahuje žádný skrytý Unicode znak podle použité politiky. Výstup je totožný se vstupem.</p>`;
  } else {
    $("#verify-box").className = "verdict " + cls;
    $("#verify-box").innerHTML = `<div class="k"><b>${esc(title)}</b><span class="eyebrow">${det ? "deterministické" : "experimentální"}</span></div><p>${esc(desc)}${rep.verification_note ? " " + esc(rep.verification_note) : ""}</p>`;
  }
  $("#summary-cards").innerHTML = [
    [rep.changes_count, "změn celkem", rep.changes_count ? "uv" : ""],
    [rep.removed_unicode_count, "skrytých znaků a entit", ""],
    [rep.rewritten_segments_count, det ? "přepsaných segmentů (0 u cleanupu)" : "přepsaných segmentů", ""],
    [rep.elapsed_ms, "ms", ""],
  ].map(([v, l, c]) => `<div><div class="v ${c}">${v}</div><div class="l">${l}</div></div>`).join("");

  const tb = $("#findings"); tb.innerHTML = "";
  $("#findings-count").textContent = rep.findings.length ? `${rep.findings.length} druhů` : "";
  if (!rep.findings.length) tb.innerHTML = `<tr><td colspan="5" class="empty">Žádné nálezy.</td></tr>`;
  for (const f of rep.findings) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="cp">${esc(f.codepoint || "–")}</td><td>${esc(f.label.replace(/^U\+[0-9A-F]+\s*/i, ""))}${f.note ? `<span class="note">${esc(f.note)}</span>` : ""}</td><td class="num">${f.count}</td><td class="mono">${esc(f.action || "")}</td><td><span class="sev sev-${f.severity}">${esc(f.severity)}</span></td>`;
    tb.append(tr);
  }
  $("#limits").innerHTML = rep.limitations.map((l) => `<li>${esc(l)}</li>`).join("") || `<li class="empty">–</li>`;
  renderDiff(rep);

  const cp = $("#compare-panel");
  if (rep.pipelines) {
    cp.hidden = false;
    const body = $("#compare-table tbody"); body.innerHTML = "";
    rep.pipelines.forEach((p, i) => {
      const k = p.kind === "deterministic";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(p.tool)}</td><td class="mono">${esc(p.mode)}</td><td><span class="sev ${k ? "kind-det" : "kind-exp"}">${k ? "det" : "exp"}</span></td><td class="num">${p.changes_count}</td><td class="num">${p.removed_unicode_count}</td><td class="num">${p.rewritten_segments_count}</td><td class="mono">${esc(p.verification_status)}</td><td class="num">${p.elapsed_ms}</td><td><button class="linkbtn" type="button" data-i="${i}">zobrazit</button></td>`;
      body.append(tr);
    });
    body.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const p = rep.pipelines[+b.dataset.i];
      current = { ...p, pipelines: rep.pipelines }; render(current);
      body.querySelectorAll("tr").forEach((r, j) => r.classList.toggle("active", j === +b.dataset.i));
    }));
  } else cp.hidden = true;
}

function renderDiff(rep) {
  const inl = $("#diff-inline");
  if (!rep.diff.some((d) => d.op !== "equal")) inl.innerHTML = `<span class="empty">Beze změny.</span>`;
  else inl.innerHTML = rep.diff.map((d) => d.op === "equal" ? esc(d.text) : d.op === "delete" ? `<del>${reveal(d.text)}</del>` : `<ins>${reveal(d.text)}</ins>`).join("");
  $("#side-in").innerHTML = reveal(rep.input_text);
  $("#side-out").innerHTML = reveal(rep.output_text);
}
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  for (const v of ["inline", "side"]) $(`#diff-${v}`).hidden = v !== b.dataset.view;
}));

// ---------------------------------------------------------------- export
function download(name, content, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
$("#dl-txt").addEventListener("click", () => current && download(`marklab-${current.mode}-${stamp()}.txt`, current.output_text, "text/plain;charset=utf-8"));
$("#dl-json").addEventListener("click", () => current && download(`marklab-${current.mode}-${stamp()}.json`, JSON.stringify(current, null, 1), "application/json"));
$("#copy-out").addEventListener("click", async (e) => {
  if (!current) return;
  try { await navigator.clipboard.writeText(current.output_text); e.target.textContent = "Zkopírováno"; setTimeout(() => (e.target.textContent = "Kopírovat očištěný text"), 1200); }
  catch (_) { say("Kopírování selhalo.", true); }
});

// ---------------------------------------------------------------- ukázky
async function initDemo() {
  const box = $("#demo-list");
  try {
    const idx = await (await fetch("demo/index.json")).json();
    for (const s of idx.samples) {
      const b = document.createElement("button"); b.type = "button"; b.className = "demo-card";
      const det = s.pipelines.find((p) => p.kind === "deterministic");
      b.innerHTML = `<b>${esc(s.title)}</b><span>${s.chars} znaků</span><span class="${det?.changes_count ? "uv" : ""}">${det?.changes_count ?? 0} skrytých</span>`;
      b.addEventListener("click", async () => {
        const rep = await (await fetch(`demo/${s.file}`)).json();
        setText(rep.input_text); current = rep; render(rep);
        say(`Načten ukázkový report (${new Date(rep.created_at).toLocaleString("cs")}).`);
        $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      box.append(b);
    }
  } catch (_) { box.innerHTML = `<span class="empty" style="padding:12px 14px;display:block">Ukázky nejsou k dispozici.</span>`; }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

initBridge(); initDemo(); updateXray();
