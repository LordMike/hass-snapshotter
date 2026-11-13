// Tagged template for page markup. Interpolated values are escaped; arrays are
// joined; values from html`` or raw() pass through unescaped.

const SAFE = Symbol("safe");

class Safe {
  constructor(value) {
    this[SAFE] = value;
  }
  toString() {
    return this[SAFE];
  }
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function stringify(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Safe) return value[SAFE];
  if (Array.isArray(value)) return value.map(stringify).join("");
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += stringify(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const raw = (s) => new Safe(String(s));
