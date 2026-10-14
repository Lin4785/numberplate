/**
 * 端到端冒烟测试：对运行中的服务依次调用关键接口。
 *
 *   npm start          # 另开一个终端
 *   npm run smoke
 *
 * 可通过 NP_BASE 指定地址，通过 NP_ADMIN_PASSWORD 指定管理口令。
 */
const BASE = process.env.NP_BASE || 'http://127.0.0.1:5173';
const ADMIN_PASSWORD = process.env.NP_ADMIN_PASSWORD || 'admin123';

let passed = 0;
let failed = 0;

function check(label, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

async function call(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, headers: response.headers };
}

function makeIdCard() {
  // 6 位地址码 + 8 位出生日期 + 3 位顺序码 = 17 位，再补 1 位校验位
  const body = `11010119900307${String(100 + Math.floor(Math.random() * 899))}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * weights[i];
  return body + checks[sum % 11];
}

/** 找一个确实未被占用的新能源号牌号码（避免冒烟测试随机撞到已占用号码） */
async function findFreeNewEnergyNumber() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    let seq = 'D';
    while (seq.length < 6) seq += String(Math.floor(Math.random() * 10));
    const number = `京A${seq}`;
    const res = await call(`/api/plates/check?number=${encodeURIComponent(number)}&plateType=new_energy_small`);
    if (res.json?.available) return number;
  }
  throw new Error('未能找到可用的新能源号码');
}

async function main() {
  console.log(`\n冒烟测试目标：${BASE}\n`);

  console.log('静态页面');
  for (const [path, marker] of [
    ['/', '<title>机动车号牌互联网选号系统</title>'],
    ['/query', '号码池查询'],
    ['/admin', '管理后台'],
    ['/styles.css', '--brand'],
    ['/app.js', 'boot()'],
    ['/admin.js', 'loadOverview'],
    ['/query.js', 'plateHtml'],
  ]) {
    const res = await call(path);
    check(`GET ${path}`, res.status === 200 && res.text.includes(marker), `status=${res.status}`);
  }

  console.log('\n元数据与号段公示');
  const meta = await call('/api/meta');
  check('GET /api/meta', meta.status === 200 && Array.isArray(meta.json?.segments));
  check('公示号段非空', (meta.json?.segments?.length ?? 0) > 0, `count=${meta.json?.segments?.length}`);
  const hasSample = meta.json.segments.every((s) => /^[\u4e00-\u9fa5][A-HJ-NP-Z]/.test(s.sampleNumber));
  check('号段示例号码格式正确', hasSample);

  console.log('\n随机选号全流程');
  const created = await call('/api/applications', {
    method: 'POST',
    body: {
      ownerName: '冒烟测试',
      ownerIdCard: makeIdCard(),
      ownerPhone: '13900002222',
      vin: 'LSVAM4185N2100777',
      vehicleModel: '冒烟测试车型',
      plateType: 'small_car',
      agency: '京N',
    },
  });
  check('POST /api/applications', created.status === 201, JSON.stringify(created.json).slice(0, 160));
  const code = created.json?.application?.code;
  check('返回申请编号', typeof code === 'string' && code.startsWith('NP'), code);

  const badCreate = await call('/api/applications', {
    method: 'POST',
    body: { ownerName: '张三', ownerIdCard: '11010119900307001X', ownerPhone: '13900002222', vin: 'LSVAM4185N2100777', plateType: 'small_car', agency: '京N' },
  });
  check('身份证校验位错误被拒绝', badCreate.status === 400, `status=${badCreate.status}`);

  const batch = await call(`/api/applications/${code}/random/batch`, { method: 'POST' });
  check('随机投放第 1 批', batch.status === 200 && batch.json?.numbers?.length === 10);
  check('批次剩余次数为 4', batch.json?.remaining === 4, `remaining=${batch.json?.remaining}`);

  const target = batch.json.numbers[0].number;
  const picked = await call(`/api/applications/${code}/random/pick`, {
    method: 'POST',
    body: { batchNo: batch.json.batchNo, number: target },
  });
  check('选择备选号牌', picked.status === 200 && picked.json?.random?.picked === target, target);

  const confirmed = await call(`/api/applications/${code}/random/confirm`, { method: 'POST' });
  check('确认选号完成', confirmed.status === 200 && confirmed.json?.application?.status === 'done');
  check('生成预选凭证', Boolean(confirmed.json?.voucher?.voucherCode), confirmed.json?.voucher?.voucherCode);
  check('结果号牌与备选一致', confirmed.json?.application?.resultNumber === target);

  const checkNumber = await call(`/api/plates/check?number=${encodeURIComponent(target)}&plateType=small_car`);
  check('选号后号码被标记为已占用', checkNumber.json?.occupied === true);

  console.log('\n自编选号流程');
  const created2 = await call('/api/applications', {
    method: 'POST',
    body: {
      ownerName: '冒烟测试二',
      ownerIdCard: makeIdCard(),
      ownerPhone: '13900003333',
      vin: 'LSVAM4185N2100888',
      plateType: 'new_energy_small',
      agency: '京A',
    },
  });
  const code2 = created2.json?.application?.code;
  check('新能源申请创建成功', Boolean(code2), JSON.stringify(created2.json).slice(0, 160));

  const wrongFormat = await call(`/api/applications/${code2}/self/attempt`, {
    method: 'POST',
    body: { number: '京AA12345' },
  });
  check('新能源首位非 D/F 被拒绝且不消耗机会',
    wrongFormat.json?.ok === false && wrongFormat.json?.consumed === false);

  const selfNumber = await findFreeNewEnergyNumber();
  const self = await call(`/api/applications/${code2}/self/attempt`, {
    method: 'POST',
    body: { number: selfNumber },
  });
  check('自编选号成功', self.json?.ok === true && self.json?.detail?.application?.status === 'done', selfNumber);
  check('自编凭证方式正确', self.json?.detail?.voucher?.methodName === '自编选号');

  console.log('\n管理后台');
  const denied = await call('/api/admin/overview');
  check('未登录访问后台被拒绝（401）', denied.status === 401, `status=${denied.status}`);

  const login = await call('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  check('管理后台登录成功', login.status === 200 && cookie.startsWith('np_admin='), `status=${login.status}`);

  const wrongPassword = await call('/api/admin/login', { method: 'POST', body: { password: 'wrong-password' } });
  check('错误口令被拒绝', wrongPassword.status === 401);

  const overview = await call('/api/admin/overview', { cookie });
  check('GET /api/admin/overview', overview.status === 200 && overview.json?.segments?.length > 0);
  check('统计数据包含号码池占用', (overview.json?.stats?.plates?.occupied ?? 0) > 0);

  const plates = await call('/api/admin/plates?pageSize=5', { cookie });
  check('GET /api/admin/plates', plates.status === 200 && plates.json?.rows?.length === 5);

  const apps = await call(`/api/admin/applications?keyword=${code}`, { cookie });
  check('按申请编号检索选号记录', apps.json?.total === 1 && apps.json?.rows?.[0]?.code === code);

  // 固定模板便于重复执行：首位字母 + 4 位数字，符合小型汽车"字母不超过 2 位"的规则
  const newSegmentPattern = 'B9999';
  const createSegment = await call('/api/admin/segments', {
    method: 'POST',
    cookie,
    body: { agency: '冀A', plateType: 'small_car', pattern: newSegmentPattern },
  });
  // 201 = 首次投放成功；409 = 号段已存在（重复执行冒烟测试时属正常）
  check('投放新号段', createSegment.status === 201 || createSegment.status === 409,
    JSON.stringify(createSegment.json).slice(0, 160));
  check('号段参数不合法被拒绝（属地/位数）',
    (await call('/api/admin/segments', {
      method: 'POST', cookie,
      body: { agency: '冀A', plateType: 'small_car', pattern: 'B999' },
    })).status === 400);

  const badSegment = await call('/api/admin/segments', {
    method: 'POST',
    cookie,
    body: { agency: '冀A', plateType: 'large_car', pattern: '9A999' },
  });
  check('非法号段模板被拒绝', badSegment.status === 400, `status=${badSegment.status}`);

  const released = await call('/api/admin/plates', {
    method: 'POST',
    cookie,
    body: { action: 'release', number: target, plateType: 'small_car' },
  });
  check('释放号码', released.status === 200 && released.json?.ok === true);

  const afterRelease = await call(`/api/plates/check?number=${encodeURIComponent(target)}&plateType=small_car`);
  check('释放后号码恢复可用', afterRelease.json?.occupied === false);

  console.log('\n异常路径');
  const notFound = await call('/api/applications/NP000000XXXXXX');
  check('不存在的申请返回 404', notFound.status === 404, `status=${notFound.status}`);
  const unknownApi = await call('/api/nope');
  check('未知接口返回 404', unknownApi.status === 404);
  const badJson = await fetch(`${BASE}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  check('非法 JSON 请求体返回 400', badJson.status === 400, `status=${badJson.status}`);

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n冒烟测试异常终止：', error.message);
  console.error('请确认服务已启动（npm start），以及 NP_BASE 指向正确。');
  process.exit(1);
});
