import { DurableObject } from 'cloudflare:workers';
import { verifyToken } from './utils/auth';

interface Env {
  DB: D1Database;
  JWT_SECRET: string;
}

interface Session {
  userId: string;
  characterId: string;
  ws: WebSocket;
}

// WebSocket 消息类型定义
interface WSMessage {
  type: string;
  [key: string]: unknown;
}

interface WSResponse {
  type: string;
  [key: string]: unknown;
}

export class RoomDurableObject extends DurableObject<Env> {
  private sessions: Map<WebSocket, Session> = new Map();
  private roomId: string = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // 优先从 header 获取 roomId（由 Worker 注入），回退到 URL 解析
    const headerRoomId = request.headers.get('X-Room-Id');
    if (headerRoomId) {
      this.roomId = headerRoomId;
    } else {
      // 兼容：从 URL 中提取（路径格式 /rooms/{roomId}/xxx）
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        this.roomId = parts[1]; // 取第二段，如 /rooms/TEST/ws → TEST
      }
    }

    // WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader === 'websocket') {
      return this.handleWebSocket(request);
    }

    // RPC 调用：通知广播
    if (url.pathname.endsWith('/broadcast')) {
      const body = await request.json<WSMessage>() as WSMessage;
      await this.broadcastRoomUpdate(body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // RPC 调用：广播牵绊更新
    if (url.pathname.endsWith('/broadcast-bonds')) {
      const body = await request.json<{ characterId?: string }>() as { characterId?: string };
      await this.broadcastBondsUpdate(body.characterId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    // 从 header 中获取认证信息（由 Worker 中间件注入）
    const userId = request.headers.get('X-User-Id') || '';
    const characterId = request.headers.get('X-Character-Id') || '';

    if (!userId || !characterId) {
      return new Response('Missing auth info', { status: 401 });
    }

    // 创建 WebSocket 对
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    server.accept();

    const session: Session = { userId, characterId, ws: server };
    this.sessions.set(server, session);

    // 监听消息
    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data as string).catch((err) => {
        console.error('Error handling message:', err);
        this.send(server, { type: 'error', message: '服务器内部错误' });
      });
    });

    // 监听关闭
    server.addEventListener('close', () => {
      this.sessions.delete(server);
    });

    // 监听错误
    server.addEventListener('error', () => {
      this.sessions.delete(server);
    });

    // 连接成功后发送初始房间数据
    this.sendInitialData(server, userId, characterId).catch((err) => {
      console.error('Error sending initial data:', err);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async sendInitialData(ws: WebSocket, userId: string, characterId: string) {
    try {
      const roomData = await this.getRoomData();
      if (roomData) {
        this.send(ws, { type: 'room-update', room: roomData.room, members: roomData.members });
      }
      // 发送牵绊数据
      const bondsData = await this.getBondsData(characterId);
      if (bondsData) {
        this.send(ws, { type: 'bonds-update', outgoing: bondsData.outgoing, incoming: bondsData.incoming });
      }
    } catch (e) {
      console.error('Error in sendInitialData:', e);
    }
  }

  private async handleMessage(ws: WebSocket, data: string) {
    let msg: WSMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      this.send(ws, { type: 'error', message: '无效的JSON格式' });
      return;
    }

    const session = this.sessions.get(ws);
    if (!session) return;

    const db = this.env.DB;

    try {
      switch (msg.type) {
        case 'give-dream':
          await this.handleGiveDream(db, session, msg);
          break;
        case 'deduct-wonder':
          await this.handleDeductWonder(db, session, msg);
          break;
        case 'deduct-feeling':
          await this.handleDeductFeeling(db, session, msg);
          break;
        case 'add-wonder':
          await this.handleAddWonder(db, session, msg);
          break;
        case 'add-feeling':
          await this.handleAddFeeling(db, session, msg);
          break;
        case 'set-phase':
          await this.handleSetPhase(db, session, msg);
          break;
        case 'give-dream-player':
          await this.handleGiveDreamPlayer(db, session, msg);
          break;
        case 'update-resource':
          await this.handleUpdateResource(db, session, msg);
          break;
        case 'toggle-role':
          await this.handleToggleRole(db, session, msg);
          break;
        default:
          this.send(ws, { type: 'error', message: `未知的消息类型: ${msg.type}` });
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : '操作失败';
      this.send(ws, { type: 'error', message: errorMessage });
    }
  }

  // ==================== 业务逻辑 ====================

  private async handleGiveDream(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, amount } = msg as { characterId?: string; amount?: number };
    if (!characterId || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('参数无效');
    }

    // 校验 GM 权限
    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) throw new Error('只有 GM 可以发放梦点');

    // 检查角色在房间中
    const targetMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, characterId)
      .first();
    if (!targetMember) throw new Error('该角色不在此房间中');

    // 更新梦点
    await db
      .prepare("UPDATE characters SET dream_points = dream_points + ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amount, characterId)
      .run();

    // 资源日志
    await this.writeResourceLog(db, characterId, 'dream', amount, 'GM赠送');

    const updated = await db
      .prepare('SELECT dream_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ dream_points: number }>();

    // 发送操作结果
    this.send(session.ws, {
      type: 'action-result',
      action: 'give-dream',
      characterId,
      added: amount,
      dreamPoints: updated?.dream_points,
    });

    // 广播房间更新
    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleDeductWonder(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, amount } = msg as { characterId?: string; amount?: number };
    if (!characterId || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('参数无效');
    }

    // 校验权限：GM 或自己
    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) {
      const char = await db.prepare('SELECT user_id FROM characters WHERE id = ?').bind(characterId).first<{ user_id: string }>();
      if (!char || char.user_id !== session.userId) throw new Error('只能扣除自己角色的奇迹点');
    }

    // 检查角色在房间中
    const targetMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, characterId)
      .first();
    if (!targetMember) throw new Error('该角色不在此房间中');

    // 检查余额
    const targetChar = await db
      .prepare('SELECT wonder_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ wonder_points: number }>();
    if (!targetChar || targetChar.wonder_points < amount) {
      throw new Error('奇迹点不足，当前: ' + (targetChar?.wonder_points ?? 0));
    }

    // 扣除
    await db
      .prepare("UPDATE characters SET wonder_points = wonder_points - ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amount, characterId)
      .run();

    await this.writeResourceLog(db, characterId, 'wonder', -amount, '消耗奇迹点');

    const updated = await db
      .prepare('SELECT wonder_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ wonder_points: number }>();

    this.send(session.ws, {
      type: 'action-result',
      action: 'deduct-wonder',
      characterId,
      newPoints: updated?.wonder_points,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleDeductFeeling(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, amount } = msg as { characterId?: string; amount?: number };
    if (!characterId || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('参数无效');
    }

    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) {
      const char = await db.prepare('SELECT user_id FROM characters WHERE id = ?').bind(characterId).first<{ user_id: string }>();
      if (!char || char.user_id !== session.userId) throw new Error('只能扣除自己角色的心意点');
    }

    const targetMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, characterId)
      .first();
    if (!targetMember) throw new Error('该角色不在此房间中');

    const targetChar = await db
      .prepare('SELECT feeling_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ feeling_points: number }>();
    if (!targetChar || targetChar.feeling_points < amount) {
      throw new Error('心意点不足，当前: ' + (targetChar?.feeling_points ?? 0));
    }

    await db
      .prepare("UPDATE characters SET feeling_points = feeling_points - ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amount, characterId)
      .run();

    await this.writeResourceLog(db, characterId, 'feeling', -amount, '消耗心意点');

    const updated = await db
      .prepare('SELECT feeling_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ feeling_points: number }>();

    this.send(session.ws, {
      type: 'action-result',
      action: 'deduct-feeling',
      characterId,
      newPoints: updated?.feeling_points,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleAddWonder(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, amount } = msg as { characterId?: string; amount?: number };
    if (!characterId || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('参数无效');
    }

    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) {
      const char = await db.prepare('SELECT user_id FROM characters WHERE id = ?').bind(characterId).first<{ user_id: string }>();
      if (!char || char.user_id !== session.userId) throw new Error('只能增加自己角色的奇迹点');
    }

    const targetMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, characterId)
      .first();
    if (!targetMember) throw new Error('该角色不在此房间中');

    await db
      .prepare("UPDATE characters SET wonder_points = wonder_points + ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amount, characterId)
      .run();

    await this.writeResourceLog(db, characterId, 'wonder', amount, '增加奇迹点');

    const updated = await db
      .prepare('SELECT wonder_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ wonder_points: number }>();

    this.send(session.ws, {
      type: 'action-result',
      action: 'add-wonder',
      characterId,
      newPoints: updated?.wonder_points,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleAddFeeling(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, amount } = msg as { characterId?: string; amount?: number };
    if (!characterId || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('参数无效');
    }

    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) {
      const char = await db.prepare('SELECT user_id FROM characters WHERE id = ?').bind(characterId).first<{ user_id: string }>();
      if (!char || char.user_id !== session.userId) throw new Error('只能增加自己角色的心意点');
    }

    const targetMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, characterId)
      .first();
    if (!targetMember) throw new Error('该角色不在此房间中');

    await db
      .prepare("UPDATE characters SET feeling_points = feeling_points + ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amount, characterId)
      .run();

    await this.writeResourceLog(db, characterId, 'feeling', amount, '增加心意点');

    const updated = await db
      .prepare('SELECT feeling_points FROM characters WHERE id = ?')
      .bind(characterId)
      .first<{ feeling_points: number }>();

    this.send(session.ws, {
      type: 'action-result',
      action: 'add-feeling',
      characterId,
      newPoints: updated?.feeling_points,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleSetPhase(db: D1Database, session: Session, msg: WSMessage) {
    const { phase } = msg as { phase?: string };
    if (!phase || !['scene', 'intermission', 'ending'].includes(phase)) {
      throw new Error('阶段必须是 scene、intermission 或 ending');
    }

    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) throw new Error('只有 GM 可以设置场景阶段');

    await db.prepare('UPDATE rooms SET phase = ? WHERE id = ?').bind(phase, this.roomId).run();

    this.send(session.ws, {
      type: 'action-result',
      action: 'set-phase',
      roomId: this.roomId,
      phase,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleGiveDreamPlayer(db: D1Database, session: Session, msg: WSMessage) {
    const { fromCharacterId, toCharacterId, amount } = msg as { fromCharacterId?: string; toCharacterId?: string; amount?: number };
    if (!fromCharacterId || !toCharacterId || typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('参数无效');
    }

    // 校验发起方角色属于当前用户
    const fromChar = await db
      .prepare('SELECT user_id, name FROM characters WHERE id = ?')
      .bind(fromCharacterId)
      .first<{ user_id: string; name: string }>();
    if (!fromChar) throw new Error('发起方角色卡不存在');
    if (fromChar.user_id !== session.userId) throw new Error('无权操作该角色卡');

    // 验证都在房间中
    const fromMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, fromCharacterId)
      .first();
    if (!fromMember) throw new Error('发起方角色不在此房间中');

    const toMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, toCharacterId)
      .first();
    if (!toMember) throw new Error('目标角色不在此房间中');

    // 更新目标方梦点
    await db
      .prepare("UPDATE characters SET dream_points = dream_points + ?, updated_at = datetime('now') WHERE id = ?")
      .bind(amount, toCharacterId)
      .run();

    await this.writeResourceLog(db, toCharacterId, 'dream', amount, `${fromChar.name} 赠送`);

    const toUpdated = await db
      .prepare('SELECT dream_points FROM characters WHERE id = ?')
      .bind(toCharacterId)
      .first<{ dream_points: number }>();

    this.send(session.ws, {
      type: 'action-result',
      action: 'give-dream-player',
      toCharacterId,
      added: amount,
      dreamPoints: toUpdated?.dream_points,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleUpdateResource(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, resourceType, newValue } = msg as { characterId?: string; resourceType?: string; newValue?: number };
    if (!characterId || !resourceType || !['dream', 'feeling', 'wonder'].includes(resourceType)) {
      throw new Error('参数无效');
    }
    if (typeof newValue !== 'number' || !Number.isInteger(newValue) || newValue < 0) {
      throw new Error('新值必须是非负整数');
    }

    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) {
      const char = await db.prepare('SELECT user_id FROM characters WHERE id = ?').bind(characterId).first<{ user_id: string }>();
      if (!char || char.user_id !== session.userId) throw new Error('只能修改自己角色的资源');
    }

    const columnMap: Record<string, string> = {
      dream: 'dream_points',
      feeling: 'feeling_points',
      wonder: 'wonder_points',
    };
    const column = columnMap[resourceType];

    const current = await db
      .prepare(`SELECT ${column} as current_value FROM characters WHERE id = ?`)
      .bind(characterId)
      .first<{ current_value: number }>();
    if (!current) throw new Error('角色卡不存在');

    const changeAmount = newValue - current.current_value;

    await db
      .prepare(`UPDATE characters SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(newValue, characterId)
      .run();

    await this.writeResourceLog(db, characterId, resourceType, changeAmount, '手动修改');

    this.send(session.ws, {
      type: 'action-result',
      action: 'update-resource',
      characterId,
      resourceType,
      previousValue: current.current_value,
      newValue,
      changeAmount,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  private async handleToggleRole(db: D1Database, session: Session, msg: WSMessage) {
    const { characterId, role } = msg as { characterId?: string; role?: string };
    if (!characterId || (role !== 'gm' && role !== 'player')) {
      throw new Error('参数无效');
    }

    const isGM = await this.checkGM(db, session.userId);
    if (!isGM) throw new Error('只有 GM 可以调整成员角色');

    const targetMember = await db
      .prepare('SELECT character_id FROM room_members WHERE room_id = ? AND character_id = ?')
      .bind(this.roomId, characterId)
      .first();
    if (!targetMember) throw new Error('该角色不在此房间中');

    await db
      .prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND character_id = ?')
      .bind(role, this.roomId, characterId)
      .run();

    this.send(session.ws, {
      type: 'action-result',
      action: 'toggle-role',
      roomId: this.roomId,
      characterId,
      role,
    });

    await this.broadcastRoomUpdate({ type: 'room-changed' });
  }

  // ==================== 辅助方法 ====================

  private async checkGM(db: D1Database, userId: string): Promise<boolean> {
    const room = await db
      .prepare('SELECT gm_user_id FROM rooms WHERE id = ?')
      .bind(this.roomId)
      .first<{ gm_user_id: string }>();
    return room !== null && room.gm_user_id === userId;
  }

  private async writeResourceLog(db: D1Database, characterId: string, resourceType: string, changeAmount: number, reason: string) {
    try {
      await db
        .prepare('INSERT INTO resource_logs (room_code, character_id, resource_type, change_amount, reason) VALUES (?, ?, ?, ?, ?)')
        .bind(this.roomId, characterId, resourceType, changeAmount, reason)
        .run();
    } catch (e) {
      console.error('写入 resource_logs 失败:', e);
    }
  }

  private async getRoomData() {
    const db = this.env.DB;

    const room = await db
      .prepare('SELECT id, name, gm_user_id, phase, created_at FROM rooms WHERE id = ?')
      .bind(this.roomId)
      .first<{
        id: string;
        name: string | null;
        gm_user_id: string;
        phase: string;
        created_at: string;
      }>();

    if (!room) return null;

    const members = await db
      .prepare(
        `SELECT rm.character_id, rm.user_id, rm.role, rm.joined_at,
                c.id as char_id, c.name, c.true_form, c.human_appearance, c.true_appearance, c.attr_henge, c.attr_animal, c.attr_adult, c.attr_child,
                c.dream_points, c.wonder_points, c.feeling_points, c.weaknesses, c.abilities, c.extra_abilities
         FROM room_members rm
         JOIN characters c ON rm.character_id = c.id
         WHERE rm.room_id = ?`
      )
      .bind(this.roomId)
      .all<{
        character_id: string;
        user_id: string;
        role: string;
        joined_at: string;
        char_id: string;
        name: string;
        true_form: string;
        human_appearance: string | null;
        true_appearance: string | null;
        attr_henge: number;
        attr_animal: number;
        attr_adult: number;
        attr_child: number;
        dream_points: number;
        wonder_points: number;
        feeling_points: number;
        weaknesses: string | null;
        abilities: string | null;
        extra_abilities: string | null;
      }>();

    return {
      room: {
        id: room.id,
        name: room.name,
        gmUserId: room.gm_user_id,
        phase: room.phase,
        createdAt: room.created_at,
      },
      members: (members.results || []).map((m) => ({
        characterId: m.character_id,
        userId: m.user_id,
        role: m.role,
        joinedAt: m.joined_at,
        character: {
          id: m.char_id,
          name: m.name,
          trueForm: m.true_form,
          humanAppearance: m.human_appearance,
          trueAppearance: m.true_appearance,
          attrHenge: m.attr_henge,
          attrAnimal: m.attr_animal,
          attrAdult: m.attr_adult,
          attrChild: m.attr_child,
          dreamPoints: m.dream_points,
          wonderPoints: m.wonder_points,
          feelingPoints: m.feeling_points,
          weaknesses: m.weaknesses,
          abilities: m.abilities,
          extraAbilities: m.extra_abilities,
        },
      })),
    };
  }

  private async getBondsData(characterId: string) {
    const db = this.env.DB;

    const { results: outgoing } = await db
      .prepare('SELECT * FROM bonds WHERE room_id = ? AND from_character_id = ? ORDER BY updated_at DESC')
      .bind(this.roomId, characterId)
      .all<Record<string, unknown>>();

    const { results: incoming } = await db
      .prepare('SELECT * FROM bonds WHERE room_id = ? AND to_character_id = ? ORDER BY updated_at DESC')
      .bind(this.roomId, characterId)
      .all<Record<string, unknown>>();

    return {
      outgoing: outgoing.map(this.formatBond),
      incoming: incoming.map(this.formatBond),
    };
  }

  private formatBond(row: Record<string, unknown>) {
    return {
      id: row.id,
      roomId: row.room_id,
      fromCharacterId: row.from_character_id,
      fromCharacterName: row.from_character_name,
      toCharacterName: row.to_character_name,
      toCharacterId: row.to_character_id,
      bondType: row.bond_type,
      bondLevel: row.bond_level,
      isIntense: row.is_intense,
      updatedAt: row.updated_at,
    };
  }

  // ==================== 广播方法 ====================

  private async broadcastRoomUpdate(_trigger: WSMessage) {
    const roomData = await this.getRoomData();
    if (!roomData) return;

    const message: WSResponse = {
      type: 'room-update',
      room: roomData.room,
      members: roomData.members,
    };

    // 广播给所有连接
    for (const [ws] of this.sessions) {
      this.send(ws, message);
    }
  }

  async broadcastBondsUpdate(changedCharacterId?: string) {
    // 向每个连接发送其对应的牵绊数据
    for (const [ws, session] of this.sessions) {
      try {
        const bondsData = await this.getBondsData(session.characterId);
        this.send(ws, {
          type: 'bonds-update',
          outgoing: bondsData.outgoing,
          incoming: bondsData.incoming,
        });
      } catch (e) {
        console.error('Error broadcasting bonds update:', e);
      }
    }
  }

  private send(ws: WebSocket, message: WSResponse) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      // 连接可能已关闭
      this.sessions.delete(ws);
    }
  }
}
