/**
 * Turns TypeScript into browser-ready JavaScript by erasing the types, with
 * no dependencies and no platform builtins — a drop-in replacement for
 * Node's `stripTypeScriptTypes`, so `scripts/` works on any runtime.
 *
 * ## The contract: erase in place, never rewrite
 *
 * Every character this removes is replaced by a space, and line terminators
 * inside a removed range are kept. So the output is exactly as long as the
 * input, and every surviving character keeps its original offset:
 *
 *   const x: string = "a";
 *   const x         = "a";
 *
 * That's what makes this safe without source maps — a stack trace from the
 * browser points at the right line *and* column of the original file. It's
 * also what makes the job tractable: nothing is ever generated or moved, so
 * the whole problem reduces to deciding which ranges are types.
 *
 * ## What it refuses
 *
 * Types are erasable; anything that needs code *generated* is not. Enums,
 * namespaces, parameter properties (`constructor(private x)`), `import x =
 * require()` and `export =` all mean "emit something that wasn't written",
 * so they throw, naming the construct and its line. This matches Node
 * deliberately: supporting them would need a real compiler behind it, and a
 * browser script has no business using them.
 *
 * Old-style `<Type>expr` assertions also throw — in a `.ts` file they're
 * indistinguishable from JSX, which is why TypeScript itself asks for
 * `expr as Type` here.
 *
 * ## Shape
 *
 * A hand-written lexer, then one forward pass over the tokens collecting
 * ranges to blank. There's no AST: the pass carries just enough context — a
 * stack of bracket frames, and whether an expression could end here — to
 * answer the three questions that actually matter. All three are ambiguous
 * in TypeScript, and none can be settled by pattern-matching text:
 *
 *   - is this `:` an annotation, or an object key / ternary / label?
 *   - is this `<` a type argument list, or a less-than?
 *   - is this `?` an optional marker, or a ternary?
 */

/** Thrown for syntax that can't be erased — see the module header. */
export class StripTypesError extends SyntaxError {
  /** 1-based line in the source. */
  readonly line: number;
  /** 1-based column. */
  readonly column: number;

  constructor(message: string, source: string, offset: number, fileName?: string) {
    const upTo = source.slice(0, offset);
    const line = upTo.split("\n").length;
    const column = offset - (upTo.lastIndexOf("\n") + 1) + 1;
    super(`${message} (${fileName ?? "<anonymous>"}:${line}:${column})`);
    this.name = "StripTypesError";
    this.line = line;
    this.column = column;
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind = "ident" | "punct" | "string" | "number" | "template" | "regex";

interface Token {
  kind: TokenKind;
  /** Offset of the first character. */
  start: number;
  /** Offset one past the last character. */
  end: number;
  /**
   * The source text — for identifiers, keywords and punctuators, the only
   * kinds anything downstream compares. Literals get `""`, since nothing
   * ever looks inside one.
   */
  text: string;
  /** A line terminator sits between this token and the one before it. */
  nl: boolean;
  /**
   * Template chunk only: it ended at `${`, so an expression follows. Lets
   * the pass treat `` `a${ `` as "an expression may start here" and
   * `` }b` `` as "an expression just ended", which is what the regex and
   * generics heuristics need.
   */
  open: boolean;
}

/**
 * Punctuators, longest first so `=>` wins over `=`.
 *
 * `<` and `>` deliberately have no compound forms here — no `<<`, `>>`,
 * `>=`. Both are always single tokens, because the type grammar needs to
 * match them as brackets: `Array<Array<number>>` ends in two closers, not
 * one shift operator. Lexing `a >>= b` as `>`, `>`, `=` costs nothing,
 * since this never evaluates an expression — it only delimits types.
 */
const PUNCTUATORS = [
  "...",
  "=>",
  "===",
  "!==",
  "**=",
  "&&=",
  "||=",
  "??=",
  "==",
  "!=",
  "**",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "~",
  "!",
  "?",
  ":",
  ";",
  ",",
  ".",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  "@",
];

const LINE_TERMINATORS = "\n\r  ";

/**
 * Keywords that can't end an expression, so a `/` after one begins a
 * regular expression rather than a division. `return /a/.test(x)` needs
 * this, and so does `typeof /a/`.
 */
const NOT_EXPRESSION_END = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "extends",
  "default",
  "const",
  "let",
  "var",
  "function",
  "class",
  "if",
  "while",
  "for",
  "switch",
  "catch",
  "with",
  "as",
  "satisfies",
  "keyof",
  "readonly",
  "infer",
  "is",
]);

/**
 * Whether a statement could end at this token — the precondition for an
 * automatic semicolon. Beyond expression enders, a `>` counts: it closes a
 * type argument list, as at the end of `declare const x: Foo<Bar>`.
 */
function canEndStatement(token: Token | undefined): boolean {
  // `void` is the one type name that can't end an *expression* but can end a
  // type, as in `declare function f(): void` with no semicolon after it.
  return endsExpression(token) || token?.text === ">" || token?.text === "void";
}

/** Whether a token could be an expression's last one. Drives regex-vs-division, postfix `!`, and generics-vs-comparison. */
function endsExpression(token: Token | undefined): boolean {
  if (token === undefined) return false;
  switch (token.kind) {
    case "ident":
      return !NOT_EXPRESSION_END.has(token.text);
    case "number":
    case "string":
    case "regex":
      return true;
    case "template":
      // `` `a` `` and `` }a` `` close the literal; `` `a${ `` does not.
      return !token.open;
    default:
      return ([")", "]", "}", "++", "--"] as string[]).includes(token.text);
  }
}

