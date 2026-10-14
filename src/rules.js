/**
 * 车牌号牌规则引擎。
 *
 * 依据 GA 36《中华人民共和国机动车号牌》的通用规则抽象实现：
 *   - 号牌号码 = 发牌机关代号（省份简称 + 英文字母）+ 序号
 *   - 序号中不使用容易混淆的 I、O（本引擎全部字母集均排除 I、O）
 *   - 序号位数、可用字符集、字母个数上限随"号牌种类"不同而不同
 *
 * 号段模板字符：
 *   '9' -> 数字 0-9
 *   'A' -> 英文字母（24 个，排除 I、O）
 *   '*' -> 数字或字母
 *   其他合法字符（如新能源的 "D"、"F"）-> 固定字面量
 */

export const DIGITS = '0123456789'.split('');
export const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split(''); // 24 个，排除 I、O
export const ALPHANUMERIC = [...DIGITS, ...LETTERS];

/** 31 个省级行政区简称（不含使领馆、警用等特殊号牌） */
export const PROVINCES = [
  '京', '津', '冀', '晋', '蒙', '辽', '吉', '黑', '沪', '苏', '浙',
  '皖', '闽', '赣', '鲁', '豫', '鄂', '湘', '粤', '桂', '琼', '渝',
  '川', '贵', '云', '藏', '陕', '甘', '青', '宁', '新',
];

/**
 * 号牌种类定义。
 * seqLen          序号位数
 * color           号牌底色（用于前端着色）
 * fixedFirstChars 序号首位固定字符集合（新能源汽车 D=纯电 / F=非纯电）
 * maxLetters      序号中最多允许出现的字母个数
 */
export const PLATE_TYPES = {
  small_car: {
    code: 'small_car',
    name: '小型汽车',
    color: 'blue',
    seqLen: 5,
    fixedFirstChars: null,
    maxLetters: 2,
    description: '蓝底白字，序号 5 位，字母不超过 2 位',
  },
  large_car: {
    code: 'large_car',
    name: '大型汽车',
    color: 'yellow',
    seqLen: 5,
    fixedFirstChars: null,
    maxLetters: 0,
    description: '黄底黑字，序号 5 位全数字',
  },
  coach: {
    code: 'coach',
    name: '教练汽车',
    color: 'yellow',
    seqLen: 5,
    fixedFirstChars: null,
    maxLetters: 0,
    description: '黄底黑字，序号 5 位全数字',
  },
  moto: {
    code: 'moto',
    name: '摩托车',
    color: 'yellow',
    seqLen: 5,
    fixedFirstChars: null,
    maxLetters: 1,
    description: '黄底黑字，序号 5 位，字母不超过 1 位',
  },
  new_energy_small: {
    code: 'new_energy_small',
    name: '小型新能源汽车',
    color: 'green',
    seqLen: 6,
    fixedFirstChars: ['D', 'F'],
    maxLetters: 1,
    description: '渐变绿底黑字，序号 6 位，首位为 D（纯电）或 F（非纯电）',
  },
  new_energy_large: {
    code: 'new_energy_large',
    name: '大型新能源汽车',
    color: 'green',
    seqLen: 6,
    fixedFirstChars: null,
    maxLetters: 0,
    description: '黄绿双拼底黑字，序号 6 位全数字',
  },
};

export function getPlateType(code) {
  const type = PLATE_TYPES[code];
  if (!type) throw new Error(`未知的号牌种类：${code}`);
  return type;
}

/** 单个模板字符对应的候选字符集 */
export function charsetFor(ch) {
  switch (ch) {
    case '9':
      return DIGITS;
    case 'A':
      return LETTERS;
    case '*':
      return ALPHANUMERIC;
    default:
      // 固定字面量，例如新能源号段的 "D" / "F"
      if (ALPHANUMERIC.includes(ch)) return [ch];
      throw new Error(`非法的号段模板字符："${ch}"（仅支持 9 / A / * 或数字字母字面量）`);
  }
}

/** 号段模板是否合法 */
export function isValidPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  return [...pattern].every((ch) => '9A*'.includes(ch) || ALPHANUMERIC.includes(ch));
}

/** 模板的理论容量（可发放号码总数） */
export function capacityOf(pattern) {
  return [...pattern].reduce((total, ch) => total * charsetFor(ch).length, 1);
}

/**
 * 把 [0, capacity) 的整数序号解码成序号字符串（混合进制）。
 * 这样可以在不枚举全部号码的前提下，等概率地随机取号。
 */
