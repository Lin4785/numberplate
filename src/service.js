/**
 * 选号业务服务层：随机选号、自编选号、号码确认与凭证签发。
 */
import {
  LETTERS,
  PLATE_TYPES,
  capacityOf,
  charsetFor,
  composePlateNumber,
  describePattern,
  formatPlateNumber,
  getPlateType,
  indexToSeq,
  isValidAgency,
  isValidPattern,
  matchesPattern,
  splitPlateNumber,
  validatePlateNumber,
} from './rules.js';
import { RULES } from './config.js';
import { log, nowIso } from './db.js';
import * as store from './store.js';
import { validateIdCard, validateName, validatePhone, validateVin } from './validators.js';

/** 业务异常：会被 HTTP 层转换成对应的状态码与提示 */
export class ServiceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ServiceError';
    this.statusCode = statusCode;
  }
}

const randomInt = (max) => Math.floor(Math.random() * max);
const randomFrom = (arr) => arr[randomInt(arr.length)];

function randomCode(charCount) {
  const alphabet = `${LETTERS.join('')}0123456789`;
  let out = '';
  for (let i = 0; i < charCount; i += 1) out += randomFrom([...alphabet]);
  return out;
}

function makeApplicationCode() {
  const d = new Date();
  const stamp = [
    String(d.getFullYear()).slice(2),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
  return `NP${stamp}${randomCode(6)}`;
}

function makeVoucherCode() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
  return `YX${stamp}${randomCode(5)}`;
}

/* --------------------------------- 号段 ---------------------------------- */

function occupiedMap() {
  const map = new Map();
  for (const row of store.countPlatesBySegment()) {
    map.set(Number(row.segment_id), Number(row.occupied));
  }
  return map;
}

/** 号段附加容量信息（用于公示页与管理后台） */
export function decorateSegment(segment, occupied) {
  const capacity = capacityOf(segment.pattern);
  const used = occupied.get(Number(segment.id)) ?? 0;
  const sampleSeq = seqSample(segment.pattern);
  return {
    ...segment,
    plateTypeName: PLATE_TYPES[segment.plate_type]?.name ?? segment.plate_type,
    capacity,
    occupied: used,
    remaining: Math.max(0, capacity - used),
    usageRate: capacity > 0 ? used / capacity : 0,
    patternText: describePattern(segment.pattern),
    sampleNumber: composePlateNumber(segment.agency, sampleSeq),
    sampleFormatted: formatPlateNumber(segment.agency, sampleSeq),
  };
}

/** 按模板生成一个示例序号，用于展示号段范围 */
function seqSample(pattern) {
  return [...pattern]
    .map((ch) => {
      const set = charsetFor(ch);
      return set.length === 1 ? set[0] : set[set.length - 1];
    })
    .join('');
}

/** 公示号段列表（可选按属地 + 号牌种类过滤） */
export function publicSegments({ agency, plateType } = {}) {
  const occupied = occupiedMap();
  return store
    .listSegments({ onlyActive: true })
    .filter((s) => (!agency || s.agency === agency) && (!plateType || s.plate_type === plateType))
    .map((s) => decorateSegment(s, occupied));
}

/** 某个属地 + 号牌种类下真正可用的号段 */
function availableSegments(agency, plateType) {
  const occupied = occupiedMap();
  return store
    .listSegments({ onlyActive: true })
    .filter((s) => s.agency === agency && s.plate_type === plateType)
    .map((s) => decorateSegment(s, occupied))
    .filter((s) => s.remaining > 0);
}

/** 属地 + 号牌种类下是否存在可用号段（供信息录入时提前拦截） */
export function hasSegmentsFor(agency, plateType) {
  return availableSegments(agency, plateType).length > 0;
}

