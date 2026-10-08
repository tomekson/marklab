"""Adapter pro `dewatermark` (cyzanfar/text-watermark-remover), volaný přes Python API.

Deterministické: analyze(), sanitize(), remove(mode="sanitize").
Statistické (experimentální): remove(mode=paraphrase|sira|bias_inversion|full|adversarial).
Bez nainstalovaného modelu / backendu vrací upstream nástroj původní text a stav
`unsupported` nebo `rejected`; to předáváme dál beze změny.
"""
from __future__ import annotations

from typing import Any

from .. import core

STAT_MODES = ("auto", "paraphrase", "full", "sira", "bias_inversion", "adversarial")


def _import():
    try:
        import dewatermark  # type: ignore

        return dewatermark
    except Exception:  # noqa: BLE001
        return None


def info() -> dict[str, Any]:
    dw = _import()
    if dw is None:
        return {"available": False, "reason": "balíček dewatermark není ve venv (spusť scripts/setup.sh)"}
    caps: dict[str, Any] = {}
    try:
        caps = dw.capabilities()  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        caps = {"error": str(e)}
    return {
        "available": True,
        "version": getattr(dw, "__version__", "?"),
        "license": "MIT",
        "modes": {
            "analyze": "deterministic",
            "sanitize": "deterministic",
            "statistical": "statistical (vyžaduje lokální model nebo API; bez něj vrací původní text)",
        },
        "local_model_cached": caps.get("local_model_cached"),
        "llm_configured": caps.get("llm_configured"),
        "detectors": caps.get("detector_plugins", []),
    }


