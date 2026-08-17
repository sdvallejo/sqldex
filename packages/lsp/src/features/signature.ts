/**
 * `textDocument/signatureHelp`: the signature of whatever is being called, with the argument the
 * cursor is in picked out.
 */

import type { Token } from "@sqldex/core";
import type { ParameterInformation, SignatureHelp } from "vscode-languageserver";

import type { At } from "../documents.ts";
import { builtinDoc } from "../render.ts";

/** Where the enclosing call starts, and which argument the cursor sits in. */
export interface EnclosingCall {
  /** Index of the `(` that opened it. */
  openIdx: number;
  /** 0-based index of the argument being typed. */
  active: number;
}

/**
 * The innermost call the cursor is inside.
 *
 * It walks forward carrying a stack of open parentheses rather than scanning backwards for one:
 * that way the paren on top of the stack is always the innermost still-unclosed one, which is the
 * call being typed even in a nest like `CALL f(g(1, 2), |)`. Scanning backwards would find `g`'s
 * closing paren and have to decide what to do about it.
 */
export function enclosingCall(tokens: readonly Token[], offset: number): EnclosingCall | undefined {
  const stack: { openIdx: number; commas: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.s >= offset) break;
    if (token.t !== "punct") continue;

    if (token.v === "(") stack.push({ openIdx: i, commas: 0 });
    else if (token.v === ")") stack.pop();
    else if (token.v === "," && stack.length > 0) stack[stack.length - 1]!.commas++;
  }

  const top = stack[stack.length - 1];
  return top === undefined ? undefined : { openIdx: top.openIdx, active: top.commas };
}

/**
 * A built-in's arguments, located inside its own signature text.
 *
 * The catalog stores signatures as prose — `SUBSTRING(str, from [, length])` — so the arguments are
 * found by splitting on the commas at depth one. They are handed back as offsets into the label
 * rather than as strings, which is what the protocol wants in order to highlight the right one:
 * given as text, a client searching for `x` in `POW(x, y)` would find the one in `POW` first.
 */
export function signatureParameters(signature: string): ParameterInformation[] {
  const open = signature.indexOf("(");
  if (open === -1) return [];

  const spans: [number, number][] = [];
  let depth = 0;
  let start = open + 1;

  for (let i = open; i < signature.length; i++) {
    const c = signature[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        if (i > start) spans.push([start, i]);
        break;
      }
    } else if (c === "," && depth === 1) {
      spans.push([start, i]);
      start = i + 1;
    }
  }

  return spans.map(([from, to]) => {
    // The space after a comma is not part of the argument, and highlighting it makes the underline
    // look off by one. The protocol counts UTF-16 code units from the start of the label, which for
    // these ASCII signatures is the same as counting characters.
    let at = from;
    while (signature[at] === " ") at++;
    return { label: [at, to] as [number, number] };
  });
}

/**
 * Which argument to highlight.
 *
 * With no arguments there is nothing to point at. With more commas than arguments — one argument too
 * many, which happens while typing — it stays on the last rather than pointing past the end, because
 * a highlight that vanishes reads as "you are done here" when the opposite is true.
 */
function activeParameter(active: number, count: number): number | undefined {
  return count > 0 ? Math.min(active, count - 1) : undefined;
}

export function signatureHelp(at: At): SignatureHelp | undefined {
  const tokens = at.lexed.tokens;
  const call = enclosingCall(tokens, at.offset);
  if (!call) return undefined;

  // The name of what is being called is the identifier stuck to the opening parenthesis.
  const nameToken = tokens[call.openIdx - 1];
  if (!nameToken || nameToken.t !== "id") return undefined;

  const routine = at.workspace.catalog.routine(nameToken.v);
  if (!routine) {
    const entry = at.workspace.dialect.builtin(nameToken.v);
    if (!entry) return undefined;

    const parameters = signatureParameters(entry.signature);
    return {
      signatures: [
        {
          label: entry.signature,
          documentation: { kind: "markdown", value: builtinDoc(entry) },
          parameters,
        },
      ],
      activeSignature: 0,
      activeParameter: activeParameter(call.active, parameters.length),
    };
  }

  const parameters: ParameterInformation[] = routine.params.map((param) => ({
    label: `${param.mode === "IN" ? "" : param.mode + " "}${param.name} ${param.type.raw}`,
    // An `OUT` is the one thing about a call you cannot see from the call site, and getting it wrong
    // means passing a literal to something that is going to try to write to it.
    documentation: param.mode === "IN" ? undefined : `output parameter (${param.mode})`,
  }));

  return {
    signatures: [
      {
        label: routine.signature,
        documentation: routine.doc === undefined ? undefined : { kind: "markdown", value: routine.doc },
        parameters,
      },
    ],
    activeSignature: 0,
    activeParameter: activeParameter(call.active, parameters.length),
  };
}