/** 校验新增号段的合法性（管理员在后台投放新号段时使用） */
export function validateSegmentSpec({ agency, plateType, pattern }) {
  if (!PLATE_TYPES[plateType]) return { ok: false, reason: '号牌种类不存在' };
  const type = PLATE_TYPES[plateType];
  if (!isValidAgency(agency)) return { ok: false, reason: '发牌机关代号不合法（省份简称 + 字母，且不含 I、O）' };
  if (!isValidPattern(pattern)) return { ok: false, reason: '号段模板不合法（仅支持 9 / A / * 与数字字母字面量）' };
  if (pattern.length !== type.seqLen) {
    return { ok: false, reason: `${type.name}号牌序号应为 ${type.seqLen} 位，当前模板为 ${pattern.length} 位` };
  }
  if (type.fixedFirstChars && !type.fixedFirstChars.includes(pattern[0])) {
    return { ok: false, reason: `${type.name}号段模板首位必须为 ${type.fixedFirstChars.join(' 或 ')}` };
  }
  if (/[IO]/.test(pattern)) return { ok: false, reason: '模板中不能包含字母 I、O' };

  let letterCapable = 0;
  let alwaysLetter = 0;
  for (const ch of pattern) {
    const set = charsetFor(ch);
    const hasLetters = set.some((c) => LETTERS.includes(c));
    if (hasLetters) letterCapable += 1;
    if (set.length === 1 && LETTERS.includes(set[0])) alwaysLetter += 1;
  }
  if (type.maxLetters === 0 && letterCapable > 0) {
    return { ok: false, reason: `${type.name}号牌的序号不能包含字母，请使用纯数字模板` };
  }
  if (alwaysLetter > type.maxLetters || letterCapable > type.maxLetters) {
    return {
      ok: false,
      reason: `该号牌种类序号最多允许 ${type.maxLetters} 位字母，当前模板最多可产生 ${Math.max(alwaysLetter, letterCapable)} 位字母`,
    };
  }
  return { ok: true };
}

/* ------------------------------- 选号申请 -------------------------------- */

export function createApplication(payload) {
  const name = validateName(payload.ownerName);
  if (!name.ok) throw new ServiceError(name.reason);
  const idCard = validateIdCard(payload.ownerIdCard);
  if (!idCard.ok) throw new ServiceError(idCard.reason);
  const phone = validatePhone(payload.ownerPhone);
  if (!phone.ok) throw new ServiceError(phone.reason);
  const vin = validateVin(payload.vin);
  if (!vin.ok) throw new ServiceError(vin.reason);

  const plateType = String(payload.plateType || '');
  if (!PLATE_TYPES[plateType]) throw new ServiceError('请选择号牌种类');

  const agency = String(payload.agency || '').toUpperCase();
  if (!/^[\u4e00-\u9fa5][A-HJ-NP-Z]$/.test(agency)) {
    throw new ServiceError('请选择正确的发牌机关代号（属地）');
  }

  if (!hasSegmentsFor(agency, plateType)) {
    throw new ServiceError(`该属地（${agency}）暂无可用于${PLATE_TYPES[plateType].name}选号的号段，请更换属地或号牌种类`, 409);
  }

  const application = store.createApplication({
    code: makeApplicationCode(),
    ownerName: name.value,
    ownerIdCard: idCard.value,
    ownerPhone: phone.value,
    vin: vin.value,
    vehicleModel: String(payload.vehicleModel || '').slice(0, 60) || null,
    plateType,
    agency,
  });
  log('application', 'create', { code: application.code, agency, plateType });
  return getApplicationDetail(application.code);
}

export function requireApplication(code) {
  const application = store.getApplicationByCode(code);
  if (!application) throw new ServiceError('未找到该选号申请，请确认申请编号是否正确', 404);
  return application;
}

export function getApplicationDetail(code) {
  const application = requireApplication(code);
  const occupied = occupiedMap();
  const segments = store
    .listSegments()
    .filter((s) => s.agency === application.agency && s.plate_type === application.plate_type)
    .map((s) => decorateSegment(s, occupied));

  const batches = store.listRandomBatches(application.id);
  const attempts = store.listSelfAttempts(application.id);

  return {
    application: serializeApplication(application),
    plateType: PLATE_TYPES[application.plate_type],
    segments,
    limits: {
      randomBatchSize: RULES.randomBatchSize,
      randomBatchLimit: RULES.randomBatchLimit,
      selfAttemptLimit: RULES.selfAttemptLimit,
      voucherValidDays: RULES.voucherValidDays,
    },
    random: {
      batches: groupBatches(batches),
      picked: batches.find((b) => b.is_picked)?.number ?? null,
      used: application.random_batch_used,
      remaining: Math.max(0, RULES.randomBatchLimit - application.random_batch_used),
    },
    self: {
      attempts: attempts.map((a) => ({
        attemptNo: a.attempt_no,
        number: a.number,
        ok: Boolean(a.ok),
        reason: a.reason,
        createdAt: a.created_at,
      })),
      used: application.self_attempt_used,
      remaining: Math.max(0, RULES.selfAttemptLimit - application.self_attempt_used),
    },
    voucher: application.status === 'done' ? buildVoucher(application) : null,
  };
}

