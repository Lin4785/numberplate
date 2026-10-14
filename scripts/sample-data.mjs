/**
 * 生成可直接使用的测试数据，并用项目真实的校验逻辑逐条自检。
 *
 *   node scripts/test-data.mjs             # 打印 Markdown 表格 + 反面用例
 *   node scripts/test-data.mjs --json      # 输出 JSON，便于脚本调用
 *   node scripts/test-data.mjs --create    # 提交到已启动的服务（写入选号记录/管理后台）
 *   node scripts/test-data.mjs --verify    # 创建申请后立刻用配套号码真的选一次号（端到端验证）
 *   NP_BASE=http://127.0.0.1:5173 node scripts/test-data.mjs --create
 *
 * 数据是固定随机种子生成的，所以每次运行结果完全一致。
 * 所有身份证号都经过校验位验算，VIN 都符合"17 位且不含 I/O/Q"的规则。
 */
import '../src/quiet.js';
import { LETTERS, PLATE_TYPES, composePlateNumber, matchesPattern, validateSeq } from '../src/rules.js';
import { validateIdCard, validateName, validatePhone, validateVin } from '../src/validators.js';
import * as store from '../src/store.js';

const BASE = process.env.NP_BASE || 'http://127.0.0.1:5173';
const flags = new Set(process.argv.slice(2));

/* --------------------------- 确定性随机数 --------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261013);
const pick = (list) => list[Math.floor(rand() * list.length)];
const intBetween = (min, max) => min + Math.floor(rand() * (max - min + 1));
const digits = (n) => Array.from({ length: n }, () => String(intBetween(0, 9))).join('');

/* ----------------------------- 生成工具 ----------------------------- */

