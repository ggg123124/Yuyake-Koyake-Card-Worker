// 去掉易混字符 I/O/0/1，念给朋友听也不容易听错
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

export function generateRoomCode(rng: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.floor(rng() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

export async function pickUniqueRoomCode(opts: {
  generate: () => string;
  isTaken: (code: string) => boolean | Promise<boolean>;
  maxAttempts?: number;
}): Promise<string | null> {
  const { generate, isTaken, maxAttempts = 8 } = opts;
  for (let i = 0; i < maxAttempts; i++) {
    const code = generate();
    if (!(await isTaken(code))) {
      return code;
    }
  }
  return null;
}
