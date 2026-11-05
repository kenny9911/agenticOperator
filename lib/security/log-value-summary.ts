/**
 * Produce a value-free structural summary for operational logs. Business
 * payloads still travel unchanged; only the log copy loses literal values.
 */
export function summarizeLogValue(value: unknown): unknown {
  return summarize(value, 0, new WeakSet<object>());
}

function summarize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'bigint') return { type: 'bigint' };
  if (typeof value === 'symbol') return { type: 'symbol' };
  if (typeof value === 'function') return { type: 'function' };

  if (value instanceof Date) return { type: 'date' };
  if (value instanceof Uint8Array) {
    return { type: value.constructor.name, byte_length: value.byteLength };
  }
  if (seen.has(value)) return { type: 'circular' };
  if (depth >= 5) return { type: Array.isArray(value) ? 'array' : 'object', truncated: true };

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => summarize(item, depth + 1, seen));
    seen.delete(value);
    return {
      type: 'array',
      length: value.length,
      items,
      ...(value.length > items.length ? { truncated: true } : {}),
    };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const fields: Record<string, unknown> = {};
  for (const key of keys.slice(0, 50)) {
    fields[key] = summarize(record[key], depth + 1, seen);
  }
  seen.delete(value);
  return {
    type: 'object',
    keys,
    fields,
    ...(keys.length > 50 ? { truncated: true } : {}),
  };
}
