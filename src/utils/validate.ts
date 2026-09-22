export function clampInt(
  v: unknown,
  opts: { min: number; max: number; def: number }
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return opts.def;
  const n = Math.floor(v);
  return Math.min(opts.max, Math.max(opts.min, n));
}

export function strLen(v: unknown, max: number): boolean {
  if (typeof v !== 'string') return true;
  return v.length <= max;
}

export function validRoomCode(v: string): boolean {
  return /^[A-Z0-9]{4,12}$/.test(v);
}

export function validUsername(v: string): boolean {
  return /^[A-Za-z0-9_-]{3,20}$/.test(v);
}
