/**
 * 业务数据读写（Repository 层）。
 * 只处理 SQL 与数据形状，不含业务规则判断。
 */
import { all, get, nowIso, run, transaction } from './db.js';

/* ---------------------------------- 号段 ---------------------------------- */

export function listSegments({ onlyActive = false } = {}) {
  const where = onlyActive ? "WHERE status = 'active'" : '';
  return all(`SELECT * FROM segments ${where} ORDER BY agency, plate_type, pattern`);
}

export function getSegment(id) {
  return get('SELECT * FROM segments WHERE id = ?', Number(id));
}

export function findSegment(agency, plateType, pattern) {
  return get(
    'SELECT * FROM segments WHERE agency = ? AND plate_type = ? AND pattern = ?',
    agency,
    plateType,
    pattern,
  );
}

export function createSegment({ agency, plateType, pattern, name, remark = null }) {
  const { lastInsertRowid } = run(
    `INSERT INTO segments (agency, plate_type, pattern, name, status, remark, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    agency,
    plateType,
    pattern,
    name,
    remark,
    nowIso(),
  );
  return getSegment(lastInsertRowid);
}

export function setSegmentStatus(id, status) {
  run('UPDATE segments SET status = ? WHERE id = ?', status, Number(id));
  return getSegment(id);
}

export function countPlatesBySegment() {
  return all(
    `SELECT segment_id, COUNT(*) AS occupied,
            SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved
       FROM plates GROUP BY segment_id`,
  );
}

/* --------------------------------- 号码池 --------------------------------- */

/** 号码是否已被占用；plateType 为空时跨号牌种类判断 */
export function isNumberOccupied(number, plateType = null) {
  if (plateType) {
    return get('SELECT 1 AS hit FROM plates WHERE number = ? AND plate_type = ?', number, plateType) !== null;
  }
  return get('SELECT 1 AS hit FROM plates WHERE number = ?', number) !== null;
}

/**
 * 原子占用一个号码。依赖 plates.number 的唯一约束：
 * 插入成功 => 该号码此前未被占用；冲突 => 已被占用。
 */
export function claimNumber({ number, agency, seq, plateType, segmentId, source = 'random' }) {
  const { changes } = run(
    `INSERT INTO plates (number, agency, seq, plate_type, segment_id, status, source, updated_at)
     VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
     ON CONFLICT(number, plate_type) DO NOTHING`,
    number,
    agency,
    seq,
    plateType,
    Number(segmentId),
    source,
    nowIso(),
  );
  return changes === 1;
}

export function insertPlate({ number, agency, seq, plateType, segmentId, status = 'used', source = 'admin' }) {
  const { changes } = run(
    `INSERT INTO plates (number, agency, seq, plate_type, segment_id, status, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(number, plate_type) DO NOTHING`,
    number,
    agency,
    seq,
    plateType,
    Number(segmentId),
    status,
    source,
    nowIso(),
  );
  return changes === 1;
}

export function releaseNumber(number, plateType = null) {
  const { changes } = plateType
    ? run('DELETE FROM plates WHERE number = ? AND plate_type = ?', number, plateType)
    : run('DELETE FROM plates WHERE number = ?', number);
  return changes;
}

export function listPlates({ segmentId = null, keyword = '', status = '', plateType = '', limit = 50, offset = 0 }) {
  const clauses = [];
  const params = [];
  if (segmentId) {
    clauses.push('segment_id = ?');
    params.push(Number(segmentId));
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (plateType) {
    clauses.push('plate_type = ?');
    params.push(plateType);
  }
  if (keyword) {
    clauses.push('number LIKE ?');
    params.push(`%${keyword}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS c FROM plates ${where}`, ...params).c;
  const rows = all(
    `SELECT * FROM plates ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    Number(limit),
    Number(offset),
  );
  return { total: Number(total), rows };
}

/* --------------------------------- 选号申请 -------------------------------- */

export function createApplication(data) {
  const timestamp = nowIso();
  const { lastInsertRowid } = run(
    `INSERT INTO applications
       (code, owner_name, owner_id_card, owner_phone, vin, vehicle_model, plate_type, agency,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'info', ?, ?)`,
    data.code,
    data.ownerName,
    data.ownerIdCard,
    data.ownerPhone,
    data.vin,
    data.vehicleModel ?? null,
    data.plateType,
    data.agency,
    timestamp,
    timestamp,
  );
  return getApplication(lastInsertRowid);
}

export function getApplication(id) {
  return get('SELECT * FROM applications WHERE id = ?', Number(id));
}

export function getApplicationByCode(code) {
  return get('SELECT * FROM applications WHERE code = ?', String(code));
}

export function updateApplication(code, patch) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return getApplicationByCode(code);
  const assignments = fields.map((f) => `${f} = ?`).join(', ');
  run(
    `UPDATE applications SET ${assignments}, updated_at = ? WHERE code = ?`,
    ...fields.map((f) => patch[f]),
    nowIso(),
    code,
  );
  return getApplicationByCode(code);
}