function serializeApplication(app) {
  return {
    code: app.code,
    ownerName: app.owner_name,
    ownerIdCard: maskIdCard(app.owner_id_card),
    ownerPhone: maskPhone(app.owner_phone),
    vin: app.vin,
    vehicleModel: app.vehicle_model,
    plateType: app.plate_type,
    plateTypeName: PLATE_TYPES[app.plate_type]?.name ?? app.plate_type,
    agency: app.agency,
    status: app.status,
    method: app.method,
    resultNumber: app.result_number,
    resultNumberFormatted: app.result_number
      ? formatPlateNumber(app.result_number.slice(0, 2), app.result_number.slice(2))
      : null,
    createdAt: app.created_at,
    updatedAt: app.updated_at,
  };
}

function groupBatches(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.batch_no)) map.set(row.batch_no, []);
    map.get(row.batch_no).push({
      number: row.number,
      formatted: formatPlateNumber(row.number.slice(0, 2), row.number.slice(2)),
      picked: Boolean(row.is_picked),
    });
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([batchNo, numbers]) => ({ batchNo, numbers }));
}

function maskIdCard(id) {
  if (!id || id.length < 8) return id;
  return `${id.slice(0, 6)}********${id.slice(-4)}`;
}

function maskPhone(phone) {
  if (!phone || phone.length !== 11) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/* ------------------------------- 随机选号 -------------------------------- */

/**
 * 从若干号段中随机抽取若干"当前未被占用"的号码。
 * 策略：按剩余容量加权选择号段 -> 在号段内随机取下标 -> 冲突则重试。
 */
function sampleAvailableNumbers(segments, count, excluded = new Set()) {
  const candidates = segments.filter((s) => s.remaining > 0);
  const picked = [];
  const taken = new Set(excluded);
  const weights = candidates.map((s) => Math.max(1, s.remaining));
  let guard = 0;

  while (picked.length < count && guard < count * 60 && candidates.length > 0) {
    guard += 1;
    // 轮盘赌选号段
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let ticket = Math.random() * totalWeight;
    let segment = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i += 1) {
      ticket -= weights[i];
      if (ticket <= 0) {
        segment = candidates[i];
        break;
      }
    }

    const capacity = capacityOf(segment.pattern);
    const maxTries = Math.min(capacity, 800);
    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      const index = randomInt(capacity);
      const seq = indexToSeqSafe(segment.pattern, index);
      if (!seq) break;
      const number = composePlateNumber(segment.agency, seq);
      if (taken.has(number)) continue;
      if (store.isNumberOccupied(number)) continue;
      taken.add(number);
      picked.push({ number, segmentId: segment.id, agency: segment.agency, seq });
      break;
    }
  }
  return picked;
}

function indexToSeqSafe(pattern, index) {
  try {
    return indexToSeq(pattern, index);
  } catch {
    return null;
  }
}

export function nextRandomBatch(code) {
  const application = requireApplication(code);
  if (application.status === 'done') throw new ServiceError('本次选号已完成，不能再次随机选号', 409);
  if (application.status === 'canceled') throw new ServiceError('本次选号已作废', 409);
  if (application.random_batch_used >= RULES.randomBatchLimit) {
    throw new ServiceError('随机选号机会已用完（共 5 批），请确认备选号牌或改用自编选号', 409);
  }

  const segments = availableSegments(application.agency, application.plate_type);
  if (segments.length === 0) throw new ServiceError('该属地号段已用尽，请联系车管所', 409);

  const shown = new Set(store.listRandomBatches(application.id).map((b) => b.number));
  const batchNo = application.random_batch_used + 1;
  const drawn = sampleAvailableNumbers(segments, RULES.randomBatchSize, shown);
  if (drawn.length === 0) throw new ServiceError('号牌资源紧张，本次未能抽取到号码，请稍后重试', 503);

  store.addRandomBatch(application.id, batchNo, drawn.map((d) => d.number));
  store.updateApplication(code, {
    status: 'random',
    method: 'random',
    random_batch_used: batchNo,
  });
  log('random', 'batch', { code, batchNo, count: drawn.length });

  return {
    batchNo,
    numbers: drawn.map((d) => ({
      number: d.number,
      formatted: formatPlateNumber(d.agency, d.seq),
    })),
    remaining: Math.max(0, RULES.randomBatchLimit - batchNo),
  };
}

