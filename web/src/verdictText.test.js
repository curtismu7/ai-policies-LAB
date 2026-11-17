// The plain-language table for a decision: every code the engine can emit has words, so a raw code is never the only explanation.
// The engine's own source is scanned for the codes it can produce (a new deny code that nobody wrote words for fails here), and every decision the
// lab's own scripted scenarios and quick starts produce is checked too.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS as CANON } from "../../server/src/canon.js";
import { STAGES, STAGE_TITLE } from "../../server/src/engine.js";
import { MOCK_TABLE } from "../../server/src/mockTable.js";
import { MAX_TOKEN } from "../../server/src/token.js";
import { STAGE_NAME, VERDICT_TEXT, verdictFor } from "./verdictText";

const SRC = path.resolve(import.meta.dirname, "../../server/src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

// Every place the server writes a code that can reach a decision: a deny() in the engine, a fail() in the token check, a bad() or code: in the canonical
// parser, the grant problems (an array whose first item is the code) and the engine's fixed `code:` fields.
function emittedCodes() {
  const found = new Set();
  const grab = (text, re) => { for (const m of text.matchAll(re)) found.add(m[1]); };
  const engine = read("engine.js"); const token = read("token.js"); const canon = read("canon.js");
  grab(engine, /deny\('([a-z_]+)'/g);
  grab(engine, /return \['([a-z_]+)', /g);
  grab(engine, /\bcode: '([a-z_]+)'/g);
  grab(token, /fail\('([a-z_]+)'/g);
  grab(canon, /bad\('([a-z_]+)'/g);
  grab(canon, /\bcode: '([a-z_]+)'/g);
  return [...found].sort();
}

describe("verdict text covers every code the engine can emit", () => {
  const codes = emittedCodes();
  it("the scan finds the codes (so an empty scan cannot pass for coverage)", () => {
    expect(codes.length).toBeGreaterThanOrEqual(45);
    for (const c of ["allowed", "scope_missing", "hold_for_approval", "token_expired", "evaluation_error", "inspection_refused", "reply_withheld", "approval_consumed", "number_not_exact"]) expect(codes).toContain(c);
  });
  it.each(codes)("%s has plain text that is a sentence, not the code", (code) => {
    const e = VERDICT_TEXT[code];
    expect(e, `no plain text for the engine code ${code}`).toBeTruthy();
    expect(e.why.length).toBeGreaterThan(20);
    expect(e.why).toMatch(/\s/);
    expect(e.why.toLowerCase()).not.toBe(code);
    expect(e.why).not.toMatch(new RegExp(`\\b${code}\\b`)); // no raw code smuggled in as the explanation
    expect(typeof e.next).toBe("string");
  });
  it("every code in the Mock table (all verticals) has text", () => {
    const seen = new Set();
    for (const v of Object.values(MOCK_TABLE.verticals)) for (const sc of v.scenarios) for (const s of sc.steps) if (s.op === "evaluate") for (const t of s.result.trace) seen.add(t.code);
    expect(seen.size).toBeGreaterThan(10);
    for (const c of seen) expect(VERDICT_TEXT[c], `Mock table code ${c}`).toBeTruthy();
  });
  it("a code the table does not know still gets a plain sentence with the layer name, and the code only as small supporting detail", () => {
    const v = verdictFor({ outcome: "deny", stage: "action", code: "zz_unheard_of", trace: [{ stage: "action", verdict: "deny", code: "zz_unheard_of", title: "3. Action scope" }] });
    expect(v.headline).toBe("Denied at Action scope");
    expect(v.why).toMatch(/no plain-language note/i);
    expect(v.why).not.toContain("zz_unheard_of");
    expect(v.code).toBe("zz_unheard_of");
  });
});

describe("layer names", () => {
  it("are the engine's titles without the stray numbers, one for every stage", () => {
    expect(Object.keys(STAGE_NAME).sort()).toEqual([...STAGES].sort());
    for (const s of STAGES) expect(STAGE_NAME[s]).toBe(STAGE_TITLE[s].replace(/^\d+\.\s*/, ""));
  });
});

describe("the numbers the text states are the engine's own", () => {
  it("argument limits and the token length", () => {
    const text = VERDICT_TEXT.arguments_too_large.why;
    for (const n of [CANON.text, CANON.values, CANON.keys, CANON.items, CANON.string]) expect(text).toContain(String(n));
    expect(VERDICT_TEXT.arguments_too_deep.why).toContain(String(CANON.depth));
    expect(VERDICT_TEXT.number_not_exact.why).toContain(String(CANON.digits));
    expect(VERDICT_TEXT.token_malformed.why).toContain(String(MAX_TOKEN));
  });
});
