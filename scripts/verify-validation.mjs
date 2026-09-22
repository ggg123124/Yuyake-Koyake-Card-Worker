const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const suffix = Math.random().toString(36).slice(2, 8);

const results = [];
function record(name, expected, actual) {
  const pass = expected === actual;
  results.push({ name, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${expected} | ${actual}`);
}

async function json(res) {
  try { return await res.json(); } catch { return null; }
}

async function setup() {
  const username = `testuser_${suffix}`;
  const password = 'password123';

  const regRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const regBody = await json(regRes);
  const token = regBody.token;
  const userId = regBody.user.id;

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const charRes = await fetch(`${BASE}/api/characters`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'TestChar', trueForm: 'Spirit' }),
  });
  const charBody = await json(charRes);
  const characterId = charBody.id;

  const roomCode = `TEST${suffix.toUpperCase()}`;
  const roomRes = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ id: roomCode }),
  });

  await fetch(`${BASE}/api/rooms/${roomCode}/join`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ characterId }),
  });

  const itemRes = await fetch(`${BASE}/api/inventory/${characterId}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Sword', description: 'A sharp sword' }),
  });
  const itemBody = await json(itemRes);
  const itemId = itemBody.id;

  return { authHeaders, characterId, roomCode, itemId, token };
}

async function runTests() {
  const { authHeaders, characterId, roomCode, itemId } = await setup();

  // 1. Invalid JSON → 400
  {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    record('非法JSON→400', 400, res.status);
  }

  // 2. Too-long character name → 400
  {
    const res = await fetch(`${BASE}/api/characters`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'A'.repeat(51), trueForm: 'X' }),
    });
    record('超长角色名→400', 400, res.status);
  }

  // 3. attrHenge=999 → clamped to 4
  {
    const res = await fetch(`${BASE}/api/characters`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'AttrTest', trueForm: 'X', attrHenge: 999 }),
    });
    const body = await json(res);
    record('属性999夹到4', 4, body?.attr_henge);
  }

  // 4. dreamPoints=-50 → clamped to 0
  {
    const res = await fetch(`${BASE}/api/characters`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'DpTest', trueForm: 'X', dreamPoints: -50 }),
    });
    const body = await json(res);
    record('梦点负数夹到0', 0, body?.dream_points);
  }

  // 5. bondLevel=99 → clamped to 5
  {
    const res = await fetch(`${BASE}/api/bonds`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        roomId: roomCode,
        fromCharacterId: characterId,
        toCharacterName: 'NPC',
        bondType: 'friend',
        bondLevel: 99,
      }),
    });
    const body = await json(res);
    record('牵绊99夹到5', 5, body?.bondLevel);
  }

  // 6. Single-char room code → 400
  {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ id: 'x' }),
    });
    record('单字符房间码→400', 400, res.status);
  }

  // 7. Username with space → 400
  {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `pspace ${suffix}`, password: 'password123' }),
    });
    record('含空格用户名→400', 400, res.status);
  }

  // 8. inventory reorder → 200
  {
    const res = await fetch(`${BASE}/api/inventory/${characterId}/reorder`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ itemIds: [itemId] }),
    });
    record('背包排序→200', 200, res.status);
  }
}

runTests().then(() => {
  const fails = results.filter(r => !r.pass);
  console.log(`\n共 ${results.length} 项，不符 ${fails.length} 项`);
  if (fails.length > 0) process.exit(1);
}).catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});
