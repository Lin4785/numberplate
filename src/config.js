/**
 * 全局配置。
 * 所有可调参数集中在这里，便于按需修改（例如选号次数、号牌有效期等）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DB_FILE = process.env.NP_DB_FILE || path.join(DATA_DIR, 'numberplate.db');

export const SERVER = {
  host: process.env.NP_HOST || '127.0.0.1',
  port: Number(process.env.NP_PORT || 5173),
};

/** 选号业务规则参数 */
export const RULES = {
  /** 随机选号：每次随机出多少个号码 */
  randomBatchSize: 10,
  /** 随机选号：一共可以随机几批（对应"换一换"次数） */
  randomBatchLimit: 5,
  /** 自编选号：一共多少次机会 */
  selfAttemptLimit: 20,
  /** 预选号牌有效期（自然日） */
  voucherValidDays: 3,
  /** 单个选号申请的有效期（小时），超时未完成则作废 */
  applicationValidHours: 24,
};

/** 管理后台口令（生产环境请通过环境变量注入） */
export const ADMIN_PASSWORD = process.env.NP_ADMIN_PASSWORD || 'admin123';
export const ADMIN_COOKIE = 'np_admin';
export const SESSION_MAX_AGE = 60 * 60 * 8; // 8 小时
