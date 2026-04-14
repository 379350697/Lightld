export function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = stableNormalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  return value;
}

export function stableStringify(value: unknown) {
  return JSON.stringify(stableNormalize(value));
}
