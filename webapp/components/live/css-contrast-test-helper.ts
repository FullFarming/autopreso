import postcss from "postcss";

type CssColor = readonly [red: number, green: number, blue: number, alpha: number];

function splitArguments(value: string): string[] {
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return [...parts, value.slice(start).trim()];
}

export function readCssDeclaration(css: string, selector: string, property: string): string {
  let value: string | undefined;
  postcss.parse(css).walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls(property, (declaration) => { value = declaration.value; });
    }
  });
  if (value === undefined) throw new Error(`Missing CSS declaration: ${selector} ${property}`);
  return value;
}

export function createCssColorResolver(css: string, scopes: readonly string[] = []) {
  const tokens = new Map<string, string>();
  const stylesheet = postcss.parse(css);
  for (const selector of [":root", ...scopes]) {
    stylesheet.walkRules((rule) => {
      if (rule.selectors.includes(selector)) {
        rule.walkDecls(/^--/u, (declaration) => { tokens.set(declaration.prop, declaration.value); });
      }
    });
  }

  function resolveColor(expression: string, visited: readonly string[] = []): CssColor {
    const value = expression.trim();
    const variable = /^var\((.*)\)$/su.exec(value);
    if (variable) {
      const [name = "", fallback] = splitArguments(variable[1] ?? "");
      if (visited.includes(name)) throw new Error(`Circular CSS color token: ${name}`);
      const next = tokens.get(name) ?? fallback;
      if (next === undefined) throw new Error(`Missing CSS color token: ${name}`);
      return resolveColor(next, [...visited, name]);
    }
    if (value === "transparent") return [0, 0, 0, 0];
    const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/iu.exec(value)?.[1];
    if (hex) {
      const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
      const channel = (offset: number) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
      return [channel(0), channel(2), channel(4), expanded.length === 8 ? channel(6) : 1];
    }
    const rgba = /^rgba?\(([^)]+)\)$/u.exec(value);
    if (rgba) {
      const channels = splitArguments(rgba[1] ?? "").map(Number);
      if (channels.length < 3 || channels.length > 4 || channels.some((channel) => !Number.isFinite(channel))) {
        throw new Error(`Unsupported CSS color: ${value}`);
      }
      return [(channels[0] ?? 0) / 255, (channels[1] ?? 0) / 255, (channels[2] ?? 0) / 255, channels[3] ?? 1];
    }
    const mix = /^color-mix\((.*)\)$/su.exec(value);
    if (mix) {
      const [space, first, second] = splitArguments(mix[1] ?? "");
      if (space !== "in srgb" || !first || !second) throw new Error(`Unsupported CSS color mix: ${value}`);
      const firstStop = /^(.*?)(?:\s+([\d.]+)%)?$/u.exec(first);
      const secondStop = /^(.*?)(?:\s+([\d.]+)%)?$/u.exec(second);
      const firstWeight = firstStop?.[2] === undefined
        ? 1 - Number(secondStop?.[2] ?? 50) / 100 : Number(firstStop[2]) / 100;
      const secondWeight = secondStop?.[2] === undefined ? 1 - firstWeight : Number(secondStop[2]) / 100;
      const total = firstWeight + secondWeight;
      if (total <= 0 || firstWeight < 0 || secondWeight < 0) throw new Error(`Invalid CSS color mix: ${value}`);
      const left = resolveColor(firstStop?.[1] ?? "", visited);
      const right = resolveColor(secondStop?.[1] ?? "", visited);
      const leftAlpha = left[3] * firstWeight / total;
      const rightAlpha = right[3] * secondWeight / total;
      const alpha = leftAlpha + rightAlpha;
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (left[0] * leftAlpha + right[0] * rightAlpha) / alpha,
        (left[1] * leftAlpha + right[1] * rightAlpha) / alpha,
        (left[2] * leftAlpha + right[2] * rightAlpha) / alpha,
        alpha * Math.min(total, 1),
      ];
    }
    throw new Error(`Unsupported CSS color: ${value}`);
  }
  return resolveColor;
}

export function compositeColors(foreground: CssColor, background: CssColor): CssColor {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (index: 0 | 1 | 2) => (
    foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])
  ) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

export function contrastRatio(foreground: CssColor, background: CssColor): number {
  if (background[3] !== 1) throw new Error("Composite the background onto its opaque surface before measuring contrast");
  const luminance = (color: CssColor) => {
    const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
  };
  const first = luminance(compositeColors(foreground, background));
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
