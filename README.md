# marklab (Vodoznak lab)

Lokální dashboard pro analýzu a odstranění AI text watermarkingu v **českém textu**.
Statický frontend pro GitHub Pages + volitelný lokální Python bridge nad třemi upstream nástroji.

Online (po publikaci): https://tomekson.github.io/marklab/

## TL;DR

- **Deterministický Unicode cleanup** (zero-width, tag znaky, exotické mezery, bidi) běží **přímo v prohlížeči**, text nikam neodchází.
- **Statistická mitigace** (přepis modelem) je **experimentální**, dostupná jen přes lokální bridge a bez lokálního LLM jen připraví prompt.
- Žádný z nástrojů **nemůže potvrdit odstranění produkčního vodoznaku Claude nebo Gemini**: veřejný kompatibilní detektor neexistuje.

## Co to umí už teď

| Funkce | Kde běží | Stav |
| --- | --- | --- |
| Analyze (inspekce Unicode, HTML entity, české NBSP) | prohlížeč | funguje |
| Sanitize Unicode (výchozí přísný profil = watermarks-remover Layer A, volitelný safe, obnova českých pevných mezer) | prohlížeč | funguje |
| Upload .txt / .md / .html / .docx, drag & drop | prohlížeč | funguje (.docx bez knihoven přes DecompressionStream) |
| Diff před/po, zviditelnění skrytých znaků, export .txt / .json | prohlížeč | funguje |
| Compare pipelines (safe vs strict) | prohlížeč | funguje |
| dewatermark `analyze` / `sanitize` / `remove` | bridge | funguje; `remove` bez modelu = fallback sanitize |
| watermarks-remover Layer A (`inspect_text`, `clean_text`, stylometrie) | bridge | funguje |
| watermarks-remover Layer B (`rewrite_text`) | bridge | jen `print-prompt`, s Ollama/OpenAI-compatible backendem přepis |
| reverse-SynthID-text | bridge | adapter hotový, vyžaduje `scripts/setup.sh --with-synthid` a gated Gemma; **neověřeno spuštěním** |
| Ukázkové reporty nad `sample-data/` | statické JSON | vygenerované |

## Spuštění lokálně

```bash
scripts/setup.sh            # naklonuje vendor/, uv venv (Python 3.12), nainstaluje dewatermark
scripts/run-local.sh        # http://127.0.0.1:8777/  (dashboard + /api na jedné origin)
```

Bez bridge stačí jakýkoli statický server nad `docs/`:

```bash
python3 -m http.server 8000 --directory docs
```

CLI:

```bash
.venv/bin/python tools/twl/cli.py capabilities
.venv/bin/python tools/twl/cli.py run --mode sanitize --input sample-data/02-zero-width.txt
.venv/bin/python tools/twl/cli.py run --mode analyze --tool watermarks-remover --input text.txt --json
.venv/bin/python tools/twl/cli.py compare --input text.txt
scripts/export-demo-results.sh   # output/*.json + docs/demo/*.json
```

Statistická mitigace s lokálním LLM (Ollama):

```bash
export WATERMARKS_REWRITE_BACKEND=ollama WATERMARKS_REWRITE_MODEL=<model>
.venv/bin/python tools/twl/cli.py run --mode statistical --tool watermarks-remover --input text.txt --opt tactic=paraphrase
```

## Architektura ve zkratce

```
docs/            statický dashboard (GitHub Pages, plain HTML/CSS/ESM, bez buildu)
  js/engine.js   prohlížečový engine (dewatermark-unicode JS + česká pravidla + report v1)
  js/diff.js     Myers diff po tokenech
  js/docx.js     čtení .docx bez knihoven
  js/bridge.js   klient lokálního bridge
  vendor/dewatermark-unicode/   vendorovaný JS sanitizer (MIT), synchronizace scripts/setup.sh --sync-js
  demo/          ukázkové reporty
tools/twl/       Python orchestrátor (stdlib): adaptery, bridge (HTTP), CLI
schemas/report.v1.json   normalizovaný JSON report
sample-data/     české testovací vstupy
output/          plné demo reporty (včetně raw výstupů nástrojů)
vendor/          upstream repozitáře (neverzované, klonuje setup.sh)
```

Detail: [notes/ARCHITECTURE.md](notes/ARCHITECTURE.md).

## Použité nástroje

**Primární nástroj je watermarks-remover** (23 570★, 2 702 forků). **dewatermark má jen 7★, 0 forků a jediného autora** (repo z 17. 8. 2026); používá se jen jako křížová kontrola a jako zdroj tabulky Unicode rozsahů pro prohlížeč, kterou jsem porovnal s watermarks-remover (rozdíl: Word Joiner U+2060). Výchozí přísný profil v prohlížeči se chová jako watermarks-remover Layer A.