/** 身份证：地址码 + 出生日期 + 顺序码 + 校验位（校验位按国标加权模 11 计算） */
function makeIdCard(addressCode, year, month, day, sequence) {
  const body = `${addressCode}${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}${sequence}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * weights[i];
  return body + checks[sum % 11];
}

/** VIN：17 位，字符集排除 I、O、Q */
function makeVin(wmi) {
  const charset = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  let vin = wmi;
  while (vin.length < 17) vin += charset[Math.floor(rand() * charset.length)];
  return vin.slice(0, 17);
}

const ADDRESS_CODE = {
  京: '110101', 津: '120101', 沪: '310101', 苏: '320101',
  浙: '330101', 粤: '440301', 川: '510101', 陕: '610101',
};

const PHONE_PREFIX = ['138', '139', '150', '158', '186', '188', '199'];

/** 车主名 + 车型，按号牌种类配好（新能源车配绿牌，汽油车配蓝牌） */
const RECIPE = [
  { name: '张伟', plateType: 'small_car', model: '大众 朗逸 2023款', vinPrefix: 'LSV' },
  { name: '李娜', plateType: 'new_energy_small', model: '特斯拉 Model 3 后驱版', vinPrefix: 'LRW' },
  { name: '王强', plateType: 'new_energy_small', model: '比亚迪 秦PLUS DM-i（插混）', vinPrefix: 'LGX' },
  { name: '刘洋', plateType: 'large_car', model: '福田 欧曼 EST 载货车', vinPrefix: 'LFW' },
  { name: '陈静', plateType: 'moto', model: '雅马哈 巧格 i 125', vinPrefix: 'LB7' },
  { name: '赵敏', plateType: 'coach', model: '大众 桑塔纳 教练车', vinPrefix: 'LSV' },
  { name: '孙磊', plateType: 'new_energy_large', model: '宇通 ZK6128 纯电动客车', vinPrefix: 'LZG' },
  { name: '周涛', plateType: 'small_car', model: '丰田 卡罗拉 双擎', vinPrefix: 'LFM' },
  { name: '吴倩', plateType: 'small_car', model: '本田 CR-V 2024款', vinPrefix: 'LVH' },
  { name: '郑凯', plateType: 'new_energy_small', model: '五菱 宏光MINIEV', vinPrefix: 'LZW' },
];

/** 从数据库里取真实存在的号段，保证属地 + 号牌种类的组合一定能受理 */
function segmentIndex() {
  const index = new Map();
  for (const segment of store.listSegments({ onlyActive: true })) {
    const key = segment.plate_type;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(segment);
  }
  return index;
}

function buildRecords() {
  const index = segmentIndex();
  const records = [];
  let seq = 0;

  for (const recipe of RECIPE) {
    const candidates = index.get(recipe.plateType);
    if (!candidates || candidates.length === 0) continue;
    seq += 1;

    // 按顺序轮换可用属地，让测试数据覆盖多个发牌机关
    const segment = candidates[(seq - 1) % candidates.length];
    const agency = segment.agency;
    const province = agency[0];

    const record = {
      序号: seq,
      车主姓名: recipe.name,
      身份证明号码: makeIdCard(
        ADDRESS_CODE[province] || '110101',
        intBetween(1972, 1998),
        intBetween(1, 12),
        intBetween(1, 28),
        digits(3),
      ),
      手机号码: `${pick(PHONE_PREFIX)}${digits(8)}`,
      车辆识别代号: makeVin(recipe.vinPrefix),
      车辆型号: recipe.model,
      号牌种类: recipe.plateType,
      号牌种类名称: PLATE_TYPES[recipe.plateType].name,
      发牌机关: agency,
      _segment: segment,
    };
    records.push(record);
  }
  return records;
}

/**
 * 在**同属地同号牌种类**的号段里找一个当前确实空闲的号码。
 * 必须限定发牌机关，否则服务端会以"发牌机关代号应为 XX"拒绝。
 */
function findFreeNumber(record) {
  const segments = store
    .listSegments({ onlyActive: true })
    .filter((s) => s.agency === record.发牌机关 && s.plate_type === record.号牌种类);
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const segment = segments[Math.floor(rand() * segments.length)];
    if (!segment) break;
    const seqChars = [...segment.pattern].map((ch) => {
      if (ch === '9') return digits(1);
      if (ch === 'A') return LETTERS[Math.floor(rand() * LETTERS.length)];
      if (ch === '*') return Math.floor(rand() * 2) ? digits(1) : LETTERS[Math.floor(rand() * LETTERS.length)];
      return ch;
    });
    const seq = seqChars.join('');
    const number = composePlateNumber(segment.agency, seq);
    if (!matchesPattern(segment.pattern, seq)) continue;
    if (!store.isNumberOccupied(number, record.号牌种类)) return number;
  }
  return null;
}

/** 找几个"已被占用"的号码用于测试失败路径：每种号牌种类挑 1-2 个靓号 */
function findOccupiedSamples(maxPerType = 2, maxTotal = 10) {
  const out = [];
  const prettySeqs = ['88888', '66666', '12345', '99999', '00001'];
  const byType = new Map();

  for (const segment of store.listSegments({ onlyActive: true })) {
    if (!byType.has(segment.plate_type)) byType.set(segment.plate_type, []);
    byType.get(segment.plate_type).push(segment);
  }

  for (const [type, segments] of byType) {
    let found = 0;
    for (const segment of segments) {
      for (const seq of prettySeqs) {
        if (found >= maxPerType) break;
        if (seq.length !== segment.pattern.length) continue;
        if (!matchesPattern(segment.pattern, seq)) continue;
        const number = composePlateNumber(segment.agency, seq);
        if (store.isNumberOccupied(number, type)) {
          out.push({ 号码: number, 号牌种类: type, 来源: 'seed', 备注: '靓号，必然被占用' });
          found += 1;
        }
      }
    }
    // 该号牌种类没有命中靓号时，补一个普通占用号码保证覆盖
    if (found === 0) {
      const rows = store.listPlates({ plateType: type, status: 'used', limit: 1 }).rows;
      if (rows.length) {
        out.push({ 号码: rows[0].number, 号牌种类: type, 来源: rows[0].source, 备注: '普通占用号码' });
      }
    }
  }
  return out.slice(0, maxTotal);
}

/* --------------------------- 逐条自检 --------------------------- */

function verifyRecords(records) {
  const problems = [];
  const seenIdCards = new Set();
  const seenVins = new Set();

  for (const record of records) {
    const checks = [
      ['姓名', validateName(record.车主姓名)],
      ['身份证', validateIdCard(record.身份证明号码)],
      ['手机号', validatePhone(record.手机号码)],
      ['车架号', validateVin(record.车辆识别代号)],
    ];
    for (const [label, result] of checks) {
      if (!result.ok) problems.push(`#${record.序号} ${label} 未通过：${result.reason}`);
    }
    if (seenIdCards.has(record.身份证明号码)) problems.push(`#${record.序号} 身份证号重复`);
    if (seenVins.has(record.车辆识别代号)) problems.push(`#${record.序号} 车架号重复`);
    seenIdCards.add(record.身份证明号码);
    seenVins.add(record.车辆识别代号);

    // 属地 + 号牌种类必须真实存在可用号段，否则创建申请会被拒（409）
    const segments = store
      .listSegments({ onlyActive: true })
      .filter((s) => s.agency === record.发牌机关 && s.plate_type === record.号牌种类);
    if (segments.length === 0) {
      problems.push(`#${record.序号} ${record.发牌机关} 下没有 ${record.号牌种类名称} 的号段`);
    }
  }
  return problems;
}

