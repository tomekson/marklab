"""Adapter pro `watermarks-remover` (guillaumemeyer), volaný přes subprocess
na skripty v service/scripts (stdlib-only, Python 3.10+).

Deterministické (Layer A): inspect_text.py --json [--stylometry], clean_text.py --stats.
Statistické (Layer B): rewrite_text.py; backend print-prompt (vždy, offline, vrací jen prompt),
ollama / openai-compatible (jen když je lokálně nakonfigurované).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

from .. import core, paths

CLEAN = paths.WMR_SCRIPTS / "clean_text.py"
INSPECT = paths.WMR_SCRIPTS / "inspect_text.py"
REWRITE = paths.WMR_SCRIPTS / "rewrite_text.py"


def _run(script, args: list[str], stdin: str, timeout: int = 120) -> tuple[int, str, str]:
    p = subprocess.run(
        [paths.python(), "-I", str(script), *args], input=stdin, capture_output=True, text=True,
        timeout=timeout, env=paths.env_offline(), cwd=str(paths.WMR_SCRIPTS),
    )
    return p.returncode, p.stdout, p.stderr


def info() -> dict[str, Any]:
    ok = CLEAN.exists() and INSPECT.exists()
    if not ok:
        return {"available": False, "reason": "vendor/watermarks-remover chybí (spusť scripts/setup.sh)"}
    if sys.version_info < (3, 10) and not paths.VENV_PY.exists():
        return {"available": False, "reason": "vyžaduje Python 3.10+"}
    backend = os.environ.get("WATERMARKS_REWRITE_BACKEND", "print-prompt")
    return {
        "available": True,
        "version": "git " + _git_rev(),
        "license": "MIT",
        "modes": {
            "analyze": "deterministic (Layer A inspect + volitelná stylometrie, bez LLM)",
            "sanitize": "deterministic (Layer A clean)",
            "statistical": f"statistical (Layer B rewrite_text, backend={backend})",
        },
        "rewrite_backend": backend,
    }


def _git_rev() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=paths.VENDOR / "watermarks-remover",
                              capture_output=True, text=True, timeout=5).stdout.strip() or "?"
    except Exception:  # noqa: BLE001
        return "?"


def _findings_from_inspect(rep: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    sev_map = {"certain": "high", "probable": "high", "possible": "medium", "info": "info"}
    for h in rep.get("hits", []):
        kind = h.get("kind", "")
        action = "space" if "space" in kind else "delete"
        out.append({
            "category": kind, "label": h.get("label", h.get("codepoint", "")), "codepoint": h.get("codepoint"),
            "count": h.get("count", 0), "severity": sev_map.get(h.get("confidence", ""), "medium"),
            "action": action, "positions": h.get("sample_offsets", []), "note": h.get("confidence", ""),
        })
    return out


def run(text: str, mode: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    version = "git " + _git_rev()
    preserve_cz = bool(options.get("czech_nbsp", True))
    lim = [core.COMMON_LIMITATIONS["unicode_not_statistical"], core.COMMON_LIMITATIONS["detector_scoped"]]

    if mode == "analyze":
        args = ["-", "--json"]
        if options.get("stylometry", True):
            args.append("--stylometry")
        with core.Timer() as t:
            rc, out, err = _run(INSPECT, args, text)
        try:
            rep = json.loads(out)
        except json.JSONDecodeError:
            return core.error_report("watermarks-remover", mode, text, f"inspect_text selhal (rc={rc}): {err[-400:]}")
        findings = _findings_from_inspect(rep)
        sty = rep.get("stylometry")
        if sty:
            findings.append({
                "category": "stylometry", "label": f"Stylometrie: {sty.get('confidence_level')} (score {sty.get('score')})",
                "count": 1, "severity": "info", "action": "none",
                "note": "Heuristika bez LLM, kalibrovaná na angličtinu; u češtiny jen orientační.",
            })
        return core.make_report(
            tool="watermarks-remover", mode="analyze", kind="deterministic", tool_version=version,
            input_text=text, output_text=text, findings=findings, verification_status="not_applicable",
            limitations=lim + ["Stylometrické skóre je anglická heuristika, pro češtinu nekalibrované."],
            elapsed_ms=t.ms, removed_unicode_count=0, raw=rep,
        )

    if mode == "sanitize":
        args = ["-", "--stats"]
        if options.get("nfkc"):
            args.append("--nfkc")
        if options.get("aggressive_homoglyphs"):
            args.append("--aggressive-homoglyphs")
        if options.get("normalize_spaces") is False:
            args.append("--no-normalize-spaces")
        with core.Timer() as t:
            rc0, insp, _ = _run(INSPECT, ["-", "--json"], text)
            rc, out, err = _run(CLEAN, args, text)
        if rc != 0:
            return core.error_report("watermarks-remover", mode, text, f"clean_text selhal: {err[-400:]}")
        # --stats píše JSON na stderr, čistý text na stdout
        stats: dict[str, Any] = {}
        try:
            stats = json.loads(err.strip().split("\n{", 1)[-1].join(["{", ""]) if not err.strip().startswith("{") else err)
        except Exception:  # noqa: BLE001
            stats = {"_stderr": err[-400:]}
        cleaned = out
        restored = 0
        if preserve_cz:
            cleaned, restored = core.restore_czech_nbsp(cleaned, core.czech_nbsp_pairs(text))
        try:
            findings = _findings_from_inspect(json.loads(insp))
        except Exception:  # noqa: BLE001
            findings = []
        for label, n in (stats.get("replaced") or {}).items():
            if not any(f["label"] == label for f in findings):
                findings.append({"category": "space_homoglyph", "label": label, "count": n, "severity": "low", "action": "space"})
        if restored:
            findings.append({
                "category": "czech_typography", "label": "Pevná mezera obnovena (česká typografie)",
                "count": restored, "severity": "info", "action": "preserve",
                "note": "NBSP za jednopísmennou předložkou nebo v čísle je správně; vrácena zpět.",
            })
        with core.Timer():
            _, after, _ = _run(INSPECT, ["-", "--json"], cleaned)
        try:
            residual = json.loads(after).get("suspicious_total", 0)
        except Exception:  # noqa: BLE001
            residual = -1
        residual_eff = max(0, residual - restored)  # obnovené NBSP inspect opět nahlásí, to je záměr
        status = "unicode_verified" if residual_eff == 0 else "failed"
        return core.make_report(
            tool="watermarks-remover", mode="sanitize", kind="deterministic", tool_version=version,
            input_text=text, output_text=cleaned, findings=findings, verification_status=status,
            verification_note=f"Po očištění inspect_text hlásí {residual} podezřelých znaků (z toho {restored} záměrně obnovených NBSP).",
            limitations=lim, elapsed_ms=t.ms, removed_unicode_count=int(stats.get("removed_count", 0)) + int(stats.get("replaced_count", 0)),
            options={"nfkc": bool(options.get("nfkc")), "aggressive_homoglyphs": bool(options.get("aggressive_homoglyphs")), "czech_nbsp": preserve_cz},
            raw={"stats": stats},
        )

    if mode == "statistical":
        backend = options.get("backend") or os.environ.get("WATERMARKS_REWRITE_BACKEND", "print-prompt")
        tactic = options.get("tactic", "paraphrase")
        args = ["-", "--backend", backend, "--tactic", tactic, "--original-lang", "Czech", "--json-stats"]
        if options.get("model"):
            args += ["--model", str(options["model"])]
        if options.get("rewrite_level"):
            args += ["--rewrite-level", str(options["rewrite_level"])]
        lim = [core.COMMON_LIMITATIONS["experimental"], core.COMMON_LIMITATIONS["czech_rewrite_risk"],
               core.COMMON_LIMITATIONS["vendor_unverifiable"], core.COMMON_LIMITATIONS["detector_scoped"]]
        with core.Timer() as t:
            rc, out, err = _run(REWRITE, args, text, timeout=int(options.get("timeout", 600)))
        if rc != 0:
            return core.make_report(
                tool="watermarks-remover", mode="statistical", kind="statistical", tool_version=version,
                input_text=text, output_text=text, findings=[], verification_status="failed",
                limitations=lim + [f"rewrite_text selhal (rc={rc}): {err[-400:]}"], elapsed_ms=t.ms,
                options={"backend": backend, "tactic": tactic},
            )
        stats = {}
        try:
            stats = json.loads(err) if err.strip().startswith("{") else {}
        except Exception:  # noqa: BLE001
            pass
        if backend == "print-prompt":
            # Nástroj text nepřepsal, jen připravil prompt. Výstup = původní text, prompt do raw.
            return core.make_report(
                tool="watermarks-remover", mode="statistical", kind="statistical", tool_version=version,
                input_text=text, output_text=text,
                findings=[{"category": "prompt", "label": f"Prompt pro LLM připraven (taktika {tactic})", "count": 1,
                           "severity": "info", "action": "none",
                           "note": "Backend print-prompt nic nepřepisuje. Prompt zkopíruj do lokálního LLM, nebo nastav WATERMARKS_REWRITE_BACKEND=ollama."}],
                verification_status="unsupported",
                verification_note="Žádný lokální LLM backend; přepis neproběhl.",
                limitations=lim + ["Bez nakonfigurovaného backendu (ollama / openai-compatible) je tento režim jen generátor promptu."],
                elapsed_ms=t.ms, options={"backend": backend, "tactic": tactic}, raw={"stats": stats, "prompt": out},
            )
        return core.make_report(
            tool="watermarks-remover", mode="statistical", kind="statistical", tool_version=version,
            input_text=text, output_text=out.rstrip("\n") + ("\n" if text.endswith("\n") else ""),
            findings=[{"category": "rewrite", "label": f"LLM přepis ({backend}, {tactic})", "count": 1, "severity": "medium", "action": "rewrite"}],
            verification_status="mitigation_unverified",
            verification_note="Přepsáno bez nezávislého detektoru; není ověřeno, že vodoznak zmizel.",
            limitations=lim, elapsed_ms=t.ms, options={"backend": backend, "tactic": tactic, "model": options.get("model")}, raw={"stats": stats},
        )

    return core.error_report("watermarks-remover", mode, text, f"neznámý režim {mode}")
