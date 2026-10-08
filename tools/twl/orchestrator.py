"""Orchestrace: spuštění jednoho nástroje nebo porovnání všech dostupných."""
from __future__ import annotations

from typing import Any

from . import core
from .adapters import ADAPTERS, capabilities

DEFAULT_TOOL = {"analyze": "dewatermark", "sanitize": "dewatermark", "statistical": "watermarks-remover"}


def preprocess(text: str, options: dict[str, Any] | None) -> tuple[str, list[dict[str, Any]]]:
    """Volitelné předzpracování: strip HTML značek a dekódování entit."""
    options = options or {}
    findings: list[dict[str, Any]] = []
    if options.get("strip_html"):
        text = core.strip_html_tags(text)
    if options.get("decode_entities", True):
        text, counts = core.decode_entities(text)
        for ent, n in counts.items():
            findings.append({"category": "html_entity", "label": f"HTML entita {ent}", "count": n,
                             "severity": "low", "action": "replace", "note": "Dekódováno na znak před analýzou."})
    return text, findings


def run_one(text: str, mode: str, tool: str | None = None, options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = dict(options or {})
    tool = tool or DEFAULT_TOOL.get(mode, "dewatermark")
    if tool not in ADAPTERS:
        return core.error_report(tool, mode, text, f"neznámý nástroj {tool}")
    original = text
    text, pre = preprocess(text, options)
    rep = ADAPTERS[tool].run(text, mode, options)
    if pre:
        rep["findings"] = pre + rep["findings"]
        rep["input_text"] = original
        rep["diff"] = core.word_diff(original, rep["output_text"])
        rep["changes_count"] += sum(f["count"] for f in pre)
    return rep


def compare(text: str, options: dict[str, Any] | None = None, include_statistical: bool = True) -> dict[str, Any]:
    """Spustí všechny dostupné deterministické pipeline (a volitelně statistické)
    a vrátí jeden report režimu `compare` s pod-reporty v `pipelines`."""
    options = dict(options or {})
    caps = capabilities()
    pipelines: list[dict[str, Any]] = []
    with core.Timer() as t:
        for tool in ("dewatermark", "watermarks-remover"):
            if caps[tool].get("available"):
                pipelines.append(run_one(text, "sanitize", tool, options))
        if include_statistical:
            for tool in ("watermarks-remover", "dewatermark", "reverse-synthid"):
                pipelines.append(run_one(text, "statistical", tool, options))
    summary = [{
        "tool": p["tool"], "mode": p["mode"], "kind": p["kind"], "changes_count": p["changes_count"],
        "removed_unicode_count": p["removed_unicode_count"], "rewritten_segments_count": p["rewritten_segments_count"],
        "verification_status": p["verification_status"], "output_sha_prefix": _sha(p["output_text"])[:12],
        "elapsed_ms": p["elapsed_ms"],
    } for p in pipelines]
    best = next((p for p in pipelines if p["kind"] == "deterministic" and p["verification_status"] == "unicode_verified"), None)
    rep = core.make_report(
        tool="twl", mode="compare", kind="deterministic", input_text=text,
        output_text=best["output_text"] if best else text,
        findings=[{"category": "pipeline", "label": f"{s['tool']} / {s['mode']}: {s['verification_status']}",
                   "count": s["changes_count"], "severity": "info", "action": "none"} for s in summary],
        verification_status=best["verification_status"] if best else "not_applicable",
        verification_note="output_text = první deterministická pipeline se stavem unicode_verified.",
        limitations=sorted({l for p in pipelines for l in p["limitations"]}),
        elapsed_ms=t.ms, options=options,
    )
    rep["pipelines"] = pipelines
    rep["summary"] = summary
    rep["capabilities"] = caps
    return rep


def _sha(s: str) -> str:
    import hashlib

    return hashlib.sha256(s.encode("utf-8")).hexdigest()
