# Architektura text-watermark-lab

Datum návrhu: 8. října 2026.

## Discovery (ověřené skutečnosti)

- `/projects` neexistuje; ekvivalent je `/Users/tomek/projects`.
- Není monorepo `tomekson.github.io`. Každý projekt je vlastní repo (`tomekson/bananovnik`) publikované přes GitHub Pages z `main` (bananovnik z `/`, `build_type: legacy`), URL `tomekson.github.io/<repo>/`.
- bananovnik: jednosouborová aplikace `index.html` (~200 kB), tokeny `:root` / `[data-theme=dark]`, offsetové stíny, systémový font, `DESIGN.md`. Převzatý duch: tokeny + `color-mix()`, offset shadow, `<details>`/nativní prvky, žádný build, žádné webfonty. Paleta je jiná (papír/inkoust/korál), aby nešlo o klon.
- Upstream nástroje (klonováno 8. 10. 2026):
  - `cyzanfar/text-watermark-remover` (PyPI `dewatermark` 0.8.0, MIT, Python ≥ 3.9, core deps jen `requests`). CLI `dewatermark {sanitize,analyze,remove,check,localize,mitigate,detectors,…}`. Obsahuje `web/` = ESM JS port Unicode sanitizeru generovaný ze stejné politiky (`2026.08`).
  - `guillaumemeyer/watermarks-remover` (MIT, Python ≥ 3.10 stdlib-only). Layer A: `service/scripts/clean_text.py`, `inspect_text.py` (`--json --stylometry`). Layer B: `rewrite_text.py --backend print-prompt|ollama|openai-compatible`. HTTP server `server.py` (port 8765) pro text vyžaduje nakonfigurovanou Layer B, proto nepoužit; voláme skripty přímo.
  - `aloshdenny/reverse-SynthID-text` (Apache-2.0; fork DeepMind synthid-text). `reverse_synthid.py --method paraphrase|perturb|shuffle|homoglyph|combined`, `--detect-only`. Importuje torch i pro neparafrázující metody; piny `torch==2.4.0`, `jax[cuda]`. Model `google/gemma-2b-it` (gated). Výstup jen text + stdout, bez JSON. Detektor = referenční s veřejnými klíči + GPT-2 tokenizer.

## Rozhodnutí

0. **Důvěra v upstream (doplněno 8. 10. 2026):** dewatermark má 7★ a jediného autora, watermarks-remover 23 k★. Primární nástroj je proto watermarks-remover (výchozí v bridge i v compare), prohlížeč má výchozí přísný profil, který jeho Layer A aproximuje. dewatermark zůstává jako křížová kontrola a zdroj JS tabulky rozsahů (porovnána, rozdíl jen WJ).

1. **Dvojí architektura.** Statický frontend (`docs/`) + lokální bridge (`tools/twl/bridge.py`). Bridge servíruje `docs/` i `/api` na jedné origin: žádný CORS ani mixed-content problém. Z GitHub Pages (https) se bridge na `http://127.0.0.1` typicky nepřipojí (mixed content / Private Network Access), proto je lokální provoz primární cestou pro Python nástroje a Pages je „jen prohlížeč“.
2. **Prohlížečový engine = vendorovaný JS port dewatermark.** Stejná politika jako Python balíček, cross-runtime golden testy upstream. Ověřeno: shodné počty nálezů (13) na vzorku `02-zero-width`.
3. **Přísný profil v prohlížeči** (`strictSweep`: smaže všechny `\p{Cf}` kromě ZWJ v emoji sekvenci) aproximuje watermarks-remover Layer A, aby „Porovnat pipeline“ dávalo smysl i bez bridge.
4. **Česká pravidla** jsou vrstva nad nástroji, ne patch upstreamu: dvojice slov s NBSP v českém kontextu se po čištění obnoví. Implementováno shodně v Pythonu (`core.py`) i JS (`engine.js`).
5. **reverse-SynthID-text** je volitelný, v samostatném venv (`.venv-synthid`, Python 3.11, torch bez CUDA pinů). Adapter funguje přes subprocess a parsuje stdout. Bez instalace hlásí `unsupported` s důvodem. Spuštění s modelem nebylo v rámci této práce ověřeno.
6. **Statistická mitigace nikdy netvrdí úspěch.** Mapování stavů: přepis bez detektoru → `mitigation_unverified`; fallback na sanitize → `unsupported`; print-prompt → `unsupported` + prompt v `raw.prompt`.

## Datový tok

```
textarea / soubor ──► preprocess (strip HTML?, decode entities) ──► engine
                                                                   ├─ prohlížeč: inspectText / sanitizeTextWithReport (+strict, +czech NBSP)
                                                                   └─ bridge POST /api/run|/api/compare ──► adapter ──► upstream nástroj
                                                       ◄── report v1 (schemas/report.v1.json) ◄──
render: summary karty · verify box · findings · limitations · diff (inline/side/reveal) · compare tabulka · export .txt/.json
```

## Report v1 (klíčová pole)

`tool, mode, kind(deterministic|statistical), input_text, output_text, changes_count, removed_unicode_count, rewritten_segments_count, findings[], diff[], verification_status, verification_note, limitations[], language, elapsed_ms, created_at, options, raw?`.
`compare` navíc `pipelines[]`, `summary[]`, `capabilities`.

`verification_status`: `unicode_verified | not_applicable | mitigation_unverified | mitigation_verified | unsupported | failed`.

## API bridge

- `GET /api/health`, `GET /api/capabilities`
- `POST /api/run {text, mode: analyze|sanitize|statistical, tool?, options}` → `{ok, report}`
- `POST /api/compare {text, options, statistical?}` → `{ok, report}`
- Limit těla 2 MB, bez autentizace, bind jen `127.0.0.1`.

## Co by se dělalo dál

- Český paraphraser přes Ollama (např. vícejazyčný model) + český prompt; měřit zachování významu (čísla, negace) automatickým checkem.
- Vlastní „czech-safe“ Unicode profil jako samostatná politika místo post-processingu.
- Testy: golden soubory pro `core.py` a `engine.js` nad `sample-data/`.
- Volitelná instalace `dewatermark[local]` a ověření `remove --mode sira` lokálně.
