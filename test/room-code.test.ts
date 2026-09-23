import { describe, it, expect } from 'vitest';
import { generateRoomCode, pickUniqueRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../src/utils/roomCode';
import { validRoomCode } from '../src/utils/validate';

describe('generateRoomCode', () => {
  it('长度等于 ROOM_CODE_LENGTH（5）', () => {
    const code = generateRoomCode();
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
  });

  it('所有字符都落在 ROOM_CODE_ALPHABET 内', () => {
    const alphabetSet = new Set(ROOM_CODE_ALPHABET.split(''));
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      for (const ch of code) {
        expect(alphabetSet.has(ch)).toBe(true);
      }
    }
  });

  it('字符集不含 I/O/0/1', () => {
    expect(ROOM_CODE_ALPHABET).not.toContain('I');
    expect(ROOM_CODE_ALPHABET).not.toContain('O');
    expect(ROOM_CODE_ALPHABET).not.toContain('0');
    expect(ROOM_CODE_ALPHABET).not.toContain('1');
  });

  it('注入固定 rng（() => 0）时结果确定，全取首字符', () => {
    const fixedRng = () => 0;
    const code = generateRoomCode(fixedRng);
    const firstChar = ROOM_CODE_ALPHABET[0]; // 'A'
    expect(code).toBe(firstChar.repeat(ROOM_CODE_LENGTH));
  });

  it('生成的码满足 validRoomCode', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(validRoomCode(code)).toBe(true);
    }
  });
});

describe('pickUniqueRoomCode', () => {
  it('isTaken 前两次 true、第三次 false → 返回第三次的码，调用次数 = 3', async () => {
    let generateCount = 0;
    let isTakenCount = 0;
    const codes = ['AAA', 'BBB', 'CCC'];

    const result = await pickUniqueRoomCode({
      generate: () => {
        const code = codes[generateCount] || 'ZZZ';
        generateCount++;
        return code;
      },
      isTaken: (code) => {
        isTakenCount++;
        return isTakenCount <= 2;
      },
    });

    expect(result).toBe('CCC');
    expect(generateCount).toBe(3);
  });

  it('isTaken 恒 true → 返回 null，generate 调用次数 = maxAttempts', async () => {
    let generateCount = 0;
    const maxAttempts = 5;

    const result = await pickUniqueRoomCode({
      generate: () => {
        generateCount++;
        return 'CODE' + generateCount;
      },
      isTaken: () => true,
      maxAttempts,
    });

    expect(result).toBeNull();
    expect(generateCount).toBe(maxAttempts);
  });
});
