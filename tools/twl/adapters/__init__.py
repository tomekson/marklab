"""Adaptery: každý vystavuje `info()` a `run(text, mode, options) -> report`."""
from __future__ import annotations

from . import dewatermark_adapter, synthid_adapter, wmr_adapter

ADAPTERS = {
    "dewatermark": dewatermark_adapter,
    "watermarks-remover": wmr_adapter,
    "reverse-synthid": synthid_adapter,
}


def capabilities() -> dict:
    return {name: mod.info() for name, mod in ADAPTERS.items()}
