// Diff po tokenech (slovo | bílé znaky), Myersův O(ND) algoritmus.
// Výstup: [{op: "equal"|"delete"|"insert", text}]
const TOKEN_RE = /\s+|[^\s]+/gu;

export function tokenize(s) {
  return s.match(TOKEN_RE) || [];
}

export function wordDiff(a, b) {
  const A = tokenize(a), B = tokenize(b);
  const ops = myers(A, B);
  // sloučení sousedních stejných operací
  const out = [];
  for (const [op, tok] of ops) {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += tok;
    else out.push({ op, text: tok });
  }
  return out;
}

export function diffStats(diff) {
  let segments = 0, prev = "equal", deleted = 0, inserted = 0;
  for (const d of diff) {
    if (d.op !== "equal" && prev === "equal") segments++;
    if (d.op === "delete") deleted += Array.from(d.text).length;
    if (d.op === "insert") inserted += Array.from(d.text).length;
    prev = d.op;
  }
  return { changedSegments: segments, deletedChars: deleted, insertedChars: inserted };
}

function myers(A, B) {
  const N = A.length, M = B.length, MAX = N + M;
  if (MAX === 0) return [];
  const v = new Map(); v.set(1, 0);
  const trace = [];
  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v.set(k, x);
      if (x >= N && y >= M) break outer;
    }
  }
  // backtrack
  const ops = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv.get(prevK) ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(["equal", A[x - 1]]); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push(["insert", B[y - 1]]); y--; }
      else { ops.push(["delete", A[x - 1]]); x--; }
    }
  }
  return ops.reverse();
}
