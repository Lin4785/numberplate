/** 号牌规则引擎单元测试：node --test test/ */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LETTERS,
  PLATE_TYPES,
  capacityOf,
  charsetFor,
  describePattern,
  indexToSeq,
  isValidAgency,
  isValidPattern,
  matchesPattern,
  seqToIndex,
  splitPlateNumber,
  validatePlateNumber,
  validateSeq,
} from '../src/rules.js';

test('字母集排除易混淆的 I、O', () => {
  assert.equal(LETTERS.length, 24);
  assert.ok(!LETTERS.includes('I'));
  assert.ok(!LETTERS.includes('O'));
});

test('模板字符集解析', () => {
  assert.deepEqual(charsetFor('9'), '0123456789'.split(''));
  assert.equal(charsetFor('A').length, 24);
  assert.equal(charsetFor('*').length, 34);
  assert.deepEqual(charsetFor('D'), ['D']); // 新能源固定前缀
  assert.throws(() => charsetFor('I'));
  assert.throws(() => charsetFor('#'));
});

test('模板容量计算', () => {
  assert.equal(capacityOf('99999'), 100000);
  assert.equal(capacityOf('9A999'), 240000);
  assert.equal(capacityOf('D99999'), 100000);
  assert.equal(capacityOf('999999'), 1000000);
});

test('下标与序号可双向换算', () => {
  for (const pattern of ['99999', '9A999', 'A9999', 'D99999']) {
    const capacity = capacityOf(pattern);
    for (const index of [0, 1, 12345, capacity - 1]) {
      const seq = indexToSeq(pattern, index);
      assert.ok(matchesPattern(pattern, seq), `${pattern} -> ${seq} 应匹配模板`);
      assert.equal(seqToIndex(pattern, seq), index);
    }
    assert.throws(() => indexToSeq(pattern, capacity));
    assert.throws(() => indexToSeq(pattern, -1));
  }
});

test('indexToSeq 生成的新能源号码以 D 开头', () => {
  for (let i = 0; i < 20; i += 1) {
    const seq = indexToSeq('D99999', i * 997);
    assert.equal(seq[0], 'D');
    assert.equal(seq.length, 6);
  }
});

test('发牌机关代号校验', () => {
  assert.ok(isValidAgency('京A'));
  assert.ok(isValidAgency('粤B'));
  assert.ok(!isValidAgency('京I'));
  assert.ok(!isValidAgency('京O'));
  assert.ok(!isValidAgency('A京'));
  assert.ok(!isValidAgency('京'));
});

test('小型汽车序号校验', () => {
  assert.equal(validateSeq('small_car', '12345').ok, true);
  assert.equal(validateSeq('small_car', 'A1234').ok, true);
  assert.equal(validateSeq('small_car', 'AB123').ok, true);
  assert.equal(validateSeq('small_car', 'ABC12').ok, false, '字母不得超过 2 位');
  assert.equal(validateSeq('small_car', '1234').ok, false, '位数必须是 5 位');
  assert.equal(validateSeq('small_car', '1234I').ok, false, '不得包含 I');
  assert.equal(validateSeq('small_car', '1234O').ok, false, '不得包含 O');
});

test('新能源汽车序号校验', () => {
  assert.equal(validateSeq('new_energy_small', 'D12345').ok, true);
  assert.equal(validateSeq('new_energy_small', 'F12345').ok, true);
  assert.equal(validateSeq('new_energy_small', 'A12345').ok, false, '首位必须是 D 或 F');
  assert.equal(validateSeq('new_energy_small', 'D1234').ok, false, '位数必须是 6 位');
  assert.equal(validateSeq('new_energy_small', 'DD1234').ok, false, '除首位外不能含字母');
});

test('大型汽车序号必须为纯数字', () => {
  assert.equal(validateSeq('large_car', '12345').ok, true);
  assert.equal(validateSeq('large_car', 'A2345').ok, false);
});

test('完整号牌号码校验', () => {
  assert.equal(validatePlateNumber('京A', '12345', 'small_car').ok, true);
  assert.equal(validatePlateNumber('京', '12345', 'small_car').ok, false);
  assert.equal(validatePlateNumber('京A', 'D12345', 'new_energy_small').ok, true);
});

test('模板合法性判断', () => {
  assert.ok(isValidPattern('99999'));
  assert.ok(isValidPattern('D99999'));
  assert.ok(!isValidPattern(''));
  assert.ok(!isValidPattern('99I99'));
  assert.ok(!isValidPattern('99#99'));
});

test('模板可读化描述', () => {
  assert.equal(describePattern('9A999'), '第1位数字、第2位字母、第3位数字、第4位数字、第5位数字');
  assert.equal(describePattern('D9'), '第1位固定"D"、第2位数字');
});

test('号牌号码输入解析：忽略分隔符与大小写', () => {
  assert.deepEqual(splitPlateNumber('京A·12345'), { agency: '京A', seq: '12345' });
  assert.deepEqual(splitPlateNumber('京a12345'), { agency: '京A', seq: '12345' });
  assert.deepEqual(splitPlateNumber('  京AD 12345 '), { agency: '京A', seq: 'D12345' });
  assert.equal(splitPlateNumber('京A'), null);
});

test('各号牌种类的序号位数与定义一致', () => {
  assert.equal(PLATE_TYPES.small_car.seqLen, 5);
  assert.equal(PLATE_TYPES.new_energy_small.seqLen, 6);
  assert.deepEqual(PLATE_TYPES.new_energy_small.fixedFirstChars, ['D', 'F']);
});