export function listApplications({ keyword = '', status = '', limit = 20, offset = 0 }) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (keyword) {
    clauses.push('(code LIKE ? OR owner_name LIKE ? OR result_number LIKE ? OR owner_phone LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS c FROM applications ${where}`, ...params).c;
  const rows = all(
    `SELECT * FROM applications ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    Number(limit),
    Number(offset),
  );
  return { total: Number(total), rows };
}

/* -------------------------------- 随机选号 -------------------------------- */

export function addRandomBatch(applicationId, batchNo, numbers) {
  const timestamp = nowIso();
  transaction(() => {
    const stmt = 'INSERT INTO random_batches (application_id, batch_no, number, is_picked, created_at) VALUES (?, ?, ?, 0, ?)';
    for (const number of numbers) {
      run(stmt, Number(applicationId), Number(batchNo), number, timestamp);
    }
  });
}

export function listRandomBatches(applicationId) {
  return all(
    'SELECT * FROM random_batches WHERE application_id = ? ORDER BY batch_no, id',
    Number(applicationId),
  );
}

export function pickRandomNumber(applicationId, batchNo, number) {
  transaction(() => {
    // 备选号牌全局最多保留 1 个：先清空本次申请的所有备选，再标记当前选中的号码
    run(
      'UPDATE random_batches SET is_picked = 0 WHERE application_id = ?',
      Number(applicationId),
    );
    run(
      `UPDATE random_batches SET is_picked = 1
        WHERE application_id = ? AND batch_no = ? AND number = ?`,
      Number(applicationId),
      Number(batchNo),
      number,
    );
  });
}

/** 清空备选号牌 */
export function clearRandomPick(applicationId) {
  run('UPDATE random_batches SET is_picked = 0 WHERE application_id = ?', Number(applicationId));
}

/* -------------------------------- 自编选号 -------------------------------- */

export function addSelfAttempt(applicationId, attemptNo, number, ok, reason) {
  run(
    `INSERT INTO self_attempts (application_id, attempt_no, number, ok, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    Number(applicationId),
    Number(attemptNo),
    number,
    ok ? 1 : 0,
    reason ?? null,
    nowIso(),
  );
}

export function listSelfAttempts(applicationId) {
  return all(
    'SELECT * FROM self_attempts WHERE application_id = ? ORDER BY attempt_no, id',
    Number(applicationId),
  );
}

/* --------------------------------- 统计 ---------------------------------- */

export function stats() {
  const applications = get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
      SUM(CASE WHEN status IN ('random', 'self') THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN method = 'random' AND status = 'done' THEN 1 ELSE 0 END) AS by_random,
      SUM(CASE WHEN method = 'self' AND status = 'done' THEN 1 ELSE 0 END) AS by_self
    FROM applications
  `);
  const plates = get(`
    SELECT
      COUNT(*) AS occupied,
      SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN source = 'seed' THEN 1 ELSE 0 END) AS seeded
    FROM plates
  `);
  const recent = all(
    `SELECT code, owner_name, plate_type, method, status, result_number, updated_at
       FROM applications ORDER BY id DESC LIMIT 8`,
  );
  return {
    applications: {
      total: Number(applications.total || 0),
      done: Number(applications.done || 0),
      canceled: Number(applications.canceled || 0),
      inProgress: Number(applications.in_progress || 0),
      byRandom: Number(applications.by_random || 0),
      bySelf: Number(applications.by_self || 0),
    },
    plates: {
      occupied: Number(plates.occupied || 0),
      reserved: Number(plates.reserved || 0),
      seeded: Number(plates.seeded || 0),
    },
    recent,
  };
}