/**
 * Source text to tokens, dropping whitespace and comments.
 *
 * Comments need no representation: they're only ever erased along with a
 * surrounding range, and blanking a range blanks whatever text is inside it.
 */
function tokenize(source: string, fileName: string | undefined): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let nl = false;

  const push = (kind: TokenKind, start: number, end: number, text = "", open = false) => {
    tokens.push({ kind, start, end, text, nl, open });
    nl = false;
  };
  const fail = (message: string, offset: number): never => {
    throw new StripTypesError(message, source, offset, fileName);
  };

  // A `#!` line is valid only at offset 0, and is left exactly as it is.
  if (source.startsWith("#!")) {
    while (i < source.length && !LINE_TERMINATORS.includes(source[i]!)) i++;
  }

  // Brace depths at which each open template literal is waiting to resume,
  // so a `}` closing an object inside `${…}` isn't mistaken for the one
  // resuming the template.
  const templateDepths: number[] = [];
  let braceDepth = 0;

  /** Scans a template chunk from a backtick or `}` to `${` or the closing backtick. */
  const templateChunk = (start: number): number => {
    let j = start + 1;
    while (j < source.length) {
      const ch = source[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "`") {
        push("template", start, j + 1);
        return j + 1;
      }
      if (ch === "$" && source[j + 1] === "{") {
        templateDepths.push(braceDepth);
        braceDepth++;
        push("template", start, j + 2, "", true);
        return j + 2;
      }
      if (LINE_TERMINATORS.includes(ch)) nl = true;
      j++;
    }
    return fail("Unterminated template literal", start);
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (LINE_TERMINATORS.includes(ch)) {
      nl = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && !LINE_TERMINATORS.includes(source[i]!)) i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      // A block comment can carry a line break, which matters for the few
      // newline-sensitive decisions further down.
      for (let j = i; j < end; j++) if (LINE_TERMINATORS.includes(source[j]!)) nl = true;
      i = end;
      continue;
    }

    if (ch === "`") {
      i = templateChunk(i);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i >= source.length) return fail("Unterminated string literal", start);
      push("string", start, i + 1);
      i++;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const start = i;
      const isHex = /^0[xXbBoO]/.test(source.slice(i, i + 2));
      i++;
      while (i < source.length && /[0-9a-zA-Z_.]/.test(source[i]!)) {
        // An exponent's sign belongs to the literal; a following `-` doesn't.
        if (!isHex && /[eE]/.test(source[i]!) && /[+-]/.test(source[i + 1] ?? "")) i++;
        i++;
      }
      push("number", start, i);
      continue;
    }

    // `#field` lexes as one identifier, so a private member reads like any
    // other name to everything downstream.
    if (/[$_]/.test(ch) || /\p{ID_Start}/u.test(ch) || (ch === "#" && /[$_\p{ID_Start}]/u.test(source[i + 1] ?? ""))) {
      const start = i;
      i++;
      while (i < source.length && /[$_‌‍\p{ID_Continue}]/u.test(source[i]!)) i++;
      push("ident", start, i, source.slice(start, i));
      continue;
    }

    // Regex or division, settled by whether an expression just ended.
    if (ch === "/" && !endsExpression(tokens[tokens.length - 1])) {
      const start = i;
      i++;
      let inClass = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (LINE_TERMINATORS.includes(c)) return fail("Unterminated regular expression", start);
        i++;
      }
      // The loop above stops *at* the closing `/`; reaching the end instead
      // means there wasn't one.
      if (i >= source.length) return fail("Unterminated regular expression", start);
      i++;
      while (i < source.length && /[a-z]/.test(source[i]!)) i++;
      push("regex", start, i);
      continue;
    }

    if (ch === "}" && templateDepths[templateDepths.length - 1] === braceDepth - 1) {
      templateDepths.pop();
      braceDepth--;
      i = templateChunk(i);
      continue;
    }

    const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i));
    if (punct === undefined) return fail(`Unexpected character ${JSON.stringify(ch)}`, i);
    if (punct === "{") braceDepth++;
    else if (punct === "}") braceDepth--;
    push("punct", i, i + punct.length, punct);
    i += punct.length;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Where a type ends
// ---------------------------------------------------------------------------

/*
 * The one piece of real grammar this needs. It's a recursive descent rather
 * than a scan-to-terminator because of `=>`:
 *
 *   let f: (a: number) => void;     the `=>` is part of the type
 *   const f = (): string => "a";    the `=>` is the arrow function's
 *
 * A flat scan can't tell those apart. A recursive one can, because `=>` only
 * continues a type when the operand before it was a parameter list — which
 * is exactly what `scanTypeOperand` knows and a terminator set doesn't.
 *
 * Every function here takes a token index and returns the index just past
 * what it consumed, or -1 for "that isn't a type". Mutually recursive, so
 * they read as one unit.
 */

/** Tokens that can begin a type — used to sanity-check a `:` before committing to erasing. */
const TYPE_START = new Set([
  "{",
  "[",
  "(",
  "<",
  "|",
  "&",
  "-",
  "typeof",
  "keyof",
  "readonly",
  "new",
  "abstract",
  "infer",
  "unique",
  "import",
  "asserts",
  "void",
  "null",
  "this",
]);

const TYPE_PREFIXES = ["keyof", "typeof", "readonly", "infer", "unique", "abstract", "asserts"];

const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

function textAt(tokens: Token[], i: number): string {
  return tokens[i]?.text ?? "";
}

function kindAt(tokens: Token[], i: number): TokenKind | "" {
  return tokens[i]?.kind ?? "";
}

/**
 * Skips a bracketed run, returning the index after its closer, or -1 if it
 * doesn't balance. All four bracket kinds nest, so a function type inside
 * type arguments (`Array<(a) => b>`) is handled without special-casing.
 */