| Nástroj | Licence | Role | Jak je zapojený |
| --- | --- | --- | --- |
| [dewatermark](https://github.com/cyzanfar/text-watermark-remover) 0.8.0 | MIT | Unicode politika, Python API, JS port | JS port v prohlížeči; Python API v bridge (`analyze`, `sanitize`, `remove`) |
| [watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover) | MIT | Layer A cleanup, stylometrie, Layer B rewrite | subprocess na `service/scripts/{inspect_text,clean_text,rewrite_text}.py` |
| [reverse-SynthID-text](https://github.com/aloshdenny/reverse-SynthID-text) | Apache-2.0 | referenční SynthID detektor + útoky (EN) | subprocess na `reverse_synthid.py` v samostatném venv |

## Transparentnost: co výsledky znamenají

- **Unicode cleanup ≠ odstranění statistického vodoznaku.** Zero-width znaky jsou jen jedna, nejjednodušší vrstva.
- **Statistická mitigace je experimentální.** Nedeterministická, závislá na modelu, taktice a textu.
- **Úspěch je detector-scoped.** Stav `mitigation_verified` platí jen pro pojmenovaný detektor, nikdy univerzálně. Bez detektoru je výsledek vždy `mitigation_unverified`.
- **Čeština:** přepis může zhoršit styl, skloňování a posunout význam (čísla, negace, terminologie). Všechny tři nástroje jsou laděné na angličtinu.
- **Claude / Gemini produkční vodoznak** nelze prohlásit za odstraněný. dewatermark tyto detektory registruje jako `unsupported_pending_spec`; reverse-SynthID má jen veřejné ukázkové klíče.

## Česká specifika v implementaci

- **Pevná mezera** za jednopísmennými předložkami (k, s, v, z, o, u, a, i) a v číslech (1 000 Kč) je správná typografie. Oba nástroje ji převádí na obyčejnou mezeru; dashboard ji po očištění vrací (volba „Zachovat pevné mezery“, zapnutá).
- **Diakritika** zůstává nedotčená v safe profilech obou nástrojů (jen NFC). Profil `aggressive` (dewatermark) a `--nfkc` (watermarks-remover) jsou ztrátové a dashboard je nepoužívá.
- **České uvozovky „“ ‚‘ a pomlčky –** nejsou v žádné politice, zůstávají.
- **Word Joiner (U+2060)** dewatermark safe zachovává, watermarks-remover maže. Výchozí přísný profil v prohlížeči se chová jako watermarks-remover.

## Publikace na GitHub Pages

1. `gh repo create tomekson/marklab --public --source . --push`
2. Settings → Pages → Source: branch `main`, folder `/docs` (nebo `gh api -X POST repos/tomekson/marklab/pages -f source[branch]=main -f source[path]=/docs`).
3. Stránka bude na `https://tomekson.github.io/marklab/` vedle `bananovnik`. Všechny cesty jsou relativní.
4. Na Pages je dostupný jen prohlížečový režim; bridge zůstává lokální.

## Jak doplnit další detektor nebo model

- **Nový Python nástroj:** přidej `tools/twl/adapters/<name>_adapter.py` s `info()` a `run(text, mode, options) -> report` (použij `core.make_report`), zaregistruj v `adapters/__init__.py`. Frontend ho nabídne automaticky podle `/api/capabilities`.
- **Detektor pro dewatermark:** `dewatermark detectors scaffold --pack synthid --output ./pack`, pak `--detector <name>` v `remove`/`mitigate` (viz upstream docs/DETECTORS.md).
- **LLM backend pro watermarks-remover:** proměnné `WATERMARKS_REWRITE_BACKEND=ollama|openai-compatible`, `WATERMARKS_REWRITE_MODEL`, `WATERMARKS_REWRITE_BASE_URL`; vzdálený endpoint jen s `WATERMARKS_REWRITE_ALLOW_REMOTE=1`.
- **reverse-SynthID-text:** `scripts/setup.sh --with-synthid`, `huggingface-cli login`, přijmout licenci `google/gemma-2b-it`.

## Otevřené limity pro češtinu

- Žádný z nástrojů nemá český paraphraser ani českou perturbaci (synonyma, výplňová slova a lexikon jsou EN).
- Stylometrie watermarks-remover je kalibrovaná na angličtinu; skóre pro češtinu je jen orientační.
- Referenční detektory (KGW, Unigram, tournament, SynthID s ukázkovými klíči) tokenizují anglicky; na češtině nic nevypovídají.
- Obnova NBSP je heuristická (dvojice slov z originálu); netvoří nové pevné mezery tam, kde v originálu nebyly.
- `.docx` čtení bere jen `word/document.xml` (bez poznámek pod čarou, hlaviček, komentářů).