/** 反面用例：直接调用真实校验函数，打印实际返回的提示 */
function negativeCases(record) {
  const cases = [
    ['身份证校验位写错（末位改掉）', validateIdCard('110101199003078217'), '车主信息'],
    ['身份证位数不足', validateIdCard('11010119900307'), '车主信息'],
    ['身份证出生日期非法（13 月）', validateIdCard('11010119901307821X'), '车主信息'],
    ['手机号非大陆号段', validatePhone('12345678901'), '车主信息'],
    ['手机号位数不足', validatePhone('1380013800'), '车主信息'],
    ['车架号含字母 O', validateVin('LSVAM4185N2100O77'), '车主信息'],
    ['车架号位数不足', validateVin('LSVAM4185N2100'), '车主信息'],
    ['姓名只有一个字', validateName('张'), '车主信息'],
  ];

  const type = record ? record.号牌种类 : 'small_car';
  cases.push(
    ['序号位数不足（4 位）', validateSeq(type, '1234'), '自编号码'],
    ['序号含字母 I', validateSeq(type, '1234I'), '自编号码'],
  );
  if (type === 'small_car') {
    cases.push(
      ['小型汽车序号用满 3 个字母', validateSeq('small_car', 'ABC12'), '自编号码'],
      ['小型汽车序号 6 位（多了 1 位）', validateSeq('small_car', '123456'), '自编号码'],
    );
  }
  if (type === 'new_energy_small') {
    cases.push(
      ['新能源序号首位不是 D/F', validateSeq('new_energy_small', 'A12345'), '自编号码'],
      ['新能源序号第 2 位用了字母', validateSeq('new_energy_small', 'DD1234'), '自编号码'],
    );
  }
  return cases;
}

/* ----------------------------- 输出 ----------------------------- */

function pad(value, width) {
  // 中文按两个字符宽度对齐，避免表格错位
  let visual = 0;
  for (const ch of String(value)) visual += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
  return String(value) + ' '.repeat(Math.max(0, width - visual));
}

function printTable(records) {
  const columns = [
    ['序号', 4], ['车主姓名', 8], ['身份证明号码', 18], ['手机号码', 11],
    ['车辆识别代号', 17], ['车辆型号', 24], ['号牌种类', 16], ['发牌机关', 8],
  ];
  console.log(columns.map(([name, width]) => pad(name, width)).join(' '));
  console.log(columns.map(([, width]) => '-'.repeat(width)).join(' '));
  for (const record of records) {
    console.log(columns.map(([name, width]) => pad(record[name], width)).join(' '));
  }
}

