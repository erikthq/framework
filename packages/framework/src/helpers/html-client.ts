// The browser build of ./html.ts, as a string.
//
// It has to be a string: `framework` cannot read its own files at runtime, and
// this is the one module that runs on both sides. Derived, never hand-edited —
// packages/tests re-derives it from html.ts and fails if the two drift.
//
// Regenerate with:
//   node -e "…stripTypes(await readFile('src/helpers/html.ts','utf8'))…"

export const HTML_CLIENT = "const HTML_ESCAPES                         = {\n  \"&\": \"&amp;\",\n  \"<\": \"&lt;\",\n  \">\": \"&gt;\",\n  '\"': \"&quot;\",\n  \"'\": \"&#39;\",\n};\n\nclass SafeString extends String {}\n\nfunction escapeValue(value         )         {\n  if (value == null) return \"\";\n  if (value instanceof SafeString) return value.toString();\n  if (Array.isArray(value)) return value.map(escapeValue).join(\"\");\n  return String(value).replace(/[&<>\"']/g, (char) => HTML_ESCAPES[char] || \"\");\n}\n\n// The one thing that counts as markup. `html` returns a SafeString rather than\n// a primitive, which is both what stops a layout escaping the page it wraps and\n// how a route says \"this is HTML\" — see defineRoute.\nexport function isSafeString(value         )                  {\n  return value instanceof SafeString;\n}\n\nexport function html(\n  strings                      ,\n  ...values           \n)         {\n  let result = strings[0];\n  for (let i = 0; i < values.length; i++) {\n    result += escapeValue(values[i]) + strings[i + 1];\n  }\n  return new SafeString(result)                     ;\n}\n"
