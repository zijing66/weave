import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { getAuthPath, getInitialPasswordPath } from '../db/paths.js';

/**
 * dashboard 平面认证（监听放开的配套）。
 *
 * 口令材料落 `<dataDir>/auth.json`（0600），**不进 settings 表**——那张表是
 * UI 可读配置面（GET /settings 直出），口令材料不该混进去。三种凭据：
 *  - 密码：scrypt + 每口令独立 salt；首启随机生成，经 `<dataDir>/initial-password`
 *    标记文件由 CLI 领取一次（daemon 以 detached / stdio:ignore 启动，打印必丢）；
 *  - 会话：无状态签名 cookie（HMAC(sessionSecret)，30 天）——重启 daemon 不掉线；
 *  - 本机令牌：CLI 与 hooks 的免密通道（同机同用户可读 auth.json = 本机即管理员）。
 *
 * 文件名不叫 auth.ts：那个名字被既有的 ptoken 助手占着（`generateToken`，
 * hook 采集用），本模块是 dashboard 平面，各管各的。
 */

export interface PasswordRecord {
  algo: 'scrypt';
  salt: string;
  hash: string;
  updatedAt: string;
}

/** auth.json 形状（version 留给未来迁移）。 */
export interface AuthFile {
  version: 1;
  password: PasswordRecord | null;
  sessionSecret: string;
  localToken: string;
  createdAt: string;
}

/** 会话 cookie 名（门与 web 客户端共用）。 */
export const SESSION_COOKIE = 'weave_session';
/** 本机令牌请求头（CLI 与 hooks 携带）。 */
export const LOCAL_TOKEN_HEADER = 'x-weave-local';
/** 会话有效期 30 天：自托管单机，重启 daemon 不该掉线。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
/** 初始密码字母表：去掉 0/O/1/l/I 一类易混字符，便于手抄。 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 随机初始密码（`xxxx-xxxx-xxxx-xxxx`）。 */
export function generatePassword(): string {
  const group = (): string =>
    Array.from({ length: 4 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)] ?? 'a').join('');
  return [group(), group(), group(), group()].join('-');
}

function hashPassword(plain: string, at: string): PasswordRecord {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  return {
    algo: 'scrypt',
    salt,
    hash: scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex'),
    updatedAt: at,
  };
}

/** 常量时间比对；长度不等直接 false（timingSafeEqual 遇长度不等会抛）。 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 从 cookie 头里取一个键（无则 undefined）。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Set-Cookie 值：HttpOnly + SameSite=Lax + Path=/（同源 fetch 与 EventSource 自动带）。 */
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}`;
}

/** 清 cookie（登出 / 未认证回执）。 */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** 读 auth.json；缺失或坏文件 → null（坏文件按缺失重生成——写权限已在手 = 本机即管理员）。 */
function readAuthFile(file: string): AuthFile | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AuthFile>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.sessionSecret !== 'string' ||
      typeof parsed.localToken !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      password: parsed.password ?? null,
      sessionSecret: parsed.sessionSecret,
      localToken: parsed.localToken,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** 原子写（临时文件 + rename）+ 0600（Windows 上 chmod 近似 no-op，无害）。 */
function writeAuthFile(file: string, value: AuthFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 平台不支持时忽略
  }
}

export interface AuthServiceOptions {
  /** 覆盖 auth.json 路径（测试注入）。 */
  authPath?: string;
  /** 覆盖初始密码标记文件路径（测试注入）。 */
  initialPasswordPath?: string;
  /** 时钟注入（测试过期语义）。 */
  now?: () => number;
}

export class AuthService {
  private file: AuthFile;
  private readonly authPath: string;
  private readonly markerPath: string;
  private readonly now: () => number;
  /** 本次构造首启生成才有值；CLI 经标记文件领取同一串。 */
  readonly initialPassword: string | null;

  constructor(opts: AuthServiceOptions = {}) {
    this.authPath = opts.authPath ?? getAuthPath();
    this.markerPath = opts.initialPasswordPath ?? getInitialPasswordPath();
    this.now = opts.now ?? Date.now;
    const existing = readAuthFile(this.authPath);
    if (existing) {
      this.file = existing;
      this.initialPassword = null;
      return;
    }
    const initial = generatePassword();
    this.file = {
      version: 1,
      password: hashPassword(initial, this.nowIso()),
      sessionSecret: randomBytes(32).toString('hex'),
      localToken: randomBytes(24).toString('hex'),
      createdAt: this.nowIso(),
    };
    writeAuthFile(this.authPath, this.file);
    this.writeMarker(initial);
    this.initialPassword = initial;
  }

  isPasswordSet(): boolean {
    return this.file.password !== null;
  }

  /** 校密码（常量时间；未设密码恒 false）。 */
  verifyPassword(plain: string): boolean {
    const record = this.file.password;
    if (!record) return false;
    return safeEqual(scryptSync(plain, record.salt, SCRYPT_KEYLEN).toString('hex'), record.hash);
  }

  /**
   * 设 / 改密码：**轮换 sessionSecret**——旧会话 cookie 全部失效（改密即踢下线），
   * 并清掉初始密码标记（用户已自有密码，提示不该再出现）。
   */
  setPassword(plain: string): void {
    this.file = {
      ...this.file,
      password: hashPassword(plain, this.nowIso()),
      sessionSecret: randomBytes(32).toString('hex'),
    };
    writeAuthFile(this.authPath, this.file);
    rmSync(this.markerPath, { force: true });
  }

  /** 本机令牌原值（CLI 直接读 auth.json；此 getter 供同进程消费方与测试）。 */
  getLocalToken(): string {
    return this.file.localToken;
  }

  verifyLocalToken(provided: string | undefined): boolean {
    return (
      typeof provided === 'string' && provided !== '' && safeEqual(provided, this.file.localToken)
    );
  }

  /** 签发会话 cookie 值（`<expMs>.<hmac>`）。 */
  issueSession(): string {
    const exp = this.now() + SESSION_TTL_MS;
    return `${exp}.${this.sign(exp)}`;
  }

  verifySession(value: string | undefined): boolean {
    if (!value) return false;
    const dot = value.indexOf('.');
    if (dot <= 0) return false;
    const exp = Number(value.slice(0, dot));
    if (!Number.isFinite(exp) || exp <= this.now()) return false;
    return safeEqual(value.slice(dot + 1), this.sign(exp));
  }

  /** 请求级判定：本机令牌头 或 有效会话 cookie。 */
  isAuthenticated(headers: IncomingHttpHeaders): boolean {
    if (this.isLocallyTrusted(headers)) return true;
    return this.verifySession(readCookie(headers.cookie, SESSION_COOKIE));
  }

  /**
   * 本机令牌判定——**改密等「本机管理员」动作专用**：只认 `x-weave-local`，
   * 会话 cookie 不算（改密只走 CLI，dashboard 不提供该操作）。
   */
  isLocallyTrusted(headers: IncomingHttpHeaders): boolean {
    const local = headers[LOCAL_TOKEN_HEADER];
    return this.verifyLocalToken(typeof local === 'string' ? local : undefined);
  }

  private sign(exp: number): string {
    return createHmac('sha256', this.file.sessionSecret)
      .update(`weave-session:${exp}`)
      .digest('hex');
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private writeMarker(password: string): void {
    mkdirSync(path.dirname(this.markerPath), { recursive: true });
    writeFileSync(this.markerPath, `${password}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
