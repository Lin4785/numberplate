/**
 * 选号大厅前端逻辑（原生 ES Module，无框架）。
 */

/* ------------------------------ 基础工具 ------------------------------ */

const DIGITS = '0123456789'.split('');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

const PLATE_COLOR = {
  small_car: 'blue',
  large_car: 'yellow',
  coach: 'yellow',
  moto: 'yellow',
  new_energy_small: 'green',
  new_energy_large: 'green',
};

const STATUS_TEXT = {
  info: { text: '待选号', kind: 'blue' },
  random: { text: '随机选号中', kind: 'warn' },
  self: { text: '自编选号中', kind: 'warn' },
  done: { text: '已完成', kind: 'ok' },
  canceled: { text: '已作废', kind: 'muted' },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function charsetOf(ch) {
  if (ch === '9') return DIGITS;
  if (ch === 'A') return LETTERS;
  if (ch === '*') return [...DIGITS, ...LETTERS];
  return [ch];
}

function plateHtml(number, plateType, size = '') {
  if (!number) return '';
  const agency = number.slice(0, 2);
  const seq = number.slice(2);
  const color = PLATE_COLOR[plateType] || 'blue';
  const cls = ['plate', `plate--${color}`, size ? `plate--${size}` : ''].filter(Boolean).join(' ');
  return `<span class="${cls}">${esc(agency)}<span class="plate__dot">·</span>${esc(seq)}</span>`;
}

function toast(message, kind = 'info', timeout = 3200) {
  const host = document.getElementById('toast-host');
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('服务器返回了无法解析的内容');
  }
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（${response.status}）`);
  }
  return payload;
}

/* ------------------------------ 全局状态 ------------------------------ */

const state = {
  meta: null,
  detail: null,
  view: 'home',
  code: localStorage.getItem('np_application_code') || '',
  batch: null,
  busy: false,
  form: { plateType: 'small_car', agency: '' },
  self: { segId: null, chars: [], note: null },
};

const app = document.getElementById('app');

/* ------------------------------- 数据加载 ------------------------------ */

async function loadMeta() {
  state.meta = await api('/api/meta');
}

async function loadDetail() {
  if (!state.code) {
    state.detail = null;
    return null;
  }
  state.detail = await api(`/api/applications/${encodeURIComponent(state.code)}`);
  return state.detail;
}

function agenciesFor(plateType) {
  const map = new Map();
  for (const segment of state.meta.segments) {
    if (segment.plate_type !== plateType) continue;
    const entry = map.get(segment.agency) || { agency: segment.agency, remaining: 0, segments: 0 };
    entry.remaining += segment.remaining;
    entry.segments += 1;
    map.set(segment.agency, entry);
  }
  // 按省份简称的官方顺序排序（京津冀晋蒙…），保证属地下拉的顺序稳定可预期
  const provinceOrder = new Map(state.meta.provinces.map((p, index) => [p, index]));
  return [...map.values()].sort((a, b) => {
    const diff = (provinceOrder.get(a.agency[0]) ?? 99) - (provinceOrder.get(b.agency[0]) ?? 99);
    return diff !== 0 ? diff : a.agency.localeCompare(b.agency);
  });
}

/** 根据申请状态决定进入哪个视图 */
function viewForStatus(status) {
  if (status === 'done') return 'result';
  if (status === 'random') return 'random';
  if (status === 'self') return 'self';
  if (status === 'canceled') return 'home';
  return 'method';
}

async function boot() {
  try {
    await loadMeta();
    if (state.code) {
      try {
        const detail = await loadDetail();
        if (detail) state.view = viewForStatus(detail.application.status);
        else state.code = '';
      } catch {
        state.code = '';
        localStorage.removeItem('np_application_code');
      }
    }
  } catch (error) {
    app.innerHTML = `<div class="alert alert--danger">加载失败：${esc(error.message)}</div>`;
    return;
  }
  render();
}

/* -------------------------------- 视图头部 ----------------------------- */

const STEP_ORDER = ['form', 'method', 'select', 'result'];

function stepsBar(activeIndex) {
  const labels = ['信息确认', '选号方式', '选号操作', '选号完成'];
  return `<div class="steps no-print">${labels
    .map((label, index) => {
      const cls = index === activeIndex ? 'is-active' : index < activeIndex ? 'is-done' : '';
      return `<div class="step ${cls}"><span class="step__no">${index + 1}</span>${label}</div>`;
    })
    .join('')}</div>`;
}

function applicationBar() {
  const app_ = state.detail?.application;
  if (!app_) return '';
  const status = STATUS_TEXT[app_.status] || STATUS_TEXT.info;
  return `
    <div class="card card--pad-sm mb-12">
      <div class="row row--between">
        <div class="row" style="gap:10px">
          <span class="badge badge--${status.kind}">${status.text}</span>
          <span class="small muted">申请编号 <b class="mono">${esc(app_.code)}</b></span>
        </div>
        <div class="small muted">
          车主 ${esc(app_.ownerName)} · 属地 ${esc(app_.agency)} · ${esc(app_.plateTypeName)}
        </div>
      </div>
    </div>`;
}

/* --------------------------------- 首页 -------------------------------- */

function viewHome() {
  const segments = [...state.meta.segments].sort((a, b) => b.remaining - a.remaining);
  const resume = state.code
    ? `<button class="btn btn--light" data-action="resume">继续上次选号（${esc(state.code)}）</button>`
    : '';
  return `
    <section class="hero">
      <h1>机动车号牌互联网选号</h1>
      <p>在线办理新车号牌预选业务：支持「随机选号」与「自编选号」两种方式，选号成功后生成预选号牌凭证，
        请在有效期内到车管所办理注册登记。</p>
      <div class="row">
        <button class="btn btn--light" data-action="start">开始选号</button>
        ${resume}
        <a class="btn btn--light" href="/query">号码池查询</a>
      </div>
    </section>

    <div class="grid grid--3">
      <div class="card">
        <div class="method-icon">随</div>
        <h3 class="mt-12 mb-0">随机选号</h3>
        <p class="muted small">系统随机投放号牌号码，每次 10 个，最多可随机 ${state.meta.rules.randomBatchLimit} 批。
          每批可选择 1 个作为备选，最终只保留 1 个备选号牌。</p>
      </div>
      <div class="card">
        <div class="method-icon">编</div>
        <h3 class="mt-12 mb-0">自编选号</h3>
        <p class="muted small">按公示号段自编号牌号码，共 ${state.meta.rules.selfAttemptLimit} 次机会，
          号码被占用即视为一次失败尝试。</p>
      </div>
      <div class="card">
        <div class="method-icon">证</div>
        <h3 class="mt-12 mb-0">预选凭证</h3>
        <p class="muted small">选号成功后即时生成凭证，有效期 ${state.meta.rules.voucherValidDays} 个自然日，
          逾期未办理将自动失效。</p>
      </div>
    </div>

    <div class="section-title">号段公示</div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>发牌机关</th><th>号牌种类</th><th>号段模板</th><th>序号构成</th>
            <th>剩余号码</th><th>占用率</th><th>示例</th>
          </tr>
        </thead>
        <tbody>
          ${segments.map((s) => `
            <tr>
              <td><b>${esc(s.agency)}</b></td>
              <td>${esc(s.plateTypeName)}</td>
              <td class="mono">${esc(s.pattern)}</td>
              <td class="small muted">${esc(s.patternText)}</td>
              <td>${s.remaining.toLocaleString('zh-CN')}</td>
              <td style="min-width:120px">
                <div class="row" style="gap:8px">
                  <div class="progress" style="flex:1">
                    <div class="progress__bar ${s.usageRate > 0.8 ? 'is-high' : ''}" style="width:${Math.min(100, s.usageRate * 100).toFixed(1)}%"></div>
                  </div>
                  <span class="small muted">${(s.usageRate * 100).toFixed(1)}%</span>
                </div>
              </td>
              <td>${plateHtml(s.sampleNumber, s.plate_type, 'sm')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="small muted mt-12">说明：号段模板中 <b>9</b> 代表数字、<b>A</b> 代表字母（不含 I、O）、
      <b>*</b> 代表数字或字母；其余字符为该位固定字符。</p>
  `;
}

/* ------------------------------ 信息确认表单 ---------------------------- */

function viewForm() {
  const agencies = agenciesFor(state.form.plateType);
  if (!state.form.agency && agencies.length) state.form.agency = agencies[0].agency;
  const f = state.form;
  return `
    ${stepsBar(0)}
    <div class="card">
      <h2 class="card__title">① 车主与车辆信息</h2>
      <p class="card__sub">信息仅用于本次选号业务受理，与真实业务无关。</p>
      <form id="form-apply" class="form-grid" autocomplete="off">
        <div class="field">
          <label class="field__label" for="ownerName">车主姓名<span class="req">*</span></label>
          <input class="input" id="ownerName" name="ownerName" placeholder="请输入车主姓名" value="${esc(f.ownerName || '')}" required />
        </div>
        <div class="field">
          <label class="field__label" for="ownerIdCard">身份证明号码<span class="req">*</span></label>
          <input class="input" id="ownerIdCard" name="ownerIdCard" placeholder="18 位身份证号" maxlength="18" value="${esc(f.ownerIdCard || '')}" required />
          <div class="field__help">系统会校验 18 位身份证号的校验位。</div>
        </div>
        <div class="field">
          <label class="field__label" for="ownerPhone">手机号码<span class="req">*</span></label>
          <input class="input" id="ownerPhone" name="ownerPhone" placeholder="11 位手机号" maxlength="11" value="${esc(f.ownerPhone || '')}" required />
        </div>
        <div class="field">
          <label class="field__label" for="vin">车辆识别代号（VIN）<span class="req">*</span></label>
          <input class="input" id="vin" name="vin" placeholder="17 位车架号，不含 I、O、Q" maxlength="17" value="${esc(f.vin || '')}" required />
        </div>
        <div class="field">
          <label class="field__label" for="vehicleModel">车辆型号</label>
          <input class="input" id="vehicleModel" name="vehicleModel" placeholder="例如：比亚迪 秦PLUS" value="${esc(f.vehicleModel || '')}" />
        </div>
        <div class="field">
          <label class="field__label" for="plateType">号牌种类<span class="req">*</span></label>
          <select class="select" id="plateType" name="plateType">
            ${state.meta.plateTypes.map((t) => `
              <option value="${esc(t.code)}" ${t.code === state.form.plateType ? 'selected' : ''}>
                ${esc(t.name)}（序号 ${t.seqLen} 位）
              </option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="agency">发牌机关（属地）<span class="req">*</span></label>
          <select class="select" id="agency" name="agency">
            ${agencies.length
              ? agencies.map((a) => `<option value="${esc(a.agency)}" ${a.agency === state.form.agency ? 'selected' : ''}>${esc(a.agency)}（剩余 ${a.remaining.toLocaleString('zh-CN')} 个号码）</option>`).join('')
              : '<option value="">该号牌种类暂无可用号段</option>'}
          </select>
          <div class="field__help">发牌机关代号决定号牌开头的省份简称与字母。</div>
        </div>
      </form>
      <div class="row mt-20">
        <button class="btn" data-action="submit-form" ${agencies.length ? '' : 'disabled'}>提交并进入选号</button>
        <button class="btn btn--ghost" data-action="home">返回首页</button>
      </div>
      <div id="form-error" class="field__error mt-12"></div>
    </div>
  `;
}

/* ------------------------------- 选号方式 ------------------------------ */

function viewMethod() {
  return `
    ${stepsBar(1)}
    ${applicationBar()}
    <div class="grid grid--2">
      <div class="method-card" data-action="choose-random">
        <div class="method-icon">随</div>
        <h3>随机选号</h3>
        <p>让系统为你随机投放号牌号码。</p>
        <ul>
          <li>每次随机 ${state.meta.rules.randomBatchSize} 个号码</li>
          <li>最多随机 ${state.meta.rules.randomBatchLimit} 批</li>
          <li>每批可选择 1 个作为备选，仅保留最后 1 个备选</li>
        </ul>
        <div class="row mt-12"><span class="badge badge--blue">推荐首次购车用户</span></div>
      </div>
      <div class="method-card" data-action="choose-self">
        <div class="method-icon">编</div>
        <h3>自编选号</h3>
        <p>在公示号段范围内自行编排心仪号码。</p>
        <ul>
          <li>共 ${state.meta.rules.selfAttemptLimit} 次机会</li>
          <li>号码被占用即消耗 1 次机会</li>
          <li>格式不合法的输入不消耗机会</li>
        </ul>
        <div class="row mt-12"><span class="badge badge--warn">适合有目标号码的用户</span></div>
      </div>
    </div>
    <div class="row mt-20">
      <button class="btn btn--ghost" data-action="home">返回首页</button>
      <button class="btn btn--ghost" data-action="cancel">作废本次申请</button>
    </div>
  `;
}

/* ------------------------------- 随机选号 ------------------------------ */

function viewRandom() {
  const detail = state.detail;
  const random = detail.random;
  let batch = state.batch;
  // 刷新页面或恢复进度时，用服务端最后一批号码回填当前批次
  if (!batch && random.batches.length) {
    const last = random.batches[random.batches.length - 1];
    batch = { batchNo: last.batchNo, numbers: last.numbers, remaining: random.remaining };
  }
  const picked = random.picked;

  const grid = batch
    ? `<div class="numbers">${batch.numbers.map((n) => `
        <button class="number-card ${picked === n.number ? 'is-picked' : ''}" data-action="random-pick" data-number="${esc(n.number)}">
          ${plateHtml(n.number, detail.application.plateType)}
          <span class="number-card__meta">第 ${batch.batchNo} 批</span>
        </button>`).join('')}</div>`
    : `<div class="empty">还没有随机号码，点击「随机选号」开始第 1 批。</div>`;

  return `
    ${stepsBar(2)}
    ${applicationBar()}
    <div class="card">
      <div class="row row--between">
        <div>
          <h2 class="card__title mt-0">随机选号</h2>
          <p class="card__sub mb-0">
            已使用 <b>${random.used}</b> / ${state.meta.rules.randomBatchLimit} 批 ·
            剩余换批次数 <b>${random.remaining}</b>
          </p>
        </div>
        <div class="row">
          <button class="btn" data-action="random-batch" ${random.remaining <= 0 ? 'disabled' : ''}>
            ${batch ? '换一批' : '随机选号'}
          </button>
        </div>
      </div>

      <div class="alert alert--info mt-12">
        点击号码即可设为备选（同一时间仅保留 1 个备选号牌）。备选号牌需点击「确认选号」后才正式生效。
      </div>

      ${grid}

      <div class="row row--between mt-20" style="border-top:1px solid var(--line); padding-top:16px">
        <div class="row" style="gap:10px">
          <span class="muted small">当前备选：</span>
          ${picked ? plateHtml(picked, detail.application.plateType) : '<span class="muted small">未选择</span>'}
        </div>
        <div class="row">
          <button class="btn btn--ghost" data-action="choose-self">改用自编选号</button>
          <button class="btn btn--ok" data-action="random-confirm" ${picked ? '' : 'disabled'}>确认选号</button>
        </div>
      </div>
    </div>

    ${random.batches.length > 1 ? `
      <div class="section-title">历史批次</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>批次</th><th>号码</th></tr></thead>
          <tbody>
            ${random.batches.map((b) => `
              <tr>
                <td>第 ${b.batchNo} 批</td>
                <td>${b.numbers.map((n) => `${n.picked ? '★' : ''}${esc(n.formatted)}`).join('　')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
  `;
}

/* ------------------------------- 自编选号 ------------------------------ */

function currentSelfSegment() {
  const segments = state.detail.segments.filter((s) => s.status === 'active');
  if (!segments.length) return null;
  return segments.find((s) => s.id === state.self.segId) || segments[0];
}

function ensureSelfChars(segment, force = false) {
  if (!segment) return;
  state.self.segId = segment.id;
  const kept = !force && state.self.chars.length === segment.pattern.length ? state.self.chars : null;
  state.self.chars = [...segment.pattern].map((ch, index) => {
    const set = charsetOf(ch);
    if (set.length === 1) return set[0];
    const candidate = kept?.[index];
    if (candidate && set.includes(candidate)) return candidate;
    return set[Math.floor(Math.random() * set.length)];
  });
}

function viewSelf() {
  const detail = state.detail;
  const segments = detail.segments.filter((s) => s.status === 'active');
  if (!segments.length) {
    return `${stepsBar(2)}${applicationBar()}<div class="card"><div class="empty">该属地已无可用号段。</div></div>`;
  }
  const segment = currentSelfSegment();
  ensureSelfChars(segment);

  const seq = state.self.chars.join('');
  const full = `${detail.application.agency}${seq}`;

  const digits = [...segment.pattern].map((ch, index) => {
    const set = charsetOf(ch);
    const fixed = set.length === 1;
    return `
      <div class="digit">
        <span class="digit__index">第${index + 1}位</span>
        <select data-action="self-digit" data-index="${index}" ${fixed ? 'disabled' : ''}>
          ${set.map((c) => `<option value="${esc(c)}" ${state.self.chars[index] === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>`;
  }).join('');

  const attempts = detail.self.attempts;

  return `
    ${stepsBar(2)}
    ${applicationBar()}
    <div class="card">
      <h2 class="card__title mt-0">自编选号</h2>
      <p class="card__sub">剩余机会 <b>${detail.self.remaining}</b> / ${state.meta.rules.selfAttemptLimit}　
        （号码被占用会消耗 1 次机会）</p>

      <div class="field">
        <label class="field__label" for="self-segment">选择号段</label>
        <select class="select" id="self-segment" data-action="self-segment">
          ${segments.map((s) => `
            <option value="${s.id}" ${s.id === segment.id ? 'selected' : ''}>
              ${esc(s.agency)} · ${esc(s.plateTypeName)} · 模板 ${esc(s.pattern)}（剩余 ${s.remaining.toLocaleString('zh-CN')}）
            </option>`).join('')}
        </select>
        <div class="field__help">${esc(segment.patternText)}；该号段剩余 ${segment.remaining.toLocaleString('zh-CN')} 个号码。</div>
      </div>

      <div class="voucher__plate" style="padding:20px 16px">
        ${plateHtml(full, detail.application.plateType, 'lg')}
        <div class="digit-picker mt-12">${digits}</div>
      </div>

      <div class="row">
        <div class="field" style="flex:1; min-width:220px; margin-bottom:0">
          <label class="field__label" for="self-input">手动输入序号（可选，自动同步到上方）</label>
          <input class="input" id="self-input" maxlength="${segment.pattern.length}"
                 placeholder="例如 ${esc(seq)}" value="${esc(seq)}" />
        </div>
      </div>

      <div class="row mt-20">
        <button class="btn btn--ok" data-action="self-submit" ${detail.self.remaining <= 0 ? 'disabled' : ''}>验证并选号</button>
        <button class="btn btn--ghost" data-action="self-random">随机填一个</button>
        <button class="btn btn--ghost" data-action="choose-random">改用随机选号</button>
        <div class="spacer"></div>
        <button class="btn btn--ghost" data-action="cancel">作废本次申请</button>
      </div>
    </div>

    ${attempts.length ? `
      <div class="section-title">选号记录（${attempts.length} / ${state.meta.rules.selfAttemptLimit} 次）</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>次序</th><th>号码</th><th>结果</th><th>说明</th></tr></thead>
          <tbody>
            ${attempts.map((a) => `
              <tr>
                <td>第 ${a.attemptNo} 次</td>
                <td class="mono">${esc(a.number)}</td>
                <td><span class="badge badge--${a.ok ? 'ok' : 'danger'}">${a.ok ? '选号成功' : '失败'}</span></td>
                <td class="small muted">${esc(a.reason || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
  `;
}

/* ------------------------------- 选号结果 ------------------------------ */

function viewResult() {
  const voucher = state.detail.voucher;
  if (!voucher) {
    return `${stepsBar(3)}${applicationBar()}<div class="card"><div class="empty">暂无选号结果。</div>
      <div class="row"><button class="btn" data-action="home">返回首页</button></div></div>`;
  }
  return `
    ${stepsBar(3)}
    <div class="alert alert--ok no-print">
      恭喜，号牌预选成功！请于 ${esc(new Date(voucher.expiresAt).toLocaleDateString('zh-CN'))} 前
      携带相关材料到车管所办理注册登记，逾期本凭证自动失效。
    </div>
    <div class="voucher">
      <div class="voucher__head">
        <h2>机动车号牌预选凭证</h2>
        <p>凭证编号 ${esc(voucher.voucherCode)} · 申请编号 ${esc(voucher.applicationCode)}</p>
      </div>
      <div class="voucher__body">
        <div class="voucher__plate">
          ${plateHtml(voucher.plateNumber, voucher.plateType, 'lg')}
          <span class="badge badge--ok">${esc(voucher.methodName)}成功</span>
        </div>
        <div class="kv">
          <div class="kv__k">号牌号码</div><div class="kv__v">${esc(voucher.plateNumberFormatted)}</div>
          <div class="kv__k">号牌种类</div><div class="kv__v">${esc(voucher.plateTypeName)}</div>
          <div class="kv__k">车主</div><div class="kv__v">${esc(voucher.ownerName)}</div>
          <div class="kv__k">身份证明号码</div><div class="kv__v">${esc(voucher.ownerIdCard)}</div>
          <div class="kv__k">手机号码</div><div class="kv__v">${esc(voucher.ownerPhone)}</div>
          <div class="kv__k">车辆识别代号</div><div class="kv__v">${esc(voucher.vin)}</div>
          <div class="kv__k">车辆型号</div><div class="kv__v">${esc(voucher.vehicleModel || '—')}</div>
          <div class="kv__k">选号方式</div><div class="kv__v">${esc(voucher.methodName)}</div>
          <div class="kv__k">生成时间</div><div class="kv__v">${esc(new Date(voucher.issuedAt).toLocaleString('zh-CN'))}</div>
          <div class="kv__k">有效期至</div><div class="kv__v">${esc(new Date(voucher.expiresAt).toLocaleString('zh-CN'))}</div>
        </div>
      </div>
      <div class="voucher__foot">
        本凭证为仿真系统生成，仅用于演示流程。请妥善保管凭证编号，办理业务时需与申请信息一致。
      </div>
    </div>
    <div class="row mt-20 no-print">
      <button class="btn" data-action="print">打印凭证</button>
      <button class="btn btn--ghost" data-action="home">返回首页</button>
    </div>
  `;
}

/* --------------------------------- 渲染 -------------------------------- */

function render() {
  const views = {
    home: viewHome,
    form: viewForm,
    method: viewMethod,
    random: viewRandom,
    self: viewSelf,
    result: viewResult,
  };
  app.innerHTML = (views[state.view] || viewHome)();

  if (state.view === 'self') {
    const input = document.getElementById('self-input');
    if (input) {
      input.addEventListener('input', onSelfInput);
      input.addEventListener('change', onSelfInput);
    }
  }
}

function setBusy(busy) {
  state.busy = busy;
  for (const button of app.querySelectorAll('button[data-action]')) {
    if (busy) button.setAttribute('disabled', 'disabled');
  }
}

async function guard(fn) {
  if (state.busy) return;
  setBusy(true);
  try {
    await fn();
  } catch (error) {
    toast(error.message, 'danger', 4200);
    // 与服务端状态对齐：例如并发冲突导致备选号牌被他人占用时，重新拉取最新状态
    if (state.code && state.detail) {
      try {
        await loadDetail();
      } catch {
        /* 忽略刷新失败，保留本地状态 */
      }
    }
  } finally {
    setBusy(false);
    render();
  }
}

/* ------------------------------- 事件处理 ------------------------------ */

const actions = {
  home() {
    state.view = 'home';
    state.batch = null;
  },

  start() {
    state.view = 'form';
  },

  async resume() {
    await loadDetail();
    state.view = viewForStatus(state.detail.application.status);
    if (state.view === 'random') state.batch = null;
  },

  'submit-form': async () => {
    const form = document.getElementById('form-apply');
    if (form && !form.reportValidity()) return;
    const payload = Object.fromEntries(new FormData(form).entries());
    const detail = await api('/api/applications', { method: 'POST', body: payload });
    state.detail = detail;
    state.code = detail.application.code;
    localStorage.setItem('np_application_code', state.code);
    state.view = 'method';
    toast('信息核验通过，请选择选号方式', 'ok');
  },

  'choose-random': async () => {
    state.view = 'random';
    if (!state.detail.random.batches.length) await actions['random-batch']();
  },

  'choose-self': async () => {
    await loadDetail();
    state.view = 'self';
    state.self.segId = null;
    state.self.chars = [];
  },

  'random-batch': async () => {
    const batch = await api(`/api/applications/${encodeURIComponent(state.code)}/random/batch`, {
      method: 'POST',
    });
    state.batch = batch;
    await loadDetail();
  },

  'random-pick': async (element) => {
    const number = element.dataset.number;
    state.detail = await api(`/api/applications/${encodeURIComponent(state.code)}/random/pick`, {
      method: 'POST',
      body: { batchNo: state.batch.batchNo, number },
    });
    toast(`已将 ${number} 设为备选`, 'ok', 2000);
  },

  'random-confirm': async () => {
    state.detail = await api(`/api/applications/${encodeURIComponent(state.code)}/random/confirm`, {
      method: 'POST',
    });
    if (state.detail.voucher) {
      state.view = 'result';
      toast('选号成功！预选凭证已生成', 'ok');
    }
  },

  'self-segment'(element) {
    state.self.segId = Number(element.value);
    state.self.chars = [];
  },

  'self-digit'(element) {
    const index = Number(element.dataset.index);
    state.self.chars[index] = element.value;
    syncSelfInput();
  },

  'self-random'() {
    const segment = currentSelfSegment();
    ensureSelfChars(segment, true);
  },

  'self-submit': async () => {
    const segment = currentSelfSegment();
    const seq = state.self.chars.join('');
    const number = `${state.detail.application.agency}${seq}`;
    const result = await api(`/api/applications/${encodeURIComponent(state.code)}/self/attempt`, {
      method: 'POST',
      body: { number },
    });
    state.detail = result.detail;
    if (result.ok) {
      state.view = 'result';
      toast('选号成功！预选凭证已生成', 'ok');
      return;
    }
    toast(result.reason, 'danger', 4200);
    if (result.consumed) {
      ensureSelfChars(segment, true);
    }
  },

  async cancel() {
    if (!window.confirm('确定要作废本次选号申请吗？已使用的选号机会不会退回。')) return;
    await api(`/api/applications/${encodeURIComponent(state.code)}/cancel`, { method: 'POST' });
    localStorage.removeItem('np_application_code');
    state.code = '';
    state.detail = null;
    state.batch = null;
    state.view = 'home';
    toast('本次选号申请已作废', 'warn');
  },

  print() {
    window.print();
  },
};

function syncSelfInput() {
  const input = document.getElementById('self-input');
  if (input) input.value = state.self.chars.join('');
}

/** 手动输入序号时同步到上方位选择器 */
function onSelfInput(event) {
  const segment = currentSelfSegment();
  if (!segment) return;
  const raw = event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const chars = [...raw].slice(0, segment.pattern.length);
  const next = [...segment.pattern].map((ch, index) => {
    const set = charsetOf(ch);
    if (set.length === 1) return set[0];
    return chars[index] && set.includes(chars[index]) ? chars[index] : state.self.chars[index] ?? set[0];
  });
  state.self.chars = next;
  event.target.value = next.join('');

  for (const select of app.querySelectorAll('[data-action="self-digit"]')) {
    const index = Number(select.dataset.index);
    if (!select.disabled) select.value = next[index];
  }
  const preview = app.querySelector('.voucher__plate .plate');
  if (preview) {
    preview.outerHTML = plateHtml(`${state.detail.application.agency}${next.join('')}`,
      state.detail.application.plateType, 'lg');
  }
}

app.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
  const handler = actions[action];
  if (!handler) return;
  if (trigger.tagName === 'SELECT' || trigger.tagName === 'INPUT') return;
  event.preventDefault();
  guard(() => handler(trigger));
});

app.addEventListener('change', (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
  if (!['self-segment', 'self-digit'].includes(action)) return;
  guard(() => actions[action](trigger));
});

/** 把表单当前填写内容暂存到 state，避免重绘后丢失 */
function captureForm() {
  const form = document.getElementById('form-apply');
  if (!form) return;
  Object.assign(state.form, Object.fromEntries(new FormData(form).entries()));
}

/* 表单联动：切换号牌种类时重算属地选项 */
app.addEventListener('change', (event) => {
  if (event.target.id === 'plateType') {
    captureForm();
    state.form.plateType = event.target.value;
    state.form.agency = '';
    render();
  }
  if (event.target.id === 'agency') {
    state.form.agency = event.target.value;
  }
});

boot();