def _findings_from_analyze(rep: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for f in rep.get("unicode", {}).get("findings", []):
        disp = f.get("disposition")
        sev = {"actionable": "high", "contextual": "medium", "informational": "info"}.get(disp, "low")
        action = "delete" if disp == "actionable" else ("space" if f.get("category") == "exotic_space" and disp != "informational" else "preserve")
        out.append({
            "category": f.get("category", ""),
            "label": f"{f.get('codepoint')} {f.get('name')}",
            "codepoint": f.get("codepoint"),
            "count": f.get("count", 0),
            "severity": sev,
            "action": action,
            "positions": f.get("positions", []),
            "note": f.get("explanation", ""),
        })
    return out


def run(text: str, mode: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    dw = _import()
    if dw is None:
        return core.error_report("dewatermark", mode, text, "dewatermark není nainstalován")
    version = getattr(dw, "__version__", "")
    profile = options.get("profile", "safe")
    preserve_cz = bool(options.get("czech_nbsp", True))
    lim = [core.COMMON_LIMITATIONS["unicode_not_statistical"], core.COMMON_LIMITATIONS["detector_scoped"]]

    if mode == "analyze":
        with core.Timer() as t:
            rep = dw.analyze(text)
        return core.make_report(
            tool="dewatermark", mode="analyze", kind="deterministic", tool_version=version,
            input_text=text, output_text=text, findings=_findings_from_analyze(rep),
            verification_status="not_applicable", limitations=lim, elapsed_ms=t.ms,
            removed_unicode_count=0, options={"profile": profile}, raw=rep,
        )

    if mode == "sanitize":
        with core.Timer() as t:
            before = dw.analyze(text)
            cleaned = dw.sanitize(text, profile=profile)
            restored = 0
            if preserve_cz:
                cleaned, restored = core.restore_czech_nbsp(cleaned, core.czech_nbsp_pairs(text))
            after = dw.analyze(cleaned)
        findings = _findings_from_analyze(before)
        if restored:
            findings.append({
                "category": "czech_typography", "label": "Pevná mezera obnovena (česká typografie)",
                "count": restored, "severity": "info", "action": "preserve",
                "note": "NBSP za jednopísmennou předložkou nebo v čísle je správně; vrácena zpět.",
            })
        residual = after.get("unicode", {}).get("actionable_count", 0)
        status = "unicode_verified" if residual == 0 else "failed"
        note = "Po očištění detektor unicode-artifacts-v1 nehlásí žádný actionable nález." if residual == 0 \
            else f"Po očištění zbývá {residual} actionable nálezů."
        if profile == "aggressive":
            lim = lim + ["Profil aggressive je ztrátový (NFKC + confusables); u češtiny raději safe."]
        return core.make_report(
            tool="dewatermark", mode="sanitize", kind="deterministic", tool_version=version,
            input_text=text, output_text=cleaned, findings=findings,
            verification_status=status, verification_note=note, limitations=lim, elapsed_ms=t.ms,
            options={"profile": profile, "czech_nbsp": preserve_cz},
            raw={"before": before.get("stats"), "after": after.get("stats")},
        )

    if mode == "statistical":
        stat_mode = options.get("stat_mode", "auto")
        if stat_mode not in STAT_MODES:
            stat_mode = "auto"
        lim = [core.COMMON_LIMITATIONS["experimental"], core.COMMON_LIMITATIONS["czech_rewrite_risk"],
               core.COMMON_LIMITATIONS["vendor_unverifiable"], core.COMMON_LIMITATIONS["detector_scoped"],
               "dewatermark paraphraser je laděný na angličtinu (prompt 'idiomatic English')."]
        try:
            with core.Timer() as t:
                res = dw.remove(text, mode=stat_mode, passes=int(options.get("passes", 1)))
            d = res.to_dict()
        except Exception as e:  # noqa: BLE001
            return core.make_report(
                tool="dewatermark", mode="statistical", kind="statistical", tool_version=version,
                input_text=text, output_text=text, findings=[], verification_status="failed",
                limitations=lim + [f"Chyba: {e}"], elapsed_ms=0, options={"stat_mode": stat_mode},
            )
        rep = d.get("report", {})
        out = d.get("cleaned_text", text)
        ts = rep.get("transformation_status", "")
        vs = rep.get("verification_status", "")
        meta = rep.get("metadata") or {}
        sanitize_only = rep.get("fallback_reason") == "sanitize_only" or meta.get("auto_selected") == "sanitize_only" \
            or ts == "unicode_sanitized"
        if sanitize_only:
            status = "unsupported"
            lim = lim + ["Žádný lokální model ani LLM backend není nakonfigurovaný; dewatermark provedl jen Unicode sanitize (fallback sanitize_only)."]
        elif ts == "mitigation_verified":
            status = "mitigation_verified"
        elif ts in ("mitigation_unverified",):
            status = "mitigation_unverified"
        elif ts in ("unsupported_scheme", "unchanged") or not rep.get("changed"):
            status = "unsupported"
        else:
            status = "mitigation_unverified"
        findings = [{
            "category": "stage", "label": f"{s.get('stage')}: {s.get('status')}",
            "count": 1, "severity": "info", "action": "rewrite" if s.get("changed") else "none",
            "note": s.get("fallback_reason") or s.get("warning") or s.get("error") or "",
        } for s in d.get("stages", [])]
        result = core.make_report(
            tool="dewatermark", mode="statistical", kind="statistical", tool_version=version,
            input_text=text, output_text=out, findings=findings, verification_status=status,
            verification_note=("Statistický přepis neproběhl (fallback sanitize_only). " if sanitize_only else "")
            + f"transformation={ts or '-'}, verification={vs or '-'}, detection={rep.get('detection_status', '-')}",
            limitations=lim, elapsed_ms=t.ms, options={"stat_mode": stat_mode}, raw={"report": rep, "stages": d.get("stages")},
            rewritten_segments_count=0 if sanitize_only else None,
        )
        if sanitize_only:
            removed = int(rep.get("chars_removed") or 0)
            result["changes_count"] = removed
            result["removed_unicode_count"] = removed
        return result

    return core.error_report("dewatermark", mode, text, f"neznámý režim {mode}")
