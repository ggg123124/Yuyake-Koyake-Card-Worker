import { describe, it, expect } from 'vitest';
import { isHallucination, dropReason, toAbsoluteSegments } from '../src/api/transcript';

// 纯函数单测：不连网、不跑 Workers AI。
// 用例来自 2026-10-01 房间 SVS3C 真实入库的串（837 条里 15 条含 U+FFFD，另有约 15 条幻觉）。

// 必须全部判为幻觉 / 被丢弃
const BAD: Array<[string, string]> = [
  ['非法字节 + 词表回声', '术语\uFFFD涵\uFFFD涵\uFFFD涵\uFFFD'],
  ['非法字节 + 连续复读 + 谚文', '决定 决定 决定 决定 决定 决定 加 两 대\uFFFD。。。'],
  ['日语假名幻觉①', '以上で終わりたいと思います'],
  ['日语假名幻觉②', 'フラーを変えます。'],
  ['连续复读（短语重复 ≥4 次）', '但是但是但是但是但是跑团外的事。'],
  ['非法字节 + 词表回声 + 单字刷屏', '术语\uFFFD义世、变化、雅雅雅雅雅雅雅雅雅雅雅雅雅雅雅雅雅雅雅雅'],
];

// 正常中文句，绝不能误杀
const GOOD: string[] = [
  '而就在此时,我们的第一幕,荒唐之旅,就此结束。',
  '先不说那个为什么你作为人类你会在这里啊',
];

describe('事故真实串：dropReason 全部丢弃', () => {
  for (const [label, text] of BAD) {
    it(`${label} → 丢弃`, () => {
      const dr = dropReason(text);
      console.log(`[filter] 丢弃 reason=${dr} text=${JSON.stringify(text)}`);
      expect(dr).not.toBeNull();
    });
  }
});

describe('正常中文句：不误杀', () => {
  for (const text of GOOD) {
    it(`保留：${text}`, () => {
      expect(dropReason(text)).toBeNull();
      expect(isHallucination(text)).toBe(false);
    });
  }
});

describe('isHallucination：各条规则', () => {
  it('非法字节由 dropReason=illegal-byte 拦下（不进 isHallucination 也不入库）', () => {
    expect(dropReason('术语\uFFFD涵')).toBe('illegal-byte');
    expect(dropReason('你们临走时ＢＢＢ\uFFFD')).toBe('illegal-byte');
    // 不含 U+FFFD 时不算非法字节
    expect(dropReason('而就在此时,我们的第一幕,就此结束。')).not.toBe('illegal-byte');
  });

  it('词表回声：以「术语」开头且（去空白 <40 字 或 命中内置术语 ≥3）', () => {
    expect(isHallucination('术语')).toBe(true); // 短回声
    expect(isHallucination('术语涉世变化野性')).toBe(true); // 命中 ≥3 个内置术语
    // 以「术语」开头但很长且命中很少 → 仍按 <40 规则之外的分支处理；这里验证「长且命中≥3」也判真
    const longEcho = '术语' + '涉世变化野性童真心意点梦点奇迹点回忆牵绊判定'.repeat(2);
    expect(isHallucination(longEcho)).toBe(true);
  });

  it('假名/西里尔幻觉：非空白 ≥4 且占比 ≥0.5', () => {
    expect(isHallucination('以上で終わりたいと思います')).toBe(true);
    expect(isHallucination('フラーを変えます。')).toBe(true);
    expect(isHallucination('Привет мир это тест')).toBe(true); // 西里尔
    // 中文里夹一个假名（占比低）不算
    expect(isHallucination('我们接下来どうする？先看地图')).toBe(false);
  });

  it('连续复读：去空白与标点后 (.{2,4})\\1{3,}', () => {
    expect(isHallucination('但是但是但是但是但是跑团外的事。')).toBe(true);
    expect(isHallucination('决定决定决定决定加两点')).toBe(true);
  });

  it('保留的旧规则：空串/纯标点、字幕套话、单字复读、整句复读', () => {
    expect(isHallucination('')).toBe(true);
    expect(isHallucination('。。。')).toBe(true);
    expect(isHallucination('请点赞订阅转发')).toBe(true);
    expect(isHallucination('啊啊啊啊啊啊')).toBe(true); // 单字复读
    expect(isHallucination('哈哈哈哈哈哈')).toBe(true);
    expect(isHallucination('谢谢观看')).toBe(true);
  });
});

describe('toAbsoluteSegments：相对偏移 → 绝对毫秒', () => {
  const baseMs = Date.parse('2026-10-01T20:10:00Z');

  it('out[i].startMs === baseMs + in[i].startMs（endMs / text 同理）', () => {
    const input = [
      { startMs: 0, endMs: 1200, text: '第一句' },
      { startMs: 1500, endMs: 3000, text: '第二句' },
      { startMs: 4200, endMs: 6800, text: '第三句' },
    ];
    const out = toAbsoluteSegments(input, baseMs);
    expect(out.length).toBe(input.length);
    out.forEach((o, i) => {
      expect(o.startMs).toBe(baseMs + input[i].startMs);
      expect(o.endMs).toBe(baseMs + input[i].endMs);
      expect(o.text).toBe(input[i].text);
    });
    console.log('[abs] baseMs=', baseMs, 'out=', JSON.stringify(out));
  });

  it('空数组 → 空数组（不产生广播）', () => {
    expect(toAbsoluteSegments([], baseMs)).toEqual([]);
  });
});
