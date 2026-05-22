import { readFileSync } from 'node:fs';

/** Skip one or more UTF-8 BOM sequences (EF BB BF). */
function utf8BomByteLength(buf: Buffer): number {
    let off = 0;
    while (
        buf.length - off >= 3
        && buf[off] === 0xef
        && buf[off + 1] === 0xbb
        && buf[off + 2] === 0xbf
    ) {
        off += 3;
    }
    return off;
}

/** Strip BOM from a UTF-8 string (e.g. after readFileSync(..., 'utf-8')). */
export function stripUtf8Bom(content: string): string {
    return content.replace(/^\uFEFF+/, '').trimStart();
}

/**
 * Read a UTF-8 JSON file. Tolerates leading UTF-8 BOM (common with PowerShell
 * `Set-Content -Encoding utf8`) and stray U+FEFF after decode.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJsonUtf8File(path: string): any {
    const buf = readFileSync(path);
    const off = utf8BomByteLength(buf);
    const text = stripUtf8Bom(buf.subarray(off).toString('utf8'));
    return JSON.parse(text);
}