function scanBracketed(tokens: Token[], i: number): number {
  const closer = BRACKET_PAIRS[textAt(tokens, i)];
  if (closer === undefined) return -1;

  const stack = [closer];
  for (let j = i + 1; j < tokens.length; j++) {
    if (kindAt(tokens, j) !== "punct") continue;
    const text = textAt(tokens, j);

    if (BRACKET_PAIRS[text] !== undefined) {
      stack.push(BRACKET_PAIRS[text]!);
      continue;
    }
    if (([")", "]", "}", ">"] as string[]).includes(text)) {
      // A `>` that doesn't match is just a greater-than, which means the run
      // this was asked to skip never balances at all.
      if (stack[stack.length - 1] !== text) return -1;
      stack.pop();
      if (stack.length === 0) return j + 1;
      continue;
    }
    // A `;` can't appear inside type arguments, so finding one proves the
    // `<` was a comparison. Object and function types may contain one, hence
    // the check only while the innermost bracket is `<`.
    if (text === ";" && stack[stack.length - 1] === ">") return -1;
  }
  return -1;
}

/** The index after the type starting at `i`, or -1. */
function scanType(tokens: Token[], i: number): number {
  let j = scanTypeUnion(tokens, i);
  if (j === -1) return -1;

  // A conditional type, and the `x is T` / `asserts x is T` predicates — all
  // of which continue a type that already looked finished.
  while (textAt(tokens, j) === "extends" || textAt(tokens, j) === "is") {
    const conditional = textAt(tokens, j) === "extends";
    j = scanTypeUnion(tokens, j + 1);
    if (j === -1) return -1;
    if (conditional && textAt(tokens, j) === "?") {
      j = scanType(tokens, j + 1);
      if (j === -1 || textAt(tokens, j) !== ":") return -1;
      j = scanType(tokens, j + 1);
      if (j === -1) return -1;
    }
  }
  return j;
}

function scanTypeUnion(tokens: Token[], i: number): number {
  let j = i;
  if (textAt(tokens, j) === "|" || textAt(tokens, j) === "&") j++;
  j = scanTypeOperand(tokens, j);
  if (j === -1) return -1;
  while (textAt(tokens, j) === "|" || textAt(tokens, j) === "&") {
    j = scanTypeOperand(tokens, j + 1);
    if (j === -1) return -1;
  }
  return j;
}

function scanTypeOperand(tokens: Token[], i: number): number {
  let j = i;

  // Prefix operators only decorate whatever type follows them.
  while (TYPE_PREFIXES.includes(textAt(tokens, j))) j++;
  if (textAt(tokens, j) === "new") j++;

  // A function type's own type parameters: `<T>(x: T) => T`.
  if (textAt(tokens, j) === "<") {
    const after = scanBracketed(tokens, j);
    if (after === -1) return -1;
    j = after;
  }

  if (textAt(tokens, j) === "(") {
    const after = scanBracketed(tokens, j);
    if (after === -1) return -1;
    // The `=>` test this whole file is shaped around: a parameter list
    // followed by `=>` is a function type, and its return type continues the
    // type. Otherwise the parentheses merely grouped one.
    if (textAt(tokens, after) === "=>") return scanType(tokens, after + 1);
    return scanTypePostfix(tokens, after);
  }

  if (textAt(tokens, j) === "{" || textAt(tokens, j) === "[") {
    const after = scanBracketed(tokens, j);
    return after === -1 ? -1 : scanTypePostfix(tokens, after);
  }

  if (kindAt(tokens, j) === "template") {
    // A template literal type can interpolate types, and the lexer split it
    // into chunks — walk to the one that closes it.
    let depth = 0;
    for (let k = j; k < tokens.length; k++) {
      if (kindAt(tokens, k) !== "template") continue;
      if (tokens[k]!.open) depth++;
      else if (--depth <= 0) return scanTypePostfix(tokens, k + 1);
    }
    return -1;
  }

  if (kindAt(tokens, j) === "string" || kindAt(tokens, j) === "number") return scanTypePostfix(tokens, j + 1);
  if (textAt(tokens, j) === "-" && kindAt(tokens, j + 1) === "number") return scanTypePostfix(tokens, j + 2);

  if (kindAt(tokens, j) === "ident") {
    j++;
    // `import("./a.ts").Foo` — the only type that takes an argument list.
    if (textAt(tokens, j) === "(") {
      const after = scanBracketed(tokens, j);
      if (after === -1) return -1;
      j = after;
    }
    while (textAt(tokens, j) === "." && kindAt(tokens, j + 1) === "ident") j += 2;
    if (textAt(tokens, j) === "<") {
      const after = scanBracketed(tokens, j);
      if (after === -1) return -1;
      j = after;
    }
    return scanTypePostfix(tokens, j);
  }

  return -1;
}

/** Trailing `[]` and `[K]` — array and indexed-access suffixes. */
function scanTypePostfix(tokens: Token[], i: number): number {
  let j = i;
  while (textAt(tokens, j) === "[") {
    const after = scanBracketed(tokens, j);
    if (after === -1) return j;
    j = after;
  }
  return j;
}

/**
 * A type *parameter* list at `i`, or -1 — `<T>`, `<T extends U = V>`,
 * `<const T, in out U>`.
 *
 * Distinct from a type argument list, which is a plain list of types: a
 * parameter carries an optional bound and default, so `<T = any>` is a
 * parameter list and not an argument one.
 */
