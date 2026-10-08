"""CLI: python3 tools/twl/cli.py <příkaz> …

  capabilities                      co je nainstalované
  run  --mode analyze|sanitize|statistical [--tool T] [--input F | text] [--json]
  compare [--input F | text] [--no-statistical]
  export-demo                       spustí pipeline nad sample-data/ → output/ a docs/demo/
  serve [port]                      lokální bridge + dashboard
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twl import orchestrator, paths  # noqa: E402
from twl.adapters import capabilities  # noqa: E402


def _read(args) -> str:
    if args.input:
        return Path(args.input).read_text(encoding="utf-8")
    if args.text:
        return args.text
    return sys.stdin.read()


def _opts(args) -> dict:
    o = {}
    for kv in args.opt or []:
        k, _, v = kv.partition("=")
        o[k] = {"true": True, "false": False}.get(v.lower(), v) if isinstance(v, str) else v
    return o


def cmd_run(args):
    rep = orchestrator.run_one(_read(args), args.mode, args.tool, _opts(args))
    if args.json:
        print(json.dumps(rep, ensure_ascii=False, indent=1))
    else:
        print(rep["output_text"], end="")
        print(f"\n--- {rep['tool']} / {rep['mode']} ({rep['kind']}): changes={rep['changes_count']} "
              f"unicode={rep['removed_unicode_count']} segments={rep['rewritten_segments_count']} "
              f"status={rep['verification_status']} {rep['elapsed_ms']} ms", file=sys.stderr)


def cmd_compare(args):
    rep = orchestrator.compare(_read(args), _opts(args), include_statistical=not args.no_statistical)
    if args.json:
        print(json.dumps(rep, ensure_ascii=False, indent=1))
    else:
        for s in rep["summary"]:
            print(f"{s['tool']:<20} {s['mode']:<12} {s['kind']:<14} changes={s['changes_count']:<4} "
                  f"unicode={s['removed_unicode_count']:<4} segs={s['rewritten_segments_count']:<4} {s['verification_status']}")


def cmd_export_demo(args):
    paths.OUTPUT.mkdir(exist_ok=True)
    demo = paths.DOCS / "demo"
    demo.mkdir(exist_ok=True)
    index = []
    for f in sorted(p for p in paths.SAMPLE_DATA.glob("*.txt") if ".cleaned" not in p.name):
        text = f.read_text(encoding="utf-8")
        rep = orchestrator.compare(text, {}, include_statistical=not args.no_statistical)
        name = f.stem + ".compare.json"
        (paths.OUTPUT / name).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        slim = {k: v for k, v in rep.items() if k != "capabilities"}
        for p in slim["pipelines"]:
            p.pop("raw", None)
        (demo / name).write_text(json.dumps(slim, ensure_ascii=False), encoding="utf-8")
        index.append({"sample": f.name, "title": f.stem.replace("-", " ")[3:], "file": name,
                      "chars": len(text), "pipelines": rep["summary"]})
        print(f"{f.name}: " + ", ".join(f"{s['tool']}/{s['mode']}={s['verification_status']}" for s in rep["summary"]))
    (demo / "index.json").write_text(json.dumps({"generated_at": rep["created_at"], "samples": index}, ensure_ascii=False, indent=1), encoding="utf-8")
    (paths.OUTPUT / "capabilities.json").write_text(json.dumps(capabilities(), ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {paths.OUTPUT} a {demo}")


def main():
    ap = argparse.ArgumentParser(prog="twl", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("capabilities")
    r = sub.add_parser("run")
    r.add_argument("--mode", required=True, choices=["analyze", "sanitize", "statistical"])
    r.add_argument("--tool", choices=["dewatermark", "watermarks-remover", "reverse-synthid"])
    r.add_argument("--input")
    r.add_argument("--opt", action="append", help="volba adapteru, např. profile=aggressive, czech_nbsp=false, tactic=humanize")
    r.add_argument("--json", action="store_true")
    r.add_argument("text", nargs="?")
    c = sub.add_parser("compare")
    c.add_argument("--input")
    c.add_argument("--opt", action="append")
    c.add_argument("--json", action="store_true")
    c.add_argument("--no-statistical", action="store_true")
    c.add_argument("text", nargs="?")
    e = sub.add_parser("export-demo")
    e.add_argument("--no-statistical", action="store_true")
    s = sub.add_parser("serve")
    s.add_argument("port", nargs="?", default="8777")
    args = ap.parse_args()
    if args.cmd == "capabilities":
        print(json.dumps(capabilities(), ensure_ascii=False, indent=1))
    elif args.cmd == "run":
        cmd_run(args)
    elif args.cmd == "compare":
        cmd_compare(args)
    elif args.cmd == "export-demo":
        cmd_export_demo(args)
    elif args.cmd == "serve":
        from twl import bridge

        sys.argv = [sys.argv[0], args.port]
        bridge.main()


if __name__ == "__main__":
    main()
