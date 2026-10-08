"""Adapter pro `reverse-SynthID-text` (aloshdenny), volaný přes subprocess
`python reverse_synthid.py` v samostatném venv (.venv-synthid), protože vyžaduje
torch 2.4 + transformers 4.43 a (pro paraphrase) gated model google/gemma-2b-it.

Vše je statistické/experimentální a anglicky laděné. Detektor je jen referenční
(veřejné ukázkové klíče + GPT-2 tokenizer), ne produkční SynthID.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .. import core, paths

METHODS = ("perturb", "shuffle", "homoglyph", "paraphrase", "combined")


def _available() -> tuple[bool, str]:
    if not (paths.SYNTHID_DIR / "reverse_synthid.py").exists():
        return False, "vendor/reverse-SynthID-text chybí (spusť scripts/setup.sh)"
    if not paths.SYNTHID_VENV_PY.exists():
        return False, "samostatný venv .venv-synthid není nainstalovaný (scripts/setup.sh --with-synthid)"
    return True, ""


def info() -> dict[str, Any]:
    ok, reason = _available()
    base = {
        "available": ok, "license": "Apache-2.0",
        "modes": {"analyze": "statistical (referenční detektor, jen ukázkové klíče)",
                  "statistical": "statistical (perturb/shuffle/homoglyph bez modelu; paraphrase = gemma-2b-it)"},
        "english_only": True,
    }
    if not ok:
        base["reason"] = reason
    return base


def run(text: str, mode: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    ok, reason = _available()
    lim = [core.COMMON_LIMITATIONS["experimental"], core.COMMON_LIMITATIONS["czech_rewrite_risk"],
           core.COMMON_LIMITATIONS["vendor_unverifiable"],
           "Nástroj je anglický: synonyma, výplňová slova i prompt jsou EN; na češtině dělá málo nebo škodí.",
           "Detektor používá veřejné ukázkové klíče SynthID + GPT-2 tokenizer; neříká nic o produkčním Gemini/Claude vodoznaku."]
    if not ok:
        return core.make_report(
            tool="reverse-synthid", mode=mode, kind="statistical", input_text=text, output_text=text,
            findings=[], verification_status="unsupported", verification_note=reason, limitations=lim, elapsed_ms=0,
        )
    method = options.get("method", "perturb")
    if method not in METHODS:
        method = "perturb"
    with tempfile.TemporaryDirectory() as td:
        inp = Path(td) / "in.txt"
        outp = Path(td) / "out.txt"
        inp.write_text(text, encoding="utf-8")
        args = [str(paths.SYNTHID_VENV_PY), "reverse_synthid.py", "--input", str(inp), "--no-viz", "--seed", str(options.get("seed", 42))]
        if mode == "analyze":
            args.append("--detect-only")
        else:
            args += ["--output", str(outp), "--method", method, "--rate", str(options.get("rate", 0.2))]
        with core.Timer() as t:
            try:
                p = subprocess.run(args, capture_output=True, text=True, timeout=int(options.get("timeout", 900)),
                                   cwd=str(paths.SYNTHID_DIR), env=paths.env_offline())
            except subprocess.TimeoutExpired:
                return core.make_report(tool="reverse-synthid", mode=mode, kind="statistical", input_text=text, output_text=text,
                                        findings=[], verification_status="failed", limitations=lim + ["timeout"], elapsed_ms=0)
        log = (p.stdout + "\n" + p.stderr)[-3000:]
        if p.returncode != 0:
            return core.make_report(tool="reverse-synthid", mode=mode, kind="statistical", input_text=text, output_text=text,
                                    findings=[], verification_status="failed", limitations=lim + [f"rc={p.returncode}"],
                                    elapsed_ms=t.ms, raw={"log": log})
        out = outp.read_text(encoding="utf-8") if outp.exists() else text
    findings = []
    import re

    m = re.search(r"Mean G-value:\s*([0-9.]+)", log)
    lw = re.search(r"Likely watermarked:\s*(True|False)", log)
    if m:
        findings.append({"category": "synthid_reference", "label": f"Mean G-value {m.group(1)} (práh 0.55)",
                         "count": 1, "severity": "info", "action": "none",
                         "note": f"likely_watermarked={lw.group(1) if lw else '?'}; jen vůči ukázkovým klíčům."})
    if mode != "analyze":
        findings.append({"category": "attack", "label": f"Metoda {method}", "count": 1, "severity": "medium", "action": "rewrite"})
    return core.make_report(
        tool="reverse-synthid", mode="analyze" if mode == "analyze" else "statistical", kind="statistical",
        input_text=text, output_text=out, findings=findings,
        verification_status="not_applicable" if mode == "analyze" else "mitigation_unverified",
        verification_note="Referenční detektor s veřejnými klíči; výsledek nelze vztáhnout na produkční vodoznak.",
        limitations=lim, elapsed_ms=t.ms, options={"method": method, "rate": options.get("rate", 0.2)}, raw={"log": log},
    )