function scanTypeParameters(tokens: Token[], i: number): number {
  if (textAt(tokens, i) !== "<") return -1;
  if (textAt(tokens, i + 1) === ">") return i + 2;

  let j = i + 1;
  for (;;) {
    // Variance and `const` modifiers, which only parameters can carry.
    while (["const", "in", "out"].includes(textAt(tokens, j))) j++;
    if (kindAt(tokens, j) !== "ident") return -1;
    j++;
    if (textAt(tokens, j) === "extends") {
      j = scanType(tokens, j + 1);
      if (j === -1) return -1;
    }
    if (textAt(tokens, j) === "=") {
      j = scanType(tokens, j + 1);
      if (j === -1) return -1;
    }
    if (textAt(tokens, j) === ",") {
      j++;
      if (textAt(tokens, j) === ">") return j + 1;
      continue;
    }
    return textAt(tokens, j) === ">" ? j + 1 : -1;
  }
}

/**
 * A type argument list at `i`, or -1.
 *
 * The caller decides what a success means, because `<` is where TypeScript
 * is most ambiguous: `a < b > (c)` is a generic call while `a < b > c` is two
 * comparisons, and the only thing separating them is the token after the
 * `>`. So this reports "these tokens could be type arguments" and nothing
 * more.
 */
function scanTypeArguments(tokens: Token[], i: number): number {
  if (textAt(tokens, i) !== "<") return -1;
  if (textAt(tokens, i + 1) === ">") return i + 2; // `f<>()` is legal, and erasable

  let j = i + 1;
  for (;;) {
    j = scanType(tokens, j);
    if (j === -1) return -1;
    if (textAt(tokens, j) === ",") {
      j++;
      if (textAt(tokens, j) === ">") return j + 1; // a trailing comma, as in `<T,>`
      continue;
    }
    return textAt(tokens, j) === ">" ? j + 1 : -1;
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * What an open bracket means — which is what separates a type annotation
 * from an object key or a ternary.
 *
 * `params` is the one that earns its keep: inside it `x?: T` is an optional
 * parameter, while the same characters inside `call` are a ternary.
 * `ternary` counts `?`s still waiting for their `:`, so both can coexist —
 * `f(a ? b : c)` and `(a?: T)` fall out of the same rules.
 */
interface Frame {
  kind: "block" | "object" | "class" | "params" | "call" | "index" | "specifiers";
  /** Open `?`s awaiting a `:`. */
  ternary: number;
  /** A `case`/`default` is waiting for the `:` ending its label. */
  pendingCase: boolean;
  /** This paren belonged to `if`/`while`/`for`/…, so a `{` after it opens a block. */
  control: boolean;
}

const CONTROL_KEYWORDS = ["if", "while", "for", "switch", "catch", "with"];

/** Class member modifiers. All are type-only except `static` and `accessor`, which are real JavaScript. */
const CLASS_MODIFIERS = new Set(["public", "private", "protected", "readonly", "abstract", "override", "declare"]);

/** Keywords that can precede a member's name without being the name itself. */
const MEMBER_PREFIXES = new Set(["get", "set", "async", "static", "accessor"]);

/** On a constructor parameter, these make it a parameter property — which needs generated code. */
const PARAMETER_PROPERTY_MODIFIERS = new Set(["public", "private", "protected", "readonly", "override"]);

/** Keywords that may follow `declare`, so a variable *named* `declare` isn't mistaken for the modifier. */
const DECLARABLE = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "abstract",
  "async",
  "enum",
  "namespace",
  "module",
  "global",
  "interface",
  "type",
]);

/**
 * Tokens that can't begin a statement, so a line break before one is not an
 * automatic semicolon — it's a wrapped continuation of the current
 * declaration.
 */
const CONTINUATIONS = new Set([
  "|",
  "&",
  "from",
  "=",
  "extends",
  "implements",
  ",",
  ".",
  "?",
  ":",
  "=>",
  "is",
  "as",
  "satisfies",
  "in",
  "of",
  "keyof",
  "typeof",
  "&&",
  "||",
  "??",
  ")",
  "]",
  "}",
  ">",
]);

/**
 * Tokens proving an `import`/`export` introduced a declaration rather than a
 * specifier list, so a following `{` is an object or a body.
 */
const ENDS_IMPORT_CLAUSE = new Set([";", "=", "(", "=>", "const", "let", "var", "function", "class", "default", "abstract", "async", "enum", "interface", "namespace"]);

/**
 * Class field names that would become modifiers if their annotation simply
 * vanished. `get`, `set` and `static` are exactly the member modifiers the
 * grammar allows a line break after, so
 *
 *   class C { set: T
 *             m() {} }
 *
 * would silently turn into a setter named `m`. Erasing writes a `;` over the
 * `:` to keep the field a field.
 */
const ASI_HAZARD_NAMES = new Set(["get", "set", "static"]);

/** `declare` forms whose body is part of the declaration, and so ends it. */
const DECLARE_WITH_BODY = ["class", "namespace", "module", "global", "enum", "interface"];

/*
 * Blanks are chosen to match the erased character's *UTF-8* width, not just
 * its UTF-16 one: U+0020 for one byte, U+00A0 for two, U+2002 for three.
 * All are JavaScript whitespace, so the result parses identically.
 *
 * Preserving UTF-16 length alone would be enough for browser line/column
 * numbers, which is what a stack trace reports. Byte offsets are kept too
 * because they cost nothing here and any tool that indexes the source as
 * bytes — most non-JavaScript ones — then lines up as well.
 */

export interface StripTypesOptions {
  /** Used only in error messages, so a failure points at a file. */
  fileName?: string;
}

/**
 * Erases TypeScript syntax from `source`, returning JavaScript of exactly
 * the same length, with every surviving character at its original offset.
 *
 * Throws `StripTypesError` for syntax that can't be erased without
 * generating code — see the module header.
 */
