const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

class SafeString extends String {}

function escapeValue(value: unknown): string {
  if (value == null) return "";
  if (value instanceof SafeString) return value.toString();
  if (Array.isArray(value)) return value.map(escapeValue).join("");
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] || "");
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    result += escapeValue(values[i]) + strings[i + 1];
  }
  return new SafeString(result) as unknown as string;
}