export function indexToSeq(pattern, index) {
  const capacity = capacityOf(pattern);
  if (!Number.isInteger(index) || index < 0 || index >= capacity) {
    throw new RangeError(`序号下标越界：${index} / ${capacity}`);
  }
  const chars = [];
  let rest = index;
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    const set = charsetFor(pattern[i]);
    chars[i] = set[rest % set.length];
    rest = Math.floor(rest / set.length);
  }
  return chars.join('');
}

/** indexToSeq 的逆运算，用于统计与调试 */
export function seqToIndex(pattern, seq) {
  if (seq.length !== pattern.length) throw new Error('序号位数与模板不一致');
  let index = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const set = charsetFor(pattern[i]);
    const pos = set.indexOf(seq[i]);
    if (pos < 0) throw new Error(`序号第 ${i + 1} 位 "${seq[i]}" 不在模板允许范围内`);
    index = index * set.length + pos;
  }
  return index;
}

/** 序号是否符合模板 */
export function matchesPattern(pattern, seq) {
  if (typeof seq !== 'string' || seq.length !== pattern.length) return false;
  return [...seq].every((ch, i) => charsetFor(pattern[i]).includes(ch));
}

/** 发牌机关代号是否合法：省份简称 + 一个字母（非 I、O） */
export function isValidAgency(agency) {
  if (typeof agency !== 'string' || agency.length !== 2) return false;
  return PROVINCES.includes(agency[0]) && LETTERS.includes(agency[1]);
}

function countLetters(seq) {
  return [...seq].filter((ch) => LETTERS.includes(ch)).length;
}

/**
 * 按号牌种类校验序号，返回 { ok, reason }。
 * reason 为面向用户的中文提示。
 */
export function validateSeq(plateTypeCode, seq) {
  const type = getPlateType(plateTypeCode);
  if (typeof seq !== 'string' || seq.length === 0) return { ok: false, reason: '序号不能为空' };
  if (seq.length !== type.seqLen) {
    return { ok: false, reason: `${type.name}号牌序号应为 ${type.seqLen} 位，当前为 ${seq.length} 位` };
  }
  if (/[IO]/.test(seq)) return { ok: false, reason: '序号中不能使用容易混淆的字母 I、O' };
  if (![...seq].every((ch) => ALPHANUMERIC.includes(ch))) {
    return { ok: false, reason: '序号只能由数字和英文字母组成' };
  }
  if (type.fixedFirstChars && !type.fixedFirstChars.includes(seq[0])) {
    return { ok: false, reason: `新能源汽车号牌序号首位必须为 ${type.fixedFirstChars.join(' 或 ')}` };
  }
  const body = type.fixedFirstChars ? seq.slice(1) : seq;
  const letters = countLetters(seq);
  if (letters > type.maxLetters) {
    return {
      ok: false,
      reason: `${type.name}号牌序号中字母不得超过 ${type.maxLetters} 位（当前 ${letters} 位）`,
    };
  }
  if (type.maxLetters === 0 && countLetters(body) > 0) {
    return { ok: false, reason: `${type.name}号牌序号不能包含字母` };
  }
  return { ok: true };
}

/** 完整号牌号码校验（发牌机关代号 + 序号） */
export function validatePlateNumber(agency, seq, plateTypeCode) {
  if (!isValidAgency(agency)) {
    return { ok: false, reason: '发牌机关代号不合法（应为省份简称 + 英文字母）' };
  }
  return validateSeq(plateTypeCode, seq);
}

/** 生成完整号牌号码字符串 */
export function composePlateNumber(agency, seq) {
  return `${agency}${seq}`;
}

/** 展示用格式：京A·12345 */
export function formatPlateNumber(agency, seq) {
  return `${agency}·${seq}`;
}

/** 把号段模板翻译成人话，例如 '9A999' -> "第1位数字、第2位字母、后3位数字" */
export function describePattern(pattern) {
  return [...pattern]
    .map((ch, index) => {
      const label = ch === '9' ? '数字' : ch === 'A' ? '字母' : ch === '*' ? '数字或字母' : `固定"${ch}"`;
      return `第${index + 1}位${label}`;
    })
    .join('、');
}

/** 常见号牌号码的正则（宽松），用于解析用户输入 */
export function normalizePlateInput(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\s·．.\-—_]/g, '').toUpperCase();
}

/**
 * 把用户输入拆解为 { agency, seq }。
 * 支持 "京A12345"、"京A·12345"、"京AD12345" 等写法。
 */
export function splitPlateNumber(input) {
  const raw = normalizePlateInput(input);
  if (raw.length < 3) return null;
  return { agency: raw.slice(0, 2), seq: raw.slice(2) };
}
