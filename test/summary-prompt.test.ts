import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  formatPrevBlock,
  MAX_PROMPT_CHARS,
  type PrevSummary,
  type SummaryPromptInput,
} from '../src/api/summarize';

// 构造一份最小可用的素材输入，各测试按需覆盖 prev 字段
function baseInput(overrides: Partial<SummaryPromptInput> = {}): SummaryPromptInput {
  return {
    secs: 120,
    playerNames: ['爱丽丝', '鲍勃'],
    logs: [{ character_name: '爱丽丝', resource_type: 'dream', change_amount: 1, reason: '好演技' }],
    segs: [{ character_name: '鲍勃', text: '我想偷偷溜进去' }],
    prev: [],
    windowStartMs: 1_000_000,
    ...overrides,
  };
}

describe('formatPrevBlock', () => {
  it('prev 为空时返回空串', () => {
    expect(formatPrevBlock([], 1_000_000)).toBe('');
  });
});

describe('buildSummaryPrompt', () => {
  it('无前情时输出不含「前情提要」和前情指令', () => {
    const out = buildSummaryPrompt(baseInput());
    expect(out).not.toContain('前情提要');
    expect(out).not.toContain('不要复述前情内容');
  });

  it('1 条前情（endMs === windowStartMs）→ 含紧邻标签与摘要原文', () => {
    const prev: PrevSummary[] = [
      { startMs: 900_000, endMs: 1_000_000, summary: '上一段大家决定分头行动' },
    ];
    const out = buildSummaryPrompt(baseInput({ prev }));
    expect(out).toContain('【前情提要】');
    expect(out).toContain('紧邻上一时段');
    expect(out).toContain('上一段大家决定分头行动');
  });

  it('3 条前情（间隔 2 分钟）按时间正序出现，标签正确', () => {
    const T = 1_000_000;
    const prev: PrevSummary[] = [
      { startMs: T - 360_000, endMs: T - 240_000, summary: 'AAA-4分钟前' },
      { startMs: T - 240_000, endMs: T - 120_000, summary: 'BBB-2分钟前' },
      { startMs: T - 120_000, endMs: T, summary: 'CCC-紧邻' },
    ];
    const out = buildSummaryPrompt(baseInput({ prev, windowStartMs: T }));
    expect(out).toContain('约 4 分钟前');
    expect(out).toContain('约 2 分钟前');
    expect(out).toContain('紧邻上一时段');
    // 断言时间正序：旧的在前
    const idxOld = out.indexOf('AAA-4分钟前');
    const idxMid = out.indexOf('BBB-2分钟前');
    const idxNew = out.indexOf('CCC-紧邻');
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThan(idxOld);
    expect(idxNew).toBeGreaterThan(idxMid);
  });

  it('字数上限：3 条各 400 字的前情只保留最新的 1 条', () => {
    const T = 1_000_000;
    const longText = (tag: string) => tag.repeat(400); // 400 字符
    const prev: PrevSummary[] = [
      { startMs: T - 360_000, endMs: T - 240_000, summary: longText('旧') },
      { startMs: T - 240_000, endMs: T - 120_000, summary: longText('中') },
      { startMs: T - 120_000, endMs: T, summary: longText('新') },
    ];
    const out = buildSummaryPrompt(baseInput({ prev, windowStartMs: T }));
    // 最新的保留
    expect(out).toContain(longText('新'));
    // 最旧两条被截掉
    expect(out).not.toContain(longText('旧'));
    expect(out).not.toContain(longText('中'));
  });

  it('前情指令句仅在有前情时出现', () => {
    const without = buildSummaryPrompt(baseInput());
    expect(without).not.toContain('不要复述前情内容');
    const with1: PrevSummary[] = [
      { startMs: 900_000, endMs: 1_000_000, summary: '前情' },
    ];
    const withPrev = buildSummaryPrompt(baseInput({ prev: with1 }));
    expect(withPrev).toContain('不要复述前情内容');
  });

  it('基本块完整性：含【游戏操作】、【语音记录】、玩家角色名、梦点 +1', () => {
    const out = buildSummaryPrompt(baseInput());
    expect(out).toContain('【游戏操作】');
    expect(out).toContain('【语音记录】');
    expect(out).toContain('参与玩家的角色名：爱丽丝、鲍勃');
    expect(out).toContain('梦点 +1');
    expect(out).toContain('[鲍勃] 我想偷偷溜进去');
  });

  it(`整体长度不超过 MAX_PROMPT_CHARS（${MAX_PROMPT_CHARS}）`, () => {
    const T = 1_000_000;
    const prev: PrevSummary[] = [
      { startMs: T - 120_000, endMs: T, summary: '一段前情' },
    ];
    const out = buildSummaryPrompt(baseInput({ prev }));
    expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(out.length).toBeLessThanOrEqual(8000);
  });

  // 无前情路径必须与「加前情之前」的 prompt 逐字一致：这是首次摘要（每个房间的第一条）
  // 走的分支，任何差池都会改变全体既有房间的首条摘要行为。golden 字面量锁死。
  it('无前情时 prompt 与旧版逐字一致（golden）', () => {
    expect(buildSummaryPrompt(baseInput())).toBe(
      [
        '下面是《夕妖晚谣》TRPG 跑团最近约 120 秒的语音转写和游戏操作记录。',
        '请用 2-3 句简体中文总结这段时间发生了什么。重点写：剧情推进、判定的成败、资源变化、牵绊或阶段变化。',
        '只写记录里出现的事实，不要编造，不要评价好坏。如果内容太少，就写「这段时间没有实质进展」。',
        '参与玩家的角色名：爱丽丝、鲍勃（提到这些名字时指的是玩家角色本人）。',
        '【游戏操作】',
        '- 爱丽丝 梦点 +1（好演技）',
        '【语音记录】',
        '- [鲍勃] 我想偷偷溜进去',
      ].join('\n')
    );
  });
});