export function stripTypes(source: string, options: StripTypesOptions = {}): string {
  const { fileName } = options;
  const tokens = tokenize(source, fileName);

  const at = (i: number): string => textAt(tokens, i);
  const kind = (i: number): TokenKind | "" => kindAt(tokens, i);
  const isIdent = (i: number): boolean => kind(i) === "ident";

  /** Ranges to blank, applied in one pass at the end. */
  const erasures: Array<[number, number]> = [];
  /** Offsets that get a `;` rather than a blank — see `ASI_HAZARD_NAMES`. */
  const semicolons: number[] = [];
  const erase = (from: number, to: number) => {
    if (from < 0 || to <= from || to > tokens.length) return;
    erasures.push([tokens[from]!.start, Math.min(tokens[to - 1]!.end, source.length)]);
  };
  const fail = (message: string, i: number): never => {
    throw new StripTypesError(message, source, tokens[i]?.start ?? source.length, fileName);
  };

  const pushFrame = (frameKind: Frame["kind"], control = false) => {
    frames.push({ kind: frameKind, ternary: 0, pendingCase: false, control });
  };

  // The program itself is a frame, so a top-level `a ? b : c` has somewhere
  // to record its pending `?` — without it that `:` looks like an annotation.
  const frames: Frame[] = [];
  pushFrame("block");

  /** True where a statement could begin — needed for labels, and for `{` as a block. */
  let statementStart = true;
  /** The next `(` is a parameter list: we just passed `function`, or a member name. */
  let expectParams = false;
  /** The next `{` opens a class body, so member syntax applies inside it. */
  let expectClassBody = false;
  /** Inside an `import`/`export` clause, where `{…}` is a specifier list rather than an object. */
  let inImportClause = false;
  /** Between a class's `extends` and its body, where `<…>` is type arguments rather than a comparison. */
  let inHeritage = false;
  /** The next `{` opens a function body — set after erasing a return type, which hides the `)` before it. */
  let expectBlock = false;

  /** Erases `: Type`, `as Type` or `satisfies Type` starting at the keyword, returning where to continue. */
  const eraseAnnotation = (i: number): number => {
    const end = scanType(tokens, i + 1);
    if (end === -1) return i + 1;
    erase(i, end);
    return end;
  };

  /**
   * Erases a whole statement from `i`, including its `;`.
   *
   * `stopAtBrace` picks between the two shapes: `interface A { … }` and
   * `declare global { … }` end at a closing brace, while `import type { A }
   * from "x"` has braces in the middle and ends only at the semicolon.
   */
  const eraseStatement = (i: number, stopAtBrace: boolean): number => {
    let depth = 0;
    let sawBrace = false;

    for (let j = i; j < tokens.length; j++) {
      if (kind(j) === "punct") {
        const text = at(j);
        if (text === "(" || text === "[" || text === "{") {
          depth++;
          if (text === "{") sawBrace = true;
        } else if (text === ")" || text === "]" || text === "}") {
          // A closer with nothing open belongs to the enclosing block, so the
          // statement ended just before it — `class A { abstract m(): void }`
          // has no semicolon to stop at.
          if (depth === 0) {
            erase(i, j);
            return Math.max(j, i + 1);
          }
          depth--;
          if (depth === 0 && sawBrace && stopAtBrace) {
            const end = at(j + 1) === ";" ? j + 2 : j + 1;
            erase(i, end);
            return end;
          }
        } else if (text === ";" && depth === 0) {
          erase(i, j + 1);
          return j + 1;
        }
      }
      // No semicolon: the statement ended at a line break (ASI) — unless the
      // next token can only be a continuation, as in a wrapped `import type
      // { … }\n  from "x"` or a leading-`|` union.
      const next = tokens[j + 1];
      const continues = next !== undefined && CONTINUATIONS.has(next.text);
      if (depth === 0 && j > i && !stopAtBrace && !continues && canEndStatement(tokens[j]) && (next === undefined || next.nl)) {
        erase(i, j + 1);
        return j + 1;
      }
    }
    erase(i, tokens.length);
    return tokens.length;
  };

  /**
   * Whether a `(` opens an arrow function's parameter list.
   *
   * Needed because `(a: number) => x` only reveals itself at the `=>`, long
   * after the `:` that has to be erased — so this looks ahead for it.
   */
  const isArrowParams = (i: number): boolean => {
    const after = scanBracketed(tokens, i);
    if (after === -1) return false;
    if (at(after) === "=>") return true;
    if (at(after) !== ":") return false;
    const end = scanType(tokens, after + 1);
    return end !== -1 && at(end) === "=>";
  };

  /**
   * Whether the signature at a `(` has no body — an overload, or an
   * `abstract`/`declare`d member. Those are erased whole: there's no
   * implementation for them to annotate.
   */
  const isBodiless = (i: number): boolean => {
    let after = scanBracketed(tokens, i);
    if (after === -1) return false;
    if (at(after) === ":") {
      const end = scanType(tokens, after + 1);
      if (end === -1) return false;
      after = end;
    }
    return at(after) === ";" || at(after) !== "{";
  };

  /**
   * The index a declaration's erasure should start from — one earlier when
   * `export` precedes it, since `export interface A {}` has to go whole.
   */
  const declarationStart = (i: number): number => {
    let start = i;
    while (at(start - 1) === "export" || at(start - 1) === "default") start--;
    return start;
  };

  /**
   * Walks back over a member's modifiers, so erasing a bodiless one takes
   * `get`/`set`/`static`/`abstract` with it rather than stranding the keyword.
   */
  const memberStartIndex = (i: number): number => {
    let start = i;
    while (start > 0 && (MEMBER_PREFIXES.has(at(start - 1)) || CLASS_MODIFIERS.has(at(start - 1)) || at(start - 1) === "*")) start--;
    return start;
  };

  /**
   * Erases a `<…>` type-parameter or type-argument list at `i`, returning
   * where to continue.
   *
   * Always past `i`, even when the list doesn't balance — every caller
   * assigns this to the loop counter, so returning `i` would spin.
   */
  const eraseTypeList = (i: number): number => {
    const end = scanBracketed(tokens, i);
    if (end === -1) return i + 1;
    erase(i, end);
    return end;
  };

  // Every branch below moves `i` forward, and the helpers it assigns from
  // guarantee as much. This is the backstop if one ever stops doing so: a
  // request that fails loudly beats a server that stops answering.
  let steps = 0;
  const stepLimit = tokens.length * 4 + 1000;

  for (let i = 0; i < tokens.length; i++) {
    if (++steps > stepLimit) fail("Internal error: type stripping made no progress", i);
    const token = tokens[i]!;
    const text = token.text;
    const prev = tokens[i - 1];
    const frame = frames[frames.length - 1];
    // A statement can also have ended at a line break, with no semicolon —
    // plenty of code omits them entirely, and `key: for (…)` there is a
    // labelled loop whose `:` must survive.
    const wasStatementStart: boolean = statementStart || (token.nl && canEndStatement(prev));
    const wasExpectingBlock = expectBlock;
    statementStart = false;
    expectBlock = false;
    if (ENDS_IMPORT_CLAUSE.has(text)) inImportClause = false;

    // ---- brackets ---------------------------------------------------------

    if (text === "(") {
      pushFrame(expectParams || isArrowParams(i) ? "params" : "call", isIdent(i - 1) && CONTROL_KEYWORDS.includes(at(i - 1)));
      expectParams = false;
      continue;
    }

    if (text === "[") {
      // An index signature (`[key: string]: T`) rather than a computed member
      // name, which holds an expression where this has `ident:`.
      if (frame?.kind === "class" && isIdent(i + 1) && at(i + 2) === ":") {
        i = eraseStatement(i, false) - 1;
        continue;
      }
      pushFrame("index");
      continue;
    }

    if (text === "{") {
      if (expectClassBody) {
        pushFrame("class");
        expectClassBody = false;
        inHeritage = false;
        statementStart = true;
      } else if (inImportClause) {
        // Checked before the block cases: an `import`/`export` keeps the
        // statement-start flag set, which would otherwise win here.
        pushFrame("specifiers");
      } else if (wasExpectingBlock || wasStatementStart || prev === undefined || at(i - 1) === "=>" || at(i - 1) === ")" || at(i - 1) === "else" || at(i - 1) === "do" || at(i - 1) === "try" || at(i - 1) === "finally") {
        pushFrame("block");
        statementStart = true;
      } else {
        pushFrame("object");
      }
      continue;
    }

    if (text === ")" || text === "]" || text === "}") {
      const closed = frames.pop();
      if (closed?.kind === "params" && at(i + 1) === ":") {
        // A return type annotation. The `{` after it opens a function body,
        // and the erased type is still in the token stream — so without this
        // flag the body would be read as an object literal and every `:`
        // inside it left alone.
        i = eraseAnnotation(i + 1) - 1;
        expectBlock = true;
        continue;
      }
      if (closed?.kind === "block" || closed?.kind === "class") statementStart = true;
      if (closed?.kind === "call" && closed.control) statementStart = true;
      continue;
    }

    // ---- constructs that can't be erased ----------------------------------

    if (text === "enum" && isIdent(i + 1)) fail("TypeScript enum is not supported", i);
    if (text === "const" && at(i + 1) === "enum") fail("TypeScript enum is not supported", i);
    if (wasStatementStart && text === "namespace" && (isIdent(i + 1) || kind(i + 1) === "string")) {
      fail("TypeScript namespace declaration is not supported", i);
    }
    if (wasStatementStart && text === "module" && (isIdent(i + 1) || kind(i + 1) === "string") && at(i + 2) === "{") {
      fail("TypeScript `module` declaration is not supported — use a plain module instead", i);
    }
    if (text === "import" && isIdent(i + 1) && at(i + 2) === "=") {
      fail("TypeScript import-equals declaration is not supported", i);
    }
    if (text === "export" && at(i + 1) === "=") fail("TypeScript export-assignment is not supported", i);
    if (frame?.kind === "params" && PARAMETER_PROPERTY_MODIFIERS.has(text) && (isIdent(i + 1) || at(i + 1) === "{" || at(i + 1) === "[")) {
      fail("TypeScript parameter property is not supported", i);
    }

    // ---- type-only declarations, erased whole -----------------------------

    if (text === "interface" && isIdent(i + 1)) {
      i = eraseStatement(declarationStart(i), true) - 1;
      statementStart = true;
      continue;
    }

    if (text === "type" && isIdent(i + 1) && (at(i + 2) === "=" || at(i + 2) === "<")) {
      // Scanned rather than statement-erased, because a union spread over
      // several lines —
      //
      //   type T =
      //     | A
      //     | B;
      //
      // — has a line break right where a naive end-of-statement guess would
      // stop, which would leave the union body behind as broken JavaScript.
      let j = at(i + 2) === "<" ? scanBracketed(tokens, i + 2) : i + 2;
      const end = j === -1 ? -1 : at(j) === "=" ? scanType(tokens, j + 1) : -1;
      if (end === -1) {
        i = eraseStatement(declarationStart(i), false) - 1;
      } else {
        const withSemicolon = at(end) === ";" ? end + 1 : end;
        erase(declarationStart(i), withSemicolon);
        i = withSemicolon - 1;
      }
      statementStart = true;
      continue;
    }

    if (text === "declare" && DECLARABLE.has(at(i + 1))) {
      // Everything a `declare` introduces is type-only, body and all — which
      // is why `declare enum` is fine where a bare `enum` is not.
      i = eraseStatement(declarationStart(i), DECLARE_WITH_BODY.includes(at(i + 1))) - 1;
      statementStart = true;
      continue;
    }

    // `import type { A } from …`, `export type { A }`, `export type * from …`
    // — but *not* `export type X = …`, which is an ordinary alias that merely
    // happens to be exported, and needs the scanned end the alias branch
    // above already computed.
    if ((text === "import" || text === "export") && at(i + 1) === "type" && !(isIdent(i + 2) && (at(i + 3) === "=" || at(i + 3) === "<"))) {
      i = eraseStatement(i, false) - 1;
      statementStart = true;
      continue;
    }

    // Neither `import` nor `export` is a statement in itself — it introduces
    // the declaration or clause that follows, which is therefore still at a
    // statement's start.
    if (text === "import" || text === "export") {
      inImportClause = true;
      statementStart = wasStatementStart;
      continue;
    }

    // `import { type A, b }` — erase only the type-only specifiers.
    if (text === "type" && isIdent(i + 1) && frame?.kind === "specifiers") {
      let end = i + 2;
      if (at(end) === "as" && isIdent(end + 1)) end += 2;
      if (at(end) === "," || at(end) === "}") {
        if (at(end) === ",") end++;
        erase(i, end);
        i = end - 1;
        continue;
      }
    }

    // ---- classes ----------------------------------------------------------

    if (text === "abstract" && at(i + 1) === "class") {
      erase(i, i + 1);
      continue;
    }

    if (text === "class") {
      expectClassBody = true;
      // `class C<T>` / `class <T>` — type parameters, not a comparison.
      const name = isIdent(i + 1) ? i + 2 : i + 1;
      if (at(name) === "<") i = eraseTypeList(name) - 1;
      continue;
    }

    if (expectClassBody && text === "extends") {
      inHeritage = true;
      continue;
    }

    if (expectClassBody && text === "implements") {
      // Erase the clause up to the class body, which a heritage list can't contain.
      let j = i + 1;
      while (j < tokens.length && at(j) !== "{") {
        const after = ["(", "[", "<"].includes(at(j)) ? scanBracketed(tokens, j) : -1;
        j = after === -1 ? j + 1 : after;
      }
      erase(i, j);
      i = j - 1;
      continue;
    }

    if (inHeritage && text === "<") {
      i = eraseTypeList(i) - 1;
      continue;
    }

    // ---- functions --------------------------------------------------------

    if (text === "function") {
      let j = i + 1;
      if (at(j) === "*") j++;
      if (isIdent(j)) j++;
      const generics = at(j) === "<" ? scanBracketed(tokens, j) : -1;
      const paren = generics === -1 ? j : generics;

      // An overload signature has no body, so nothing in it survives.
      if (at(paren) === "(" && isBodiless(paren)) {
        i = eraseStatement(declarationStart(i), false) - 1;
        statementStart = true;
        continue;
      }
      if (generics !== -1) {
        erase(j, generics);
        i = generics - 1;
      }
      expectParams = true;
      continue;
    }

    // ---- class and object members ----------------------------------------

    if (frame?.kind === "class") {
      if (CLASS_MODIFIERS.has(text) && (isIdent(i + 1) || kind(i + 1) === "string" || at(i + 1) === "[" || at(i + 1) === "*")) {
        // `declare` and `abstract` members have no runtime existence at all;
        // the rest annotate a member that does.
        if (text === "declare" || text === "abstract") {
          i = eraseStatement(i, false) - 1;
          continue;
        }
        erase(i, i + 1);
        continue;
      }

      // An index signature (`[key: string]: T`) versus a computed member
      // name, which holds an expression rather than `ident:`.
      if (text === "[" && isIdent(i + 1) && at(i + 2) === ":") {
        i = eraseStatement(i, false) - 1;
        continue;
      }
    }

    // A member name in a class or object literal, possibly generic. An
    // `abstract`/overload signature has no body and goes entirely.
    //
    // `memberStart` is what keeps this honest: a bare identifier followed by
    // `(` is a method definition only at the start of a member. Elsewhere
    // it's an ordinary call — `{ at: d.toLocaleTimeString() ? x : y }` would
    // otherwise read as a method whose `? :` was a return type.
    const memberStart = prev === undefined || ["{", ",", ";", "}", "*"].includes(at(i - 1)) || MEMBER_PREFIXES.has(at(i - 1)) || CLASS_MODIFIERS.has(at(i - 1));
    if (memberStart && (frame?.kind === "class" || frame?.kind === "object") && (isIdent(i) || kind(i) === "string" || at(i) === "]")) {
      let j = i + 1;
      if (at(j) === "?" && frame.kind === "class") j++;
      const generics = at(j) === "<" ? scanBracketed(tokens, j) : -1;
      if (generics !== -1) j = generics;
      if (at(j) === "(") {
        if (frame.kind === "class" && isBodiless(j)) {
          i = eraseStatement(memberStartIndex(i), false) - 1;
          continue;
        }
        if (generics !== -1) erase(at(i + 1) === "?" ? i + 2 : i + 1, generics);
        expectParams = true;
      }
    }

    // ---- annotations ------------------------------------------------------

    if (text === ":") {
      if (frame !== undefined && frame.ternary > 0) {
        frame.ternary--;
        continue;
      }
      if (frame?.pendingCase) {
        frame.pendingCase = false;
        statementStart = true;
        continue;
      }
      // An object literal's key, or an index signature's, keeps its colon.
      if (frame?.kind === "object" || frame?.kind === "index" || frame?.kind === "specifiers") continue;
      if (TYPE_START.has(at(i + 1)) || isIdent(i + 1) || ["string", "number", "template"].includes(kind(i + 1))) {
        // A field whose name is itself a member modifier can't be left bare:
        // see `ASI_HAZARD_NAMES`. An initializer already separates it from
        // whatever follows, so only an annotation-only field needs the `;`.
        const nameIndex = at(i - 1) === "?" || at(i - 1) === "!" ? i - 2 : i - 1;
        const end = scanType(tokens, i + 1);
        if (frame?.kind === "class" && ASI_HAZARD_NAMES.has(at(nameIndex)) && end !== -1 && at(end) !== "=") {
          semicolons.push(token.start);
        }
        i = eraseAnnotation(i) - 1;
      }
      continue;
    }

    if (text === "?") {
      const followedByTypeSlot = [":", ",", ")", "="].includes(at(i + 1));
      const boundaryBefore = endsExpression(prev) || at(i - 1) === "]";
      if (frame?.kind === "params" && followedByTypeSlot && boundaryBefore) {
        erase(i, i + 1);
        continue;
      }
      // On a member, `?` may also precede a method's `(`.
      if (frame?.kind === "class" && (followedByTypeSlot || at(i + 1) === "(" || at(i + 1) === "<") && boundaryBefore) {
        erase(i, i + 1);
        continue;
      }
      if (frame !== undefined) frame.ternary++;
      continue;
    }

    if ((text === "as" || text === "satisfies") && endsExpression(prev) && frame?.kind !== "specifiers") {
      const end = scanType(tokens, i + 1);
      if (end !== -1) {
        erase(i, end);
        i = end - 1;
      }
      continue;
    }

    // A postfix `!` — a non-null assertion, or a definite assignment on a
    // declaration. A prefix `!` can't follow the end of an expression.
    if (text === "!" && endsExpression(prev)) {
      erase(i, i + 1);
      continue;
    }

    // A `this` parameter is purely a typing device, so it goes along with
    // its annotation and the comma separating it from the real first one.
    if (text === "this" && frame?.kind === "params" && at(i - 1) === "(" && at(i + 1) === ":") {
      const end = scanType(tokens, i + 2);
      if (end !== -1) {
        const withComma = at(end) === "," ? end + 1 : end;
        erase(i, withComma);
        i = withComma - 1;
        continue;
      }
    }

    if (text === "<") {
      if (endsExpression(prev)) {
        // Type arguments to a call, or a comparison. TypeScript settles it
        // on the token after the `>`: a `(` or a template literal means the
        // whole run was a generic call.
        const end = scanTypeArguments(tokens, i);
        if (end !== -1 && (at(end) === "(" || kind(end) === "template")) {
          erase(i, end);
          i = end - 1;
          continue;
        }
        // `async <T = any>(x: T) => x` — `async` is the one identifier a
        // generic arrow can follow, so its type *parameters* are reachable
        // from here too.
        if (at(i - 1) === "async") {
          const parameters = scanTypeParameters(tokens, i);
          if (parameters !== -1 && at(parameters) === "(") {
            erase(i, parameters);
            i = parameters - 1;
          }
        }
        continue;
      }
      // Where an expression begins, `<` is a generic arrow's type
      // parameters — or an old-style assertion, which can't be erased.
      const parameters = scanTypeParameters(tokens, i);
      if (parameters !== -1 && at(parameters) === "(") {
        erase(i, parameters);
        i = parameters - 1;
        continue;
      }
      // Only an assertion if it actually parses as one; otherwise this `<` is
      // an operator whose left side merely looked unfinished, as in `a << b`.
      if (scanTypeArguments(tokens, i) !== -1) {
        fail("The `<T>expr` type-assertion syntax is not supported — use `expr as T`", i);
      }
      continue;
    }

    // ---- plain JavaScript -------------------------------------------------

    if (text === ";") {
      statementStart = true;
      continue;
    }
    if (text === "case" || (text === "default" && at(i + 1) === ":")) {
      if (frame !== undefined) frame.pendingCase = true;
      continue;
    }
    if (isIdent(i) && ["else", "do", "try", "finally"].includes(text)) {
      statementStart = true;
      continue;
    }
    // A labelled statement — `outer: for (…)`. Its colon is not an
    // annotation, and consuming both here keeps the `:` rules above simple.
    if (isIdent(i) && wasStatementStart && at(i + 1) === ":" && frame?.kind !== "class") {
      i++;
      statementStart = true;
      continue;
    }
  }

  // Apply every erasure at once. Existing whitespace is left exactly as it
  // was — not just line breaks but tabs and non-breaking spaces — and
  // everything else becomes the blank of matching width.
  const out = source.split("");
  for (const [start, end] of erasures) {
    for (let j = start; j < end; j++) {
      const ch = out[j]!;
      if (/\s/.test(ch)) continue;
      const code = ch.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff && j + 1 < end) {
        // A surrogate pair is four UTF-8 bytes across two UTF-16 units, and
        // no single whitespace character is that wide — so it takes two.
        out[j] = " ";
        out[j + 1] = "\ufeff";
        j++;
        continue;
      }
      out[j] = code < 0x80 ? " " : code < 0x800 ? "\u00a0" : "\u2002";
    }
  }
  for (const offset of semicolons) out[offset] = ";";
  return out.join("");
}