async function createApplications(records) {
  console.log(`\n提交到服务：${BASE}\n`);
  for (const record of records) {
    const response = await fetch(`${BASE}/api/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerName: record.车主姓名,
        ownerIdCard: record.身份证明号码,
        ownerPhone: record.手机号码,
        vin: record.车辆识别代号,
        vehicleModel: record.车辆型号,
        plateType: record.号牌种类,
        agency: record.发牌机关,
      }),
    });
    const payload = await response.json().catch(() => null);
    const code = payload?.application?.code;
    console.log(
      `  ${response.status} ${record.车主姓名} ${record.发牌机关}·${record.号牌种类名称}` +
      (code ? `  -> 申请编号 ${code}` : `  -> ${payload?.error || '失败'}`),
    );
  }
  console.log('\n提示：这些申请处于「待选号」状态，可在选号大厅用申请编号继续办理。');
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/**
 * 端到端验证：用生成的每条记录创建申请，再用配套的自编号码真的选一次号。
 * 这是对"测试数据确实可用"最直接的证明。
 */
async function verifyAgainstServer(records) {
  console.log(`\n用生成的测试数据跑一遍真实选号流程（服务：${BASE}）\n`);
  let ok = 0;
  let fail = 0;

  for (const record of records) {
    const created = await post('/api/applications', {
      ownerName: record.车主姓名,
      ownerIdCard: record.身份证明号码,
      ownerPhone: record.手机号码,
      vin: record.车辆识别代号,
      vehicleModel: record.车辆型号,
      plateType: record.号牌种类,
      agency: record.发牌机关,
    });

    if (!created.json?.application?.code) {
      fail += 1;
      console.log(`  ✘ ${pad(record.车主姓名, 8)} 创建申请失败：${created.json?.error || created.status}`);
      continue;
    }

    const code = created.json.application.code;
    const number = selfNumbers.get(record.序号);
    const attempt = await post(`/api/applications/${code}/self/attempt`, { number });

    if (attempt.json?.ok) {
      ok += 1;
      console.log(`  ✔ ${pad(record.车主姓名, 8)} ${pad(number, 10)} ${pad(record.发牌机关 + '·' + record.号牌种类名称, 26)} 选号成功（申请编号 ${code}）`);
    } else {
      fail += 1;
      console.log(`  ✘ ${pad(record.车主姓名, 8)} ${pad(number, 10)} ${attempt.json?.reason || '失败'}`);
    }
  }

  console.log(`\n端到端结果：成功 ${ok} 条，失败 ${fail} 条`);
  return fail;
}

/* ------------------------------ 主流程 ------------------------------ */

const records = buildRecords();
const problems = verifyRecords(records);
const selfNumbers = new Map(records.map((record) => [record.序号, findFreeNumber(record)]));
const occupiedSamples = findOccupiedSamples();

if (flags.has('--json')) {
  console.log(JSON.stringify({
    records: records.map(({ _segment, ...rest }) => rest),
    selfNumbers: Object.fromEntries(selfNumbers),
    occupiedSamples,
  }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log('='.repeat(96));
console.log('可直接使用的测试车主/车辆信息（全部通过项目自身的校验函数）');
console.log('='.repeat(96));
printTable(records);

console.log('\n自检结果：', problems.length === 0
  ? `✅ ${records.length} 条记录全部通过姓名/身份证/手机号/车架号校验，属地与号牌种类均有可用号段`
  : `❌ 发现 ${problems.length} 个问题`);
for (const item of problems) console.log('   ' + item);

console.log('\n' + '='.repeat(96));
console.log('配套的自编号码（当前确实空闲，提交即可成功）');
console.log('='.repeat(96));
for (const record of records) {
  const number = selfNumbers.get(record.序号);
  console.log(`  ${pad(record.发牌机关 + ' · ' + record.号牌种类名称, 30)} 自编试试 ${number || '（未找到空闲号码）'}`);
}

console.log('\n' + '='.repeat(96));
console.log('已被占用的号码（用于测试"号码被占用"的失败路径）');
console.log('='.repeat(96));
for (const item of occupiedSamples) {
  console.log(`  ${pad(item.号码, 12)} ${pad(PLATE_TYPES[item.号牌种类]?.name || item.号牌种类, 18)} 来源：${item.来源}`);
}
console.log('  提示：以上号码放进自编选号会提示"已被使用"并消耗 1 次机会。');

console.log('\n' + '='.repeat(96));
console.log('反面用例（故意写错的输入，以及系统实际返回的提示）');
console.log('='.repeat(96));
for (const [label, result, stage] of negativeCases(records[0])) {
  const mark = result.ok ? '⚠️ 未被拦截' : '✅ 已拦截';
  console.log(`  ${mark}  ${pad(stage, 10)} ${pad(label, 30)} ${result.ok ? '' : result.reason}`);
}

console.log('\n' + '='.repeat(96));
console.log('说明');
console.log('='.repeat(96));
console.log('  · 数据由固定随机种子生成，每次运行结果一致；身份证号经校验位验算，VIN 符合 17 位规则。');
console.log('  · 均为虚构数据，不对应任何真实个人或车辆。');
console.log('  · 加 --json 输出 JSON；加 --create 可直接把上述申请写入运行中的服务。');

if (flags.has('--create')) {
  await createApplications(records);
}

let verifyFailures = 0;
if (flags.has('--verify')) {
  verifyFailures = await verifyAgainstServer(records);
}

process.exit(problems.length || verifyFailures ? 1 : 0);
