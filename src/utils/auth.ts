// 使用 Web Crypto API 实现密码哈希和 JWT
// Cloudflare Workers 环境兼容

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * 将 ArrayBuffer 转为 Base64 字符串（URL-safe）
 */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * 将 Base64 字符串（URL-safe）转为 Uint8Array
 */
function base64ToBuffer(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 生成随机 salt
 */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * 使用 PBKDF2 对密码进行哈希
 * 返回格式: salt:hash（均为 base64url）
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = generateSalt();
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH * 8
  );

  const saltB64 = bufferToBase64(salt.buffer as ArrayBuffer);
  const hashB64 = bufferToBase64(hashBuffer);
  return `${saltB64}:${hashB64}`;
}

/**
 * 验证密码
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;

  const salt = base64ToBuffer(saltB64);
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH * 8
  );

  const computedHash = bufferToBase64(hashBuffer);
  return computedHash === hashB64;
}

// ---- JWT 实现 ----

interface JWTPayload {
  userId: string;
  username: string;
  exp: number;
  iat: number;
}

/**
 * 使用 HMAC-SHA256 签名 JWT
 */
async function signHMAC(data: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

/**
 * 生成 JWT token
 * 有效期 7 天
 */
export async function generateToken(
  payload: { userId: string; username: string },
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 7 * 24 * 60 * 60; // 7 天

  const jwtPayload: JWTPayload = {
    userId: payload.userId,
    username: payload.username,
    iat: now,
    exp,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = bufferToBase64(
    new TextEncoder().encode(JSON.stringify(header)).buffer as ArrayBuffer
  );
  const payloadB64 = bufferToBase64(
    new TextEncoder().encode(JSON.stringify(jwtPayload)).buffer as ArrayBuffer
  );

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await signHMAC(signingInput, secret);
  const signatureB64 = bufferToBase64(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * 验证 JWT token
 * 返回 payload 或 null
 */
export async function verifyToken(
  token: string,
  secret: string
): Promise<{ userId: string; username: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // 验证签名
  const expectedSignature = await signHMAC(signingInput, secret);
  const expectedSigB64 = bufferToBase64(expectedSignature);

  // 使用固定时间比较防止时序攻击
  if (!constantTimeCompare(signatureB64, expectedSigB64)) {
    return null;
  }

  // 解析 payload
  try {
    const payloadBytes = base64ToBuffer(payloadB64);
    const payloadText = new TextDecoder().decode(payloadBytes);
    const payload: JWTPayload = JSON.parse(payloadText);

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // token 已过期
    }

    return { userId: payload.userId, username: payload.username };
  } catch {
    return null;
  }
}

/**
 * 固定时间字符串比较，防止时序攻击
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
