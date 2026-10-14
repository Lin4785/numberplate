/** 选号业务流程集成测试（使用独立的临时数据库） */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const TEST_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'np-test-')), 'test.db');
process.env.NP_DB_FILE = TEST_DB;

const { closeDb, resetDatabase, run } = await import('../src/db.js');
const store = await import('../src/store.js');
const service = await import('../src/service.js');

/** 生成合法身份证号 */
function makeIdCard(seed) {
  const body = `11010119${String(70 + (seed % 30))}${String(1 + (seed % 12)).padStart(2, '0')}${String(1 + (seed % 28)).padStart(2, '0')}${String(100 + (seed % 900))}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * weights[i];
  return body + checks[sum % 11];
}

let idSeed = 0;
function applicationPayload(overrides = {}) {
  idSeed += 1;
  return {
    ownerName: '测试用户',
    ownerIdCard: makeIdCard(idSeed),
    ownerPhone: '13800001111',
    vin: 'LSVAM4185N2100001',
    vehicleModel: '测试车型',
    plateType: 'small_car',
    agency: '京A',
    ...overrides,
  };
}

before(() => {
  resetDatabase();
  store.createSegment({ agency: '京A', plateType: 'small_car', pattern: '99999', name: '测试号段' });
  store.createSegment({ agency: '京A', plateType: 'new_energy_small', pattern: 'D99999', name: '新能源测试号段' });
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(TEST_DB), { recursive: true, force: true });
});

test('占用号码的写入与查询是原子的', () => {
  const payload = { number: '京A10001', agency: '京A', seq: '10001', plateType: 'small_car', segmentId: 1 };
  assert.equal(store.isNumberOccupied('京A10001', 'small_car'), false);
  assert.equal(store.claimNumber(payload), true);
  assert.equal(store.isNumberOccupied('京A10001', 'small_car'), true);
  assert.equal(store.claimNumber(payload), false, '重复占用同一号码应当失败');
  // 不同号牌种类下相同号码互不影响
  assert.equal(store.isNumberOccupied('京A10001', 'large_car'), false);
});

test('号牌号码唯一性以号牌种类为界', () => {
  store.insertPlate({ number: '京A20001', agency: '京A', seq: '20001', plateType: 'small_car', segmentId: 1 });
  store.insertPlate({ number: '京A20001', agency: '京A', seq: '20001', plateType: 'large_car', segmentId: 1 });
  assert.equal(store.isNumberOccupied('京A20001', 'small_car'), true);
  assert.equal(store.isNumberOccupied('京A20001', 'large_car'), true);
  assert.equal(store.releaseNumber('京A20001', 'large_car'), 1);
  assert.equal(store.isNumberOccupied('京A20001', 'large_car'), false);
  assert.equal(store.isNumberOccupied('京A20001', 'small_car'), true);
});

test('信息校验不通过时不能创建申请', () => {
  assert.throws(() => service.createApplication(applicationPayload({ ownerIdCard: '11010119900307001X' })),
    /身份证号校验位|身份证号/);
  assert.throws(() => service.createApplication(applicationPayload({ ownerPhone: '12345' })), /手机号/);
  assert.throws(() => service.createApplication(applicationPayload({ vin: 'TOO-SHORT-VIN' })), /车架号/);
  assert.throws(() => service.createApplication(applicationPayload({ agency: '沪A' })), /暂无可用于/);
});

test('创建申请后进入待选号状态', () => {
  const detail = service.createApplication(applicationPayload());
  assert.match(detail.application.code, /^NP\d{6}[A-Z0-9]{6}$/);
  assert.equal(detail.application.status, 'info');
  assert.equal(detail.application.ownerIdCard.includes('********'), true, '身份证号应脱敏');
  assert.equal(detail.random.remaining, 5);
  assert.equal(detail.self.remaining, 20);
  assert.equal(detail.segments.length, 1);
});

test('自编选号：格式错误不消耗机会，被占用才消耗', () => {
  const detail = service.createApplication(applicationPayload());
  const code = detail.application.code;

  const bad = service.selfAttempt(code, { number: '京A1234' });
  assert.equal(bad.ok, false);
  assert.equal(bad.consumed, false, '位数不足不应消耗机会');
  assert.equal(bad.detail.self.remaining, 20);

  const wrongAgency = service.selfAttempt(code, { number: '沪A12345' });
  assert.equal(wrongAgency.consumed, false, '属地不符不应消耗机会');

  const occupied = service.selfAttempt(code, { number: '京A10001' });
  assert.equal(occupied.ok, false);
  assert.equal(occupied.consumed, true);
  assert.equal(occupied.detail.self.remaining, 19);

  const outOfSegment = service.selfAttempt(code, { number: '京AA1234' });
  assert.equal(outOfSegment.ok, false);
  assert.equal(outOfSegment.consumed, true, '不在号段范围内应消耗机会');

  const success = service.selfAttempt(code, { number: '京A88888' });
  assert.equal(success.ok, true);
  assert.equal(success.detail.application.status, 'done');
  assert.equal(success.detail.application.resultNumber, '京A88888');
  assert.ok(success.detail.voucher.voucherCode);
  assert.equal(success.detail.voucher.methodName, '自编选号');
  assert.equal(store.isNumberOccupied('京A88888', 'small_car'), true, '选号成功后号码应被占用');
});

test('已完成的申请不能再重复选号', () => {
  const detail = service.createApplication(applicationPayload());
  const code = detail.application.code;
  service.selfAttempt(code, { number: '京A66666' });
  assert.throws(() => service.selfAttempt(code, { number: '京A55555' }), /已完成/);
  assert.throws(() => service.nextRandomBatch(code), /已完成/);
  assert.throws(() => service.cancelApplication(code), /不能作废/);
});

test('随机选号：批次、备选与确认流程', () => {
  const detail = service.createApplication(applicationPayload());
  const code = detail.application.code;

  assert.throws(() => service.confirmRandomPick(code), /请先从随机号码中选择/);

  const batch = service.nextRandomBatch(code);
  assert.equal(batch.batchNo, 1);
  assert.equal(batch.numbers.length, 10);
  assert.equal(new Set(batch.numbers.map((n) => n.number)).size, 10, '同一批号码不应重复');
  for (const item of batch.numbers) {
    assert.equal(store.isNumberOccupied(item.number, 'small_car'), false, '随机号码不应是已占用号码');
    assert.match(item.number, /^京A\d{5}$/);
  }

  const picked = batch.numbers[3].number;
  service.pickRandomNumber(code, { batchNo: 1, number: picked });
  let current = service.getApplicationDetail(code);
  assert.equal(current.random.picked, picked);
  assert.equal(current.application.status, 'random');

  // 换一批后备选只保留最新一次
  const batch2 = service.nextRandomBatch(code);
  assert.equal(batch2.batchNo, 2);
  const shown = new Set([
    ...batch.numbers.map((n) => n.number),
    ...batch2.numbers.map((n) => n.number),
  ]);
  assert.equal(shown.size, 20, '不同批次之间不应重复投放号码');

  const picked2 = batch2.numbers[0].number;
  service.pickRandomNumber(code, { batchNo: 2, number: picked2 });
  current = service.getApplicationDetail(code);
  assert.equal(current.random.picked, picked2, '只应保留 1 个备选号牌');
  assert.equal(current.random.remaining, 3);

  const done = service.confirmRandomPick(code);
  assert.equal(done.application.status, 'done');
  assert.equal(done.application.resultNumber, picked2);
  assert.equal(done.voucher.methodName, '随机选号');
  assert.equal(store.isNumberOccupied(picked2, 'small_car'), true);
});

test('随机选号次数用尽后不能再换批', () => {
  const detail = service.createApplication(applicationPayload());
  const code = detail.application.code;
  for (let i = 0; i < 5; i += 1) {
    service.nextRandomBatch(code);
  }
  const current = service.getApplicationDetail(code);
  assert.equal(current.random.remaining, 0);
  assert.throws(() => service.nextRandomBatch(code), /随机选号机会已用完/);
  // 仍可改用自编选号
  const result = service.selfAttempt(code, { number: '京A77777' });
  assert.equal(result.ok, true);
});

test('自编选号机会用尽后不能再提交', () => {
  const detail = service.createApplication(applicationPayload());
  const code = detail.application.code;
  run('UPDATE applications SET self_attempt_used = 20 WHERE code = ?', code);
  assert.throws(() => service.selfAttempt(code, { number: '京A33333' }), /自编选号机会已用完/);
});

test('号段投放参数校验', () => {
  assert.equal(service.validateSegmentSpec({ agency: '京A', plateType: 'small_car', pattern: '99999' }).ok, true);
  assert.equal(service.validateSegmentSpec({ agency: '京A', plateType: 'small_car', pattern: '9999' }).ok, false, '位数不符');
  assert.equal(service.validateSegmentSpec({ agency: '京A', plateType: 'large_car', pattern: '9A999' }).ok, false, '大型汽车不能含字母');
  assert.equal(service.validateSegmentSpec({ agency: '京A', plateType: 'new_energy_small', pattern: '99999' }).ok, false, '新能源首位须为 D/F');
  assert.equal(service.validateSegmentSpec({ agency: '京I', plateType: 'small_car', pattern: '99999' }).ok, false, '不能使用字母 I');
});

test('号码可用性查询', () => {
  const available = service.checkNumber('京A12345', 'small_car');
  assert.equal(available.ok, true);
  assert.equal(available.occupied, false);
  assert.equal(available.inSegment, true);
  assert.equal(available.available, true);

  const occupied = service.checkNumber('京A10001', 'small_car');
  assert.equal(occupied.occupied, true);
  assert.equal(occupied.available, false);

  const outOfRange = service.checkNumber('京AZ9999', 'small_car');
  assert.equal(outOfRange.inSegment, false);
  assert.equal(outOfRange.available, false);

  const badFormat = service.checkNumber('京A1234', 'small_car');
  assert.equal(badFormat.ok, false);
});

test('作废申请后不能再选号', () => {
  const detail = service.createApplication(applicationPayload());
  const code = detail.application.code;
  const canceled = service.cancelApplication(code);
  assert.equal(canceled.application.status, 'canceled');
  assert.throws(() => service.selfAttempt(code, { number: '京A22222' }), /已作废/);
  assert.throws(() => service.nextRandomBatch(code), /已作废/);
});

test('新能源号牌按 6 位序号生成', () => {
  const detail = service.createApplication(applicationPayload({
    plateType: 'new_energy_small',
    vehicleModel: '特斯拉 Model 3',
  }));
  const code = detail.application.code;
  const result = service.selfAttempt(code, { number: '京AD12345' });
  assert.equal(result.ok, true);
  assert.equal(result.detail.application.resultNumber, '京AD12345');
  assert.equal(result.detail.voucher.plateTypeName, '小型新能源汽车');

  // 首位不是 D/F 的新能源号码应被拒绝
  const other = service.createApplication(applicationPayload({ plateType: 'new_energy_small' }));
  const rejected = service.selfAttempt(other.application.code, { number: '京AA12345' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.consumed, false);
});