export function pickRandomNumber(code, { batchNo, number }) {
  const application = requireApplication(code);
  if (application.status === 'done') throw new ServiceError('本次选号已完成', 409);
  const batches = store.listRandomBatches(application.id);
  const target = batches.find((b) => Number(b.batch_no) === Number(batchNo) && b.number === number);
  if (!target) throw new ServiceError('号码不在当前随机批次中', 400);
  store.pickRandomNumber(application.id, Number(batchNo), number);
  return getApplicationDetail(code);
}

export function confirmRandomPick(code) {
  const application = requireApplication(code);
  if (application.status === 'done') throw new ServiceError('本次选号已完成', 409);
  const picked = store.listRandomBatches(application.id).find((b) => b.is_picked);
  if (!picked) throw new ServiceError('请先从随机号码中选择一个备选号牌', 400);

  const agency = picked.number.slice(0, 2);
  const seq = picked.number.slice(2);
  const segment = store
    .listSegments()
    .find((s) => s.agency === agency && s.plate_type === application.plate_type && matchesPattern(s.pattern, seq));
  if (!segment) {
    store.clearRandomPick(application.id);
    throw new ServiceError('该号码已不在可选号段范围内，请重新选择备选号牌', 409);
  }

  // 备选号码在随机投放时是空闲的，确认时仍需原子占用，避免与他人冲突
  const claimed = store.claimNumber({
    number: picked.number,
    agency,
    seq,
    plateType: application.plate_type,
    segmentId: segment.id,
    source: 'random',
  });
  if (!claimed) {
    store.clearRandomPick(application.id);
    throw new ServiceError(`备选号牌 ${formatPlateNumber(agency, seq)} 已被他人占用，请重新选择`, 409);
  }

  return finish(application, picked.number, 'random', Number(picked.batch_no));
}

/* ------------------------------- 自编选号 -------------------------------- */

export function selfAttempt(code, { number }) {
  const application = requireApplication(code);
  if (application.status === 'done') throw new ServiceError('本次选号已完成', 409);
  if (application.status === 'canceled') throw new ServiceError('本次选号已作废', 409);
  if (application.self_attempt_used >= RULES.selfAttemptLimit) {
    throw new ServiceError(`自编选号机会已用完（共 ${RULES.selfAttemptLimit} 次）`, 409);
  }

  const parsed = splitPlateNumber(number);
  if (!parsed) throw new ServiceError('请输入完整的号牌号码，例如 京A12345');

  const { agency, seq } = parsed;
  const formatted = formatPlateNumber(agency, seq);

  // 1) 基础格式校验：格式不合法不消耗机会
  const validity = validatePlateNumber(agency, seq, application.plate_type);
  if (!validity.ok) {
    return { ok: false, consumed: false, reason: validity.reason, detail: getApplicationDetail(code) };
  }
  if (agency !== application.agency) {
    return {
      ok: false,
      consumed: false,
      reason: `发牌机关代号应为 ${application.agency}（本车属地）`,
      detail: getApplicationDetail(code),
    };
  }

  // 2) 是否属于本属地可选号段
  const segments = availableSegments(application.agency, application.plate_type);
  const segment = segments.find((s) => matchesPattern(s.pattern, seq));
  if (!segment) {
    const attemptNo = application.self_attempt_used + 1;
    store.addSelfAttempt(application.id, attemptNo, number, 0, '该号码不在本属地已投放的号段范围内');
    store.updateApplication(code, { status: 'self', method: 'self', self_attempt_used: attemptNo });
    return {
      ok: false,
      consumed: true,
      reason: '该号码不在本属地已投放的号段范围内，请按公示号段自编',
      detail: getApplicationDetail(code),
    };
  }

  const attemptNo = application.self_attempt_used + 1;

  // 3) 占用校验 + 原子占用
  if (store.isNumberOccupied(number, application.plate_type)) {
    store.addSelfAttempt(application.id, attemptNo, number, 0, '该号牌号码已被使用');
    store.updateApplication(code, { status: 'self', method: 'self', self_attempt_used: attemptNo });
    return {
      ok: false,
      consumed: true,
      reason: `号牌号码 ${formatted} 已被使用，请另行自编`,
      detail: getApplicationDetail(code),
    };
  }

  const claimed = store.claimNumber({
    number,
    agency,
    seq,
    plateType: application.plate_type,
    segmentId: segment.id,
    source: 'self',
  });
  if (!claimed) {
    store.addSelfAttempt(application.id, attemptNo, number, 0, '该号牌号码已被占用（并发冲突）');
    store.updateApplication(code, { status: 'self', method: 'self', self_attempt_used: attemptNo });
    return {
      ok: false,
      consumed: true,
      reason: `号牌号码 ${formatted} 刚刚被占用，请另行自编`,
      detail: getApplicationDetail(code),
    };
  }

  store.addSelfAttempt(application.id, attemptNo, number, 1, '选号成功');
  store.updateApplication(code, { self_attempt_used: attemptNo });
  return {
    ok: true,
    consumed: true,
    reason: '选号成功',
    detail: finish(requireApplication(code), number, 'self', attemptNo),
  };
}

