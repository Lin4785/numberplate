/**
 * 车主/车辆信息校验（身份证、手机号、车架号）。
 */

/** 18 位身份证号校验（含校验位计算） */
export function validateIdCard(input) {
  const id = String(input || '').trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) {
    return { ok: false, reason: '身份证号应为 18 位（末位可为 X）' };
  }
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(id[i]) * weights[i];
  if (checks[sum % 11] !== id[17]) {
    return { ok: false, reason: '身份证号校验位不正确，请核对后重新输入' };
  }
  const birth = id.slice(6, 14);
  const year = Number(birth.slice(0, 4));
  const month = Number(birth.slice(4, 6));
  const day = Number(birth.slice(6, 8));
  if (year < 1900 || year > new Date().getFullYear() || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: '身份证号中的出生日期不合法' };
  }
  return { ok: true, value: id };
}

/** 中国大陆手机号 */
export function validatePhone(input) {
  const phone = String(input || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return { ok: false, reason: '手机号格式不正确（应为 11 位大陆手机号）' };
  }
  return { ok: true, value: phone };
}

/** 车架号 VIN：17 位，不含 I、O、Q */
export function validateVin(input) {
  const vin = String(input || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return { ok: false, reason: '车架号（VIN）应为 17 位字母数字，且不含 I、O、Q' };
  }
  return { ok: true, value: vin };
}

/** 车主姓名：中文 2-20 字，或英文 2-40 字符 */
export function validateName(input) {
  const name = String(input || '').trim();
  if (/^[\u4e00-\u9fa5·]{2,20}$/.test(name)) return { ok: true, value: name };
  if (/^[A-Za-z][A-Za-z\s.'-]{1,39}$/.test(name)) return { ok: true, value: name };
  return { ok: false, reason: '请填写真实姓名（中文 2-20 字）' };
}
