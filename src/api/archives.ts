import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';

const route = new Hono<{ Bindings: Bindings; Variables: Variables }>();

route.use('*', authMiddleware);

interface ArchiveOpts {
  archivedBy: string | null;
  reason: 'manual' | 'auto_inactive';
}

interface MemberRow {
  character_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  char_name: string;
  char_true_form: string;
  dream_points: number;
  wonder_points: number;
  feeling_points: number;
  memories: number;
  attr_henge: number;
  attr_animal: number;
  attr_adult: number;
  attr_child: number;
  abilities: string | null;
  weaknesses: string | null;
  extra_abilities: string | null;
}

interface BondRow {
  id: string;
  from_character_id: string | null;
  from_character_name: string | null;
  to_character_name: string;
  to_character_id: string | null;
  bond_type: string;
  bond_level: number;
  is_intense: number;
  sort_order: number;
}

interface LogRow {
  id: number;
  created_at: string;
  character_name: string;
  resource_type: string;
  change_amount: number;
  reason: string | null;
}

function parseJsonArray(raw: string | null, fieldName: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // 归档是只读快照，坏了也继续，但必须留痕（禁止静默降级）
    console.warn(
      `[archive] json parse failed field=${fieldName} raw=${String(raw).slice(0, 80)} err=${e instanceof Error ? e.message : String(e)}`
    );
    return [];
  }
}

