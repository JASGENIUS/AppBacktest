import { describe, expect, it } from "vitest";
import { extractJsonCandidate } from "../src/providers/openaiCompatible";
import { parseAction } from "../src/providers/actionSchema";

describe("extractJsonCandidate", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonCandidate('{"kind":"click","ref":"f0:e1"}')).toEqual({
      kind: "click",
      ref: "f0:e1",
    });
  });

  it("strips closed <think> reasoning blocks", () => {
    const raw = '<think>The user wants load 38419, e1 looks right.</think>\n{"kind":"click","ref":"e1"}';
    expect(extractJsonCandidate(raw)).toEqual({ kind: "click", ref: "e1" });
  });

  it("ignores an unclosed <think> tail (reasoning ran to the end)", () => {
    const raw = '{"kind":"back"}\n<think>hmm what next';
    expect(extractJsonCandidate(raw)).toEqual({ kind: "back" });
  });

  it("unwraps ```json fences", () => {
    const raw = 'Sure! Here is the action:\n```json\n{"kind":"wait","ms":500}\n```';
    expect(extractJsonCandidate(raw)).toEqual({ kind: "wait", ms: 500 });
  });

  it("finds the object inside prose, with braces in strings", () => {
    const raw = 'I will type the notes now. {"kind":"type","ref":"e2","text":"box {4} delivered"} Done.';
    expect(extractJsonCandidate(raw)).toEqual({
      kind: "type",
      ref: "e2",
      text: "box {4} delivered",
    });
  });

  it("skips a malformed candidate and finds a later valid one", () => {
    const raw = "{oops not json} then {\"kind\":\"scroll\",\"direction\":\"down\"}";
    expect(extractJsonCandidate(raw)).toEqual({ kind: "scroll", direction: "down" });
  });

  it("throws a readable error when no JSON exists", () => {
    expect(() => extractJsonCandidate("I would click the upload button.")).toThrow(
      /no JSON object found/,
    );
  });

  it("extracted objects flow into parseAction (the structural gate)", () => {
    const raw = '<think>ok</think>```json\n{"kind":"done","outcome":"success","summary":"uploaded"}\n```';
    expect(parseAction(extractJsonCandidate(raw))).toEqual({
      kind: "done",
      outcome: "success",
      summary: "uploaded",
    });
  });
});