/* ------------------------------ 完成与凭证 ------------------------------- */

function finish(application, number, method, extraNo) {
  const expires = new Date(Date.now() + RULES.voucherValidDays * 24 * 60 * 60 * 1000);
  const voucherCode = makeVoucherCode();
  const segment = store
    .listSegments()
    .find((s) => matchesPattern(s.pattern, number.slice(2)) && s.agency === number.slice(0, 2));

  store.updateApplication(application.code, {
    status: 'done',
    method,
    result_number: number,
    result_segment_id: segment ? segment.id : null,
    voucher_code: voucherCode,
    voucher_expires_at: expires.toISOString(),
  });
  log(method, 'success', { code: application.code, number, method, extraNo });
  return getApplicationDetail(application.code);
}

export function cancelApplication(code) {
  const application = requireApplication(code);
  if (application.status === 'done') {
    throw new ServiceError('已完成的选号不能作废；如需放弃该号牌，请联系车管所', 409);
  }
  store.updateApplication(code, { status: 'canceled' });
  log('application', 'cancel', { code });
  return getApplicationDetail(code);
}

export function buildVoucher(application) {
  if (application.status !== 'done' || !application.result_number) return null;
  const number = application.result_number;
  const agency = number.slice(0, 2);
  const seq = number.slice(2);
  const expired = application.voucher_expires_at && new Date(application.voucher_expires_at) < new Date();
  return {
    voucherCode: application.voucher_code,
    applicationCode: application.code,
    plateNumber: number,
    plateNumberFormatted: formatPlateNumber(agency, seq),
    plateType: application.plate_type,
    plateTypeName: PLATE_TYPES[application.plate_type]?.name ?? application.plate_type,
    ownerName: application.owner_name,
    ownerIdCard: maskIdCard(application.owner_id_card),
    ownerPhone: maskPhone(application.owner_phone),
    vin: application.vin,
    vehicleModel: application.vehicle_model,
    method: application.method,
    methodName: application.method === 'self' ? '自编选号' : '随机选号',
    issuedAt: application.updated_at,
    expiresAt: application.voucher_expires_at,
    expired: Boolean(expired),
    validDays: RULES.voucherValidDays,
  };
}

/* ------------------------------- 号码查询 -------------------------------- */

/** 公开的号码可用性查询（不消耗机会） */
export function checkNumber(number, plateType) {
  const parsed = splitPlateNumber(number);
  if (!parsed) return { ok: false, reason: '请输入完整的号牌号码，例如 京A12345' };
  const { agency, seq } = parsed;
  const typeCode = plateType || null;
  if (typeCode) {
    const validity = validatePlateNumber(agency, seq, typeCode);
    if (!validity.ok) return { ok: false, reason: validity.reason };
  }
  const type = typeCode ? getPlateType(typeCode) : null;
  const segments = store
    .listSegments({ onlyActive: true })
    .filter((s) => s.agency === agency && (!typeCode || s.plate_type === typeCode) && matchesPattern(s.pattern, seq));
  const occupied = store.isNumberOccupied(composePlateNumber(agency, seq), typeCode);
  return {
    ok: true,
    number: composePlateNumber(agency, seq),
    formatted: formatPlateNumber(agency, seq),
    available: !occupied && segments.length > 0,
    occupied,
    inSegment: segments.length > 0,
    plateTypeName: type ? type.name : null,
  };
}

export { PLATE_TYPES, capacityOf, describePattern };
