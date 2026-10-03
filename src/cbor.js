// WebAuthn の検証に必要な最小限の CBOR デコーダ (整数・バイト列・文字列・配列・マップ)
export function decodeCbor(buf, offset = 0) {
  const view = Buffer.from(buf);
  let pos = offset;
  const need = (n) => { if (pos + n > view.length) throw new Error('CBOR: データが途中で切れています'); };
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) { need(1); return view[pos++]; }
    if (info === 25) { need(2); const v = view.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = view.readUInt32BE(pos); pos += 4; return v; }
    throw new Error('CBOR: 未対応の長さ');
  }
  function item(depth) {
    if (depth > 8) throw new Error('CBOR: 入れ子が深すぎます');
    need(1);
    const b = view[pos++], major = b >> 5, info = b & 31;
    const len = readLen(info);
    switch (major) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: { need(len); const v = view.subarray(pos, pos + len); pos += len; return Buffer.from(v); }
      case 3: { need(len); const v = view.subarray(pos, pos + len).toString('utf8'); pos += len; return v; }
      case 4: { const a = []; for (let i = 0; i < len; i++) a.push(item(depth + 1)); return a; }
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      default: throw new Error('CBOR: 未対応の型');
    }
  }
  const value = item(0);
  return { value, end: pos };
}
