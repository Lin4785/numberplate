/**
 * 初始化数据库：写入号段、模拟"已被占用"的号牌号码、以及少量历史选号记录。
 *
 *   node src/seed.js          # 仅补齐缺失数据
 *   node src/seed.js --reset  # 清空数据库后重新生成
 */
import fs from 'node:fs';
import { DB_FILE, RULES } from './config.js';
import './quiet.js';
import { all, get, getDb, nowIso, resetDatabase, run, transaction } from './db.js';
import { LETTERS, PLATE_TYPES, capacityOf, composePlateNumber, indexToSeq, matchesPattern } from './rules.js';

const RESET = process.argv.includes('--reset');

/** 号段投放计划：occupied 为该号段当前已占用的号码数量（用于模拟真实占用率） */
const SEGMENT_SEEDS = [
  { agency: '京A', plateType: 'small_car', pattern: '99999', occupied: 62000 },
  { agency: '京N', plateType: 'small_car', pattern: '99999', occupied: 17000 },
  { agency: '京C', plateType: 'small_car', pattern: '9A999', occupied: 26000 },
  { agency: '京Q', plateType: 'small_car', pattern: 'A9999', occupied: 11000 },
  { agency: '京A', plateType: 'large_car', pattern: '99999', occupied: 18000 },
  { agency: '京A', plateType: 'coach', pattern: '99999', occupied: 3000 },
  { agency: '京A', plateType: 'moto', pattern: '99999', occupied: 7000 },
  { agency: '京A', plateType: 'new_energy_large', pattern: '999999', occupied: 4000 },
  { agency: '京A', plateType: 'new_energy_small', pattern: 'D99999', occupied: 6000 },
  { agency: '京A', plateType: 'new_energy_small', pattern: 'F99999', occupied: 4000 },
  { agency: '沪A', plateType: 'small_car', pattern: '99999', occupied: 70000 },
  { agency: '沪B', plateType: 'small_car', pattern: '9A999', occupied: 16000 },
  { agency: '沪A', plateType: 'new_energy_small', pattern: 'D99999', occupied: 2200 },
  { agency: '粤A', plateType: 'small_car', pattern: '9A999', occupied: 21000 },
  { agency: '粤B', plateType: 'small_car', pattern: '99999', occupied: 44000 },
  { agency: '粤B', plateType: 'new_energy_small', pattern: 'D99999', occupied: 1800 },
  { agency: '浙A', plateType: 'small_car', pattern: 'A9999', occupied: 8000 },
];

/** 每个号段里预留的"靓号"，用来让自编选号更有真实感 */
const PRETTY_SEQS = [
  '88888', '66666', '99999', '12345', '54321', '56789', '00001', '11111',
  '22222', '33333', '44444', '55555', '77777', '18888', '28888', '58888',
  '68888', '78888', '98888', '16666', '52013', '11001', '00008', '10086',
];

function buildName(agency, plateType, pattern) {
  return `${agency}·${PLATE_TYPES[plateType].name}（${pattern}）`;
}

/** 把纯数字的"靓号"适配到号段模板（把模板里的字母位换成字母） */
function conformSeq(prettyDigits, pattern) {
  const digits = prettyDigits.padStart(pattern.length, '0').slice(-pattern.length);
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '9' || ch === '*') out += digits[i];
    else if (ch === 'A') out += LETTERS[i % LETTERS.length];
    else out += ch;
  }
  return matchesPattern(pattern, out) ? out : null;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

