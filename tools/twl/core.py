"""Společné jádro: normalizovaný report v1, diff, HTML entity, česká pravidla.

Všechno zde je deterministické a bez závislostí mimo stdlib.
"""
from __future__ import annotations

import difflib
import html
import re
import time
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "1.0"

# České jednopísmenné předložky a spojky, za kterými patří pevná mezera (ČSN 01 6910).
CZ_NBSP_WORDS = set("k s v z o u a i K S V Z O U A I".split())
NBSP = " "
NNBSP = " "
_TOKEN_RE = re.compile(r"\s+|[^\s]+", re.UNICODE)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Timer:
    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *_):
        self.ms = round((time.perf_counter() - self.t0) * 1000, 2)


# ---------------------------------------------------------------- diff

def word_diff(a: str, b: str) -> list[dict[str, str]]:
    """Diff po tokenech (slovo | bílé znaky). Vrací seznam {op, text}, op ∈ equal/delete/insert."""
    ta = _TOKEN_RE.findall(a)
    tb = _TOKEN_RE.findall(b)
    out: list[dict[str, str]] = []
    sm = difflib.SequenceMatcher(a=ta, b=tb, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            out.append({"op": "equal", "text": "".join(ta[i1:i2])})
        elif op == "delete":
            out.append({"op": "delete", "text": "".join(ta[i1:i2])})
        elif op == "insert":
            out.append({"op": "insert", "text": "".join(tb[j1:j2])})
        else:  # replace
            out.append({"op": "delete", "text": "".join(ta[i1:i2])})
            out.append({"op": "insert", "text": "".join(tb[j1:j2])})
    return out


def diff_stats(diff: list[dict[str, str]]) -> dict[str, int]:
    """Počet změněných segmentů (sousedící delete+insert = 1 segment)."""
    segments = 0
    prev = "equal"
    for d in diff:
        if d["op"] != "equal" and prev == "equal":
            segments += 1
        prev = d["op"]
    return {"changed_segments": segments}


# ---------------------------------------------------------------- HTML entity

_ENTITY_RE = re.compile(r"&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{1,31});")


def decode_entities(text: str) -> tuple[str, dict[str, int]]:
    """Dekóduje HTML entity (&nbsp; &#8203; …). Vrací (text, počty podle entity)."""
    counts: dict[str, int] = {}

    def _sub(m: re.Match) -> str:
        ent = m.group(0)
        dec = html.unescape(ent)
        if dec != ent:
            counts[ent] = counts.get(ent, 0) + 1
        return dec

    return _ENTITY_RE.sub(_sub, text), counts


def strip_html_tags(text: str) -> str:
    """Hrubé odstranění značek pro .html vstup (bez parseru, záměrně jednoduché)."""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text


# ---------------------------------------------------------------- česká pravidla

_WORD_SEP_RE = re.compile(r"(\S+)(\s*)", re.UNICODE)


def _is_nbsp_context(prev: str) -> bool:
    return prev in CZ_NBSP_WORDS or bool(re.fullmatch(r"\d+[.,]?", prev))


def czech_nbsp_pairs(original: str) -> set[tuple[str, str]]:
    """Dvojice (slovo, další slovo), mezi kterými byla v originálu pevná mezera
    v kontextu, kde ji česká typografie vyžaduje (jednopísmenná předložka, číslo)."""
    pairs: set[tuple[str, str]] = set()
    toks = _WORD_SEP_RE.findall(original)
    for (w, sep), (nxt, _) in zip(toks, toks[1:]):
        if sep in (NBSP, NNBSP) and _is_nbsp_context(w):
            pairs.add((w, nxt))
    return pairs


def restore_czech_nbsp(cleaned: str, pairs: set[tuple[str, str]]) -> tuple[str, int]:
    """Vrátí pevné mezery tam, kde je nástroj nahradil obyčejnou mezerou,
    ale česká typografie je vyžaduje. Vrací (text, počet obnovených)."""
    if not pairs:
        return cleaned, 0
    toks = _WORD_SEP_RE.findall(cleaned)
    if not toks:
        return cleaned, 0
    lead = cleaned[: cleaned.index(toks[0][0])] if toks[0][0] in cleaned else ""
    restored = 0
    out = [lead]
    for i, (w, sep) in enumerate(toks):
        nxt = toks[i + 1][0] if i + 1 < len(toks) else None
        if sep == " " and nxt is not None and (w, nxt) in pairs:
            sep = NBSP
            restored += 1
        out.append(w + sep)
    return "".join(out), restored


# ---------------------------------------------------------------- report

def make_report(
    *,
    tool: str,
    mode: str,
    kind: str,
    input_text: str,
    output_text: str,
    findings: list[dict[str, Any]],
    verification_status: str,
    limitations: list[str],
    elapsed_ms: float,
    removed_unicode_count: int | None = None,
    rewritten_segments_count: int | None = None,
    tool_version: str | None = None,
    verification_note: str | None = None,
    options: dict[str, Any] | None = None,
    raw: Any = None,
    language: str = "cs",
) -> dict[str, Any]:
    diff = word_diff(input_text, output_text)
    seg = diff_stats(diff)["changed_segments"]
    if removed_unicode_count is None:
        removed_unicode_count = sum(
            f.get("count", 0) for f in findings if f.get("action") in ("delete", "space", "replace")
        )
    if rewritten_segments_count is None:
        rewritten_segments_count = seg if kind == "statistical" else 0
    changes = sum(f.get("count", 0) for f in findings if f.get("action") not in (None, "none", "preserve")) \
        if kind == "deterministic" else seg
    rep: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "tool": tool,
        "tool_version": tool_version or "",
        "mode": mode,
        "kind": kind,
        "input_text": input_text,
        "output_text": output_text,
        "changes_count": changes,
        "removed_unicode_count": removed_unicode_count,
        "rewritten_segments_count": rewritten_segments_count,
        "findings": findings,
        "diff": diff,
        "verification_status": verification_status,
        "verification_note": verification_note or "",
        "limitations": limitations,
        "language": language,
        "elapsed_ms": elapsed_ms,
        "created_at": now_iso(),
        "options": options or {},
    }
    if raw is not None:
        rep["raw"] = raw
    return rep


def error_report(tool: str, mode: str, input_text: str, message: str, kind: str = "deterministic") -> dict[str, Any]:
    return make_report(
        tool=tool, mode=mode, kind=kind, input_text=input_text, output_text=input_text,
        findings=[], verification_status="failed", limitations=[message], elapsed_ms=0,
    )


COMMON_LIMITATIONS = {
    "unicode_not_statistical": "Unicode cleanup neodstraňuje statistický (token-sampling) vodoznak typu SynthID / KGW.",
    "detector_scoped": "Úspěch je vždy vázaný na konkrétní detektor; neexistuje univerzální důkaz odstranění.",
    "vendor_unverifiable": "Produkční vodoznak Claude / Gemini nelze prohlásit za odstraněný: kompatibilní nezávislý detektor není veřejně dostupný.",
    "czech_rewrite_risk": "U češtiny může přepis zhoršit styl, skloňování nebo posunout význam (čísla, negace, terminologie).",
    "experimental": "Statistická mitigace je experimentální a nedeterministická; výsledek se mezi běhy liší.",
}