export async function archiveAndDeleteRoom(
  db: D1Database,
  roomId: string,
  opts: ArchiveOpts
): Promise<{ archiveId: string; memberCount: number; logCount: number; transcriptCount: number } | null> {
  const room = await db
    .prepare('SELECT id, name, phase, created_at FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{ id: string; name: string | null; phase: string; created_at: string }>();

  if (!room) return null;

  const membersResult = await db
    .prepare(
      `SELECT rm.character_id, rm.user_id, rm.role, rm.joined_at,
              c.name as char_name, c.true_form as char_true_form,
              c.dream_points, c.wonder_points, c.feeling_points, c.memories,
              c.attr_henge, c.attr_animal, c.attr_adult, c.attr_child,
              c.abilities, c.weaknesses, c.extra_abilities
       FROM room_members rm
       JOIN characters c ON rm.character_id = c.id
       WHERE rm.room_id = ?`
    )
    .bind(roomId)
    .all<MemberRow>();
  const members = membersResult.results || [];

  const bondsResult = await db
    .prepare(
      `SELECT b.id, b.from_character_id,
              COALESCE(b.from_character_name, c.name) AS from_character_name,
              b.to_character_name, b.to_character_id,
              b.bond_type, b.bond_level, b.is_intense, b.sort_order
       FROM bonds b
       LEFT JOIN characters c ON c.id = b.from_character_id
       WHERE b.room_id = ? ORDER BY b.sort_order ASC`
    )
    .bind(roomId)
    .all<BondRow>();
  const bonds = bondsResult.results || [];

  const logsResult = await db
    .prepare(
      `SELECT rl.id, rl.created_at, c.name as character_name, rl.resource_type, rl.change_amount, rl.reason
       FROM resource_logs rl
       JOIN characters c ON rl.character_id = c.id
       WHERE rl.room_code = ?
       ORDER BY rl.id ASC`
    )
    .bind(roomId)
    .all<LogRow>();
  const logs = logsResult.results || [];

  // 对话记录：VAD 实时转写的合并时间线（按校准后的绝对时间排序，天然跨人合并）
  const transcriptResult = await db
    .prepare(
      `SELECT character_name, abs_start_ms, abs_end_ms, text
       FROM transcript_segments
       WHERE room_id = ?
       ORDER BY abs_start_ms ASC, seg_index ASC`
    )
    .bind(roomId)
    .all<{ character_name: string | null; abs_start_ms: number; abs_end_ms: number; text: string }>();
  const transcripts = transcriptResult.results || [];

  // 事件摘要：LLM 每约 2 分钟汇总的一条记录（含语音 + 游戏操作）
  const summaryResult = await db
    .prepare(
      `SELECT start_ms, end_ms, summary, source_segments, source_logs
       FROM room_summaries WHERE room_id = ? ORDER BY start_ms ASC`
    )
    .bind(roomId)
    .all<{
      start_ms: number;
      end_ms: number;
      summary: string;
      source_segments: number;
      source_logs: number;
    }>();
  const summaries = summaryResult.results || [];

  const snapshot = {
    room: {
      id: room.id,
      name: room.name || '',
      phase: room.phase,
      createdAt: room.created_at,
    },
    members: members.map((m) => ({
      characterId: m.character_id,
      characterName: m.char_name,
      trueForm: m.char_true_form,
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      final: {
        dreamPoints: m.dream_points,
        wonderPoints: m.wonder_points,
        feelingPoints: m.feeling_points,
        memories: m.memories,
        attrs: {
          henge: m.attr_henge,
          animal: m.attr_animal,
          adult: m.attr_adult,
          child: m.attr_child,
        },
        abilities: parseJsonArray(m.abilities, 'abilities'),
        weaknesses: parseJsonArray(m.weaknesses, 'weaknesses'),
        extraAbilities: parseJsonArray(m.extra_abilities, 'extra_abilities'),
      },
    })),
    bonds: bonds.map((b) => ({
      id: b.id,
      fromCharacterId: b.from_character_id || '',
      fromCharacterName: b.from_character_name || '',
      toCharacterName: b.to_character_name,
      toCharacterId: b.to_character_id || '',
      bondType: b.bond_type,
      bondLevel: b.bond_level,
      isIntense: b.is_intense,
      sortOrder: b.sort_order,
    })),
    logs: logs.map((l) => ({
      id: l.id,
      createdAt: l.created_at,
      characterName: l.character_name,
      resourceType: l.resource_type,
      changeAmount: l.change_amount,
      reason: l.reason || '',
    })),
    transcripts: transcripts.map((t) => ({
      characterName: t.character_name || '',
      startMs: t.abs_start_ms,
      endMs: t.abs_end_ms,
      text: t.text,
    })),
    summaries: summaries.map((s) => ({
      startMs: s.start_ms,
      endMs: s.end_ms,
      summary: s.summary,
      sourceSegments: s.source_segments,
      sourceLogs: s.source_logs,
    })),
  };

  const archiveId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO room_archives (id, room_id, room_name, phase, room_created_at, archived_by, archive_reason, member_count, log_count, transcript_count, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      archiveId,
      room.id,
      room.name,
      room.phase,
      room.created_at,
      opts.archivedBy,
      opts.reason,
      members.length,
      logs.length,
      transcripts.length,
      JSON.stringify(snapshot)
    )
    .run();

  // 批量插入 viewers（按 user_id 去重）
  const viewerMap = new Map<string, { characterName: string; role: string }>();
  for (const m of members) {
    if (!viewerMap.has(m.user_id)) {
      viewerMap.set(m.user_id, { characterName: m.char_name, role: m.role });
    }
  }
  // 也把 archivedBy（手动销毁的 GM）加入 viewers
  if (opts.archivedBy && !viewerMap.has(opts.archivedBy)) {
    viewerMap.set(opts.archivedBy, { characterName: '', role: 'gm' });
  }

  for (const [userId, info] of viewerMap) {
    await db
      .prepare(
        'INSERT OR IGNORE INTO room_archive_viewers (archive_id, user_id, character_name, role) VALUES (?, ?, ?, ?)'
      )
      .bind(archiveId, userId, info.characterName, info.role)
      .run();
  }

  // 删除关联数据
  await db.prepare('DELETE FROM room_members WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM bonds WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM resource_logs WHERE room_code = ?').bind(roomId).run();
  await db.prepare('DELETE FROM rooms WHERE id = ?').bind(roomId).run();

  console.log(
    `[archive] room=${roomId} reason=${opts.reason} members=${members.length} logs=${logs.length} transcripts=${transcripts.length} ok`
  );

  return { archiveId, memberCount: members.length, logCount: logs.length, transcriptCount: transcripts.length };
}

// GET / - 当前用户参与过的归档列表
route.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const result = await db
    .prepare(
      `SELECT ra.id, ra.room_id, ra.room_name, ra.phase, ra.archived_at, ra.archive_reason,
              ra.member_count, ra.log_count, ra.transcript_count, rav.character_name, rav.role
       FROM room_archives ra
       JOIN room_archive_viewers rav ON ra.id = rav.archive_id
       WHERE rav.user_id = ?
       ORDER BY ra.archived_at DESC`
    )
    .bind(userId)
    .all<{
      id: string;
      room_id: string;
      room_name: string | null;
      phase: string;
      archived_at: string;
      archive_reason: string;
      member_count: number;
      log_count: number;
      transcript_count: number;
      character_name: string | null;
      role: string | null;
    }>();

  return c.json(
    (result.results || []).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      roomName: r.room_name,
      phase: r.phase,
      archivedAt: r.archived_at,
      archiveReason: r.archive_reason,
      memberCount: r.member_count,
      logCount: r.log_count,
      transcriptCount: r.transcript_count,
      myCharacterName: r.character_name,
      myRole: r.role,
    }))
  );
});

// GET /:id - 归档详情
route.get('/:id', async (c) => {
  const archiveId = c.req.param('id');
  const userId = c.get('userId');
  const db = c.env.DB;

  const archive = await db
    .prepare('SELECT * FROM room_archives WHERE id = ?')
    .bind(archiveId)
    .first<{
      id: string;
      room_id: string;
      room_name: string | null;
      phase: string;
      archived_at: string;
      archive_reason: string;
      member_count: number;
      log_count: number;
      transcript_count: number;
      snapshot: string;
    }>();

  if (!archive) {
    return c.json({ error: '归档不存在' }, 404);
  }

  const viewer = await db
    .prepare('SELECT 1 FROM room_archive_viewers WHERE archive_id = ? AND user_id = ?')
    .bind(archiveId, userId)
    .first();

  if (!viewer) {
    return c.json({ error: '无权查看该归档' }, 403);
  }

  return c.json({
    id: archive.id,
    roomId: archive.room_id,
    roomName: archive.room_name,
    phase: archive.phase,
    archivedAt: archive.archived_at,
    archiveReason: archive.archive_reason,
    memberCount: archive.member_count,
    logCount: archive.log_count,
    transcriptCount: archive.transcript_count,
    snapshot: JSON.parse(archive.snapshot),
  });
});

export default route;