/** 生成合法身份证号（含正确校验位） */
function makeIdCard(seed) {
  const provinces = ['110101', '310101', '440101', '440301', '330101', '120101'];
  const prefix = provinces[seed % provinces.length];
  const birth = `19${70 + (seed % 30)}${String(1 + (seed % 12)).padStart(2, '0')}${String(1 + (seed % 28)).padStart(2, '0')}`;
  const body = `${prefix}${birth}${String(100 + (seed % 900))}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * weights[i];
  return `${body}${checks[sum % 11]}`;
}

function makeVin(seed) {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  let vin = '';
  for (let i = 0; i < 17; i += 1) vin += chars[(seed * 7 + i * 13) % chars.length];
  return vin;
}

function makePhone(seed) {
  const prefix = ['138', '139', '150', '158', '186', '188'][seed % 6];
  return `${prefix}${String(10000000 + ((seed * 7919) % 89999999)).slice(0, 8)}`;
}

function seedSegments() {
  const insert = `
    INSERT INTO segments (agency, plate_type, pattern, name, status, remark, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT (agency, plate_type, pattern) DO NOTHING`;
  let created = 0;
  transaction(() => {
    for (const spec of SEGMENT_SEEDS) {
      const existing = get(
        'SELECT id FROM segments WHERE agency = ? AND plate_type = ? AND pattern = ?',
        spec.agency,
        spec.plateType,
        spec.pattern,
      );
      if (existing) continue;
      run(
        insert,
        spec.agency,
        spec.plateType,
        spec.pattern,
        buildName(spec.agency, spec.plateType, spec.pattern),
        '系统初始化投放',
        nowIso(),
      );
      created += 1;
    }
  });
  return created;
}

function seedOccupiedNumbers() {
  const insertSql = `
    INSERT INTO plates (number, agency, seq, plate_type, segment_id, status, source, updated_at)
    VALUES (?, ?, ?, ?, ?, 'used', 'seed', ?)
    ON CONFLICT (number, plate_type) DO NOTHING`;
  const timestamp = nowIso();
  let inserted = 0;

  for (const spec of SEGMENT_SEEDS) {
    const segment = get(
      'SELECT * FROM segments WHERE agency = ? AND plate_type = ? AND pattern = ?',
      spec.agency,
      spec.plateType,
      spec.pattern,
    );
    if (!segment) continue;

    const capacity = capacityOf(spec.pattern);
    const target = Math.min(spec.occupied, capacity);
    const existing = Number(get('SELECT COUNT(*) AS c FROM plates WHERE segment_id = ?', segment.id).c);
    if (existing >= target) continue;
    const need = target - existing;

    const chosen = new Set();

    // 先占用"靓号"
    for (const pretty of PRETTY_SEQS) {
      const seq = conformSeq(pretty, spec.pattern);
      if (seq && chosen.size < need) chosen.add(seq);
    }

    // 再随机占用其余号码（按下标取样，避免枚举整个号码空间）
    let guard = 0;
    while (chosen.size < need && guard < need * 30 + 2000) {
      guard += 1;
      chosen.add(indexToSeq(spec.pattern, randomInt(capacity)));
    }

    transaction(() => {
      const stmt = getDb().prepare(insertSql);
      for (const seq of chosen) {
        const result = stmt.run(
          composePlateNumber(spec.agency, seq),
          spec.agency,
          seq,
          spec.plateType,
          segment.id,
          timestamp,
        );
        inserted += Number(result.changes);
      }
    });
  }
  return inserted;
}

/** 生成若干条历史选号记录，让管理后台与统计页有数据可看 */
function seedHistory() {
  const existing = get('SELECT COUNT(*) AS c FROM applications').c;
  if (Number(existing) > 0) return 0;

  const owners = ['张伟', '李娜', '王强', '刘洋', '陈静', '赵敏', '孙磊', '周涛', '吴倩', '郑凯'];
  const models = ['比亚迪 秦PLUS', '大众 朗逸', '丰田 卡罗拉', '特斯拉 Model 3', '本田 CR-V', '吉利 星越L', '五菱 宏光MINIEV'];
  let created = 0;

  for (let i = 0; i < 14; i += 1) {
    const spec = SEGMENT_SEEDS[i % SEGMENT_SEEDS.length];
    const segment = get(
      'SELECT * FROM segments WHERE agency = ? AND plate_type = ? AND pattern = ?',
      spec.agency,
      spec.plateType,
      spec.pattern,
    );
    if (!segment) continue;

    const method = i % 3 === 0 ? 'self' : 'random';
    const status = i % 7 === 6 ? 'canceled' : 'done';
    const daysAgo = 9 - (i % 10);
    const createdAt = new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
    const code = `NP${createdAt.slice(2, 4)}${createdAt.slice(5, 7)}${createdAt.slice(8, 10)}${String(100000 + i * 137).slice(0, 6)}`;

    // 找一个仍未被占用的号码作为历史选号结果
    let resultNumber = null;
    if (status === 'done') {
      const capacity = capacityOf(spec.pattern);
      for (let attempt = 0; attempt < 200 && !resultNumber; attempt += 1) {
        const seq = indexToSeq(spec.pattern, randomInt(capacity));
        const number = composePlateNumber(spec.agency, seq);
        if (!get('SELECT 1 AS hit FROM plates WHERE number = ? AND plate_type = ?', number, spec.plateType)) {
          run(
            `INSERT INTO plates (number, agency, seq, plate_type, segment_id, status, source, updated_at)
             VALUES (?, ?, ?, ?, ?, 'reserved', 'seed', ?) ON CONFLICT(number, plate_type) DO NOTHING`,
            number,
            spec.agency,
            seq,
            spec.plateType,
            segment.id,
            createdAt,
          );
          resultNumber = number;
        }
      }
      if (!resultNumber) continue;
    }

    const expires = new Date(new Date(createdAt).getTime() + RULES.voucherValidDays * 24 * 3600 * 1000).toISOString();
    run(
      `INSERT INTO applications
         (code, owner_name, owner_id_card, owner_phone, vin, vehicle_model, plate_type, agency,
          status, method, result_number, result_segment_id, voucher_code, voucher_expires_at,
          random_batch_used, self_attempt_used, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO NOTHING`,
      code,
      owners[i % owners.length],
      makeIdCard(i),
      makePhone(i + 3),
      makeVin(i + 5),
      models[i % models.length],
      spec.plateType,
      spec.agency,
      status,
      status === 'done' ? method : method,
      resultNumber,
      status === 'done' ? segment.id : null,
      status === 'done' ? `YX${createdAt.slice(0, 4)}${createdAt.slice(5, 7)}${createdAt.slice(8, 10)}${String(10000 + i * 331)}` : null,
      status === 'done' ? expires : null,
      method === 'random' ? 1 + (i % 4) : 0,
      method === 'self' ? 1 + (i % 9) : 0,
      createdAt,
      createdAt,
    );
    created += 1;
  }
  return created;
}

function main() {
  if (RESET) {
    resetDatabase();
    console.log('已清空既有数据');
  } else {
    getDb();
  }

  const segments = seedSegments();
  console.log(`号段：新增 ${segments} 个，当前共 ${get('SELECT COUNT(*) AS c FROM segments').c} 个`);

  const plates = seedOccupiedNumbers();
  console.log(`号码池：写入 ${plates} 个已占用号码，当前共 ${get('SELECT COUNT(*) AS c FROM plates').c} 个`);

  const history = seedHistory();
  if (history) console.log(`历史选号记录：新增 ${history} 条`);

  const summary = all(`
    SELECT s.agency, s.plate_type, s.pattern, COUNT(p.id) AS occupied
      FROM segments s LEFT JOIN plates p ON p.segment_id = s.id
     GROUP BY s.id ORDER BY occupied DESC
  `);
  console.log('\n号段占用概览：');
  for (const row of summary) {
    const capacity = capacityOf(row.pattern);
    const rate = ((Number(row.occupied) / capacity) * 100).toFixed(1);
    console.log(`  ${row.agency} ${PLATE_TYPES[row.plate_type].name.padEnd(8, '　')} ${row.pattern.padEnd(7)} 已占用 ${String(row.occupied).padStart(6)} / ${capacity}（${rate}%）`);
  }
  console.log(`\n数据库文件：${DB_FILE}`);
  console.log('初始化完成。运行 npm start 启动服务。');
}

main();
