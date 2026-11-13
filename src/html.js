// Tagged template for page markup. Interpolated values are escaped; arrays are
// joined; values from html`` or raw() pass through unescaped. Escaping covers
// text and quoted attributes, not CSS: don't interpolate untrusted values into
// style="...".

export class Safe {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function stringify(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(stringify).join("");
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += stringify(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const raw = (s) => new Safe(String(s));
