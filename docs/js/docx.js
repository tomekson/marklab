// Čtení .docx bez knihoven: ZIP (store/deflate) přes DecompressionStream, text z word/document.xml.
// Vrací prostý text s odstavci oddělenými \n. Zachovává pevné mezery a skryté znaky (to je cíl analýzy).
export async function docxToText(arrayBuffer) {
  const entries = parseZip(new Uint8Array(arrayBuffer));
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("word/document.xml nenalezen, není to .docx?");
  const xml = new TextDecoder("utf-8").decode(await inflateEntry(doc));
  return extractParagraphs(xml);
}

function extractParagraphs(xml) {
  const parser = new DOMParser();
  const dom = parser.parseFromString(xml, "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const paras = dom.getElementsByTagNameNS(W, "p");
  const lines = [];
  for (const p of paras) {
    let s = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.namespaceURI !== W) { walk(c); continue; }
        switch (c.localName) {
          case "t": s += c.textContent; break;
          case "tab": s += "\t"; break;
          case "br": case "cr": s += "\n"; break;
          case "noBreakHyphen": s += "‑"; break;
          case "softHyphen": s += "­"; break;
          default: walk(c);
        }
      }
    };
    walk(p);
    lines.push(s);
  }
  return lines.join("\n") + "\n";
}

function parseZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // najdi End of central directory
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: chybí central directory");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("ZIP: poškozený záznam");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
    // local header → skutečný začátek dat
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    entries.push({ name, method, data: u8.subarray(start, start + csize) });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

async function inflateEntry(e) {
  if (e.method === 0) return e.data;
  if (e.method !== 8) throw new Error("ZIP: nepodporovaná komprese " + e.method);
  if (typeof DecompressionStream === "undefined") throw new Error("Prohlížeč nemá DecompressionStream");
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([e.data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
