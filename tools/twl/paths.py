"""Cesty k vendorovaným nástrojům a k venv. Vše relativně ke kořeni projektu."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "vendor"
VENV_PY = ROOT / ".venv" / "bin" / "python"
SYNTHID_VENV_PY = ROOT / ".venv-synthid" / "bin" / "python"
WMR_SCRIPTS = VENDOR / "watermarks-remover" / "service" / "scripts"
SYNTHID_DIR = VENDOR / "reverse-SynthID-text"
DEWATERMARK_DIR = VENDOR / "dewatermark"
SAMPLE_DATA = ROOT / "sample-data"
OUTPUT = ROOT / "output"
DOCS = ROOT / "docs"


def python() -> str:
    """Interpret pro subprocesy: venv projektu, jinak aktuální."""
    return str(VENV_PY) if VENV_PY.exists() else sys.executable


def env_offline() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("HF_HUB_OFFLINE", "1")
    env.setdefault("TRANSFORMERS_OFFLINE", "1")
    return env
