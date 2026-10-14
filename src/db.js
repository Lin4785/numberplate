/**
 * 数据访问层：SQLite 连接、建表、以及常用的预处理语句缓存。
 * 使用 Node 内置的 node:sqlite，无需任何第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_FILE } from './config.js';
import './quiet.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 号段：某个发牌机关 + 号牌种类下的一段可用号码
CREATE TABLE IF NOT EXISTS segments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agency      TEXT    NOT NULL,
  plate_type  TEXT    NOT NULL,
  pattern     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active',   -- active | paused
  remark      TEXT,
  created_at  TEXT    NOT NULL,
  UNIQUE (agency, plate_type, pattern)
);

-- 号码池：只存放"已被占用"的号码（含管理员导入的历史占用号码）
-- 注意：号牌号码的唯一性以"号牌种类"为界，蓝牌与黄牌可以出现相同的号码组合
CREATE TABLE IF NOT EXISTS plates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT    NOT NULL,                    -- 完整号牌号码，如 京A12345
  agency      TEXT    NOT NULL,
  seq         TEXT    NOT NULL,
  plate_type  TEXT    NOT NULL,
  segment_id  INTEGER NOT NULL REFERENCES segments(id),
  status      TEXT    NOT NULL DEFAULT 'used',     -- used 已占用 | reserved 预选中 | locked 锁定
  source      TEXT    NOT NULL DEFAULT 'seed',     -- seed | random | self | admin
  updated_at  TEXT    NOT NULL,
  UNIQUE (number, plate_type)
);
CREATE INDEX IF NOT EXISTS idx_plates_segment ON plates(segment_id);
CREATE INDEX IF NOT EXISTS idx_plates_status  ON plates(status);
CREATE INDEX IF NOT EXISTS idx_plates_number  ON plates(number, plate_type);

-- 选号申请（一次完整的选号业务）
CREATE TABLE IF NOT EXISTS applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,       -- 申请编号
  owner_name        TEXT    NOT NULL,
  owner_id_card     TEXT    NOT NULL,
  owner_phone       TEXT    NOT NULL,
  vin               TEXT    NOT NULL,
  vehicle_model     TEXT,
  plate_type        TEXT    NOT NULL,
  agency            TEXT    NOT NULL,              -- 发牌机关代号（属地），如 京A
  status            TEXT    NOT NULL DEFAULT 'info', -- info|random|self|done|canceled
  method            TEXT,                          -- random | self
  result_number     TEXT,
  result_segment_id INTEGER REFERENCES segments(id),
  voucher_code      TEXT,
  voucher_expires_at TEXT,
  random_batch_used INTEGER NOT NULL DEFAULT 0,
  self_attempt_used INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);

-- 随机选号批次明细
CREATE TABLE IF NOT EXISTS random_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  batch_no       INTEGER NOT NULL,
  number         TEXT    NOT NULL,
  is_picked      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_app ON random_batches(application_id, batch_no);

-- 自编选号尝试记录
CREATE TABLE IF NOT EXISTS self_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  attempt_no     INTEGER NOT NULL,
  number         TEXT    NOT NULL,
  ok             INTEGER NOT NULL,
  reason         TEXT,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_app ON self_attempts(application_id);

-- 操作日志（便于排查与审计）
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
`;

let instance = null;
let schemaApplied = false;
const statementCache = new Map();

/** 建立数据库连接（单例），不做表结构初始化 */
function openDb() {
  if (instance) return instance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  instance = new DatabaseSync(DB_FILE);
  instance.exec('PRAGMA journal_mode = WAL;');
  instance.exec('PRAGMA foreign_keys = ON;');
  return instance;
}

/** 获取数据库连接（单例），首次调用时初始化表结构 */
export function getDb() {
  const db = openDb();
  if (!schemaApplied) {
    db.exec(SCHEMA);
    schemaApplied = true;
  }
  return db;
}

/** 清空全部业务数据并重建表结构（供 seed --reset 与测试使用） */
export function resetDatabase() {
  const db = openDb();
  db.exec(`
    DROP TABLE IF EXISTS self_attempts;
    DROP TABLE IF EXISTS random_batches;
    DROP TABLE IF EXISTS applications;
    DROP TABLE IF EXISTS plates;
    DROP TABLE IF EXISTS segments;
    DROP TABLE IF EXISTS logs;
  `);
  statementCache.clear();
  db.exec(SCHEMA);
  schemaApplied = true;
}

/** 关闭连接（测试收尾时使用，避免临时文件被占用） */
export function closeDb() {
  if (!instance) return;
  instance.close();
  instance = null;
  schemaApplied = false;
  statementCache.clear();
}

/** 带缓存的预处理语句 */
export function sql(text) {
  const db = getDb();
  let stmt = statementCache.get(text);
  if (!stmt) {
    stmt = db.prepare(text);
    statementCache.set(text, stmt);
  }
  return stmt;
}

export function run(text, ...params) {
  const result = sql(text).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

export function get(text, ...params) {
  return sql(text).get(...params) ?? null;
}

export function all(text, ...params) {
  return sql(text).all(...params);
}

/** 事务包装：回调抛错则整体回滚 */
export function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function log(scope, action, detail) {
  run(
    'INSERT INTO logs (scope, action, detail, created_at) VALUES (?, ?, ?, ?)',
    scope,
    action,
    typeof detail === 'string' ? detail : JSON.stringify(detail ?? null),
    nowIso(),
  );
}
