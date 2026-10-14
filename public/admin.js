/** 管理后台前端逻辑 */

const PLATE_COLOR = {
  small_car: 'blue',
  large_car: 'yellow',
  coach: 'yellow',
  moto: 'yellow',
  new_energy_small: 'green',
  new_energy_large: 'green',
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const num = (v) => Number(v || 0).toLocaleString('zh-CN');
const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;

function plateHtml(number, plateType, size = 'sm') {
  if (!number) return '—';
  const cls = ['plate', `plate--${PLATE_COLOR[plateType] || 'blue'}`, `plate--${size}`].join(' ');
  return `<span class="${cls}">${esc(number.slice(0, 2))}<span class="plate__dot">·</span>${esc(number.slice(2))}</span>`;
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  document.getElementById('toast-host').appendChild(node);
  setTimeout(() => node.remove(), 3400);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error || `请求失败（${response.status}）`);
  return payload;
}

const app = document.getElementById('app');

const state = {
  authed: false,
  tab: 'overview',
  meta: null,
  overview: null,
  plates: { page: 1, pageSize: 25, keyword: '', segmentId: '', status: '', data: null },
  applications: { page: 1, pageSize: 20, keyword: '', status: '', data: null },
  newSegment: { agency: '京A', plateType: 'small_car', pattern: '' },
  busy: false,
};

/* --------------------------------- 登录 --------------------------------- */

function renderLogin() {
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:60px auto">
      <h2 class="card__title">管理后台登录</h2>
      <p class="card__sub">请输入管理口令继续。默认口令为 admin123，可通过环境变量 NP_ADMIN_PASSWORD 修改。</p>
      <div class="field">
        <label class="field__label" for="admin-password">管理口令</label>
        <input class="input" id="admin-password" type="password" placeholder="请输入管理口令" />
      </div>
      <button class="btn btn--block" data-action="login">登录</button>
    </div>`;
  const input = document.getElementById('admin-password');
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actions.login();
  });
}

/* --------------------------------- 概览 --------------------------------- */

function renderOverview() {
  const { stats, totals, segments } = state.overview;
  const sorted = [...segments].sort((a, b) => b.usageRate - a.usageRate);
  return `
    <div class="grid grid--4">
      <div class="stat">
        <div class="stat__label">选号申请总数</div>
        <div class="stat__value">${num(stats.applications.total)}</div>
        <div class="stat__hint">已完成 ${num(stats.applications.done)} · 进行中 ${num(stats.applications.inProgress)} · 已作废 ${num(stats.applications.canceled)}</div>
      </div>
      <div class="stat">
        <div class="stat__label">已完成选号</div>
        <div class="stat__value">${num(stats.applications.done)}</div>
        <div class="stat__hint">随机选号 ${num(stats.applications.byRandom)} · 自编选号 ${num(stats.applications.bySelf)}</div>
      </div>
      <div class="stat">
        <div class="stat__label">号码池已占用</div>
        <div class="stat__value">${num(stats.plates.occupied)}</div>
        <div class="stat__hint">其中预选占用 ${num(stats.plates.reserved)}</div>
      </div>
      <div class="stat">
        <div class="stat__label">整体占用率</div>
        <div class="stat__value">${pct(totals.usageRate)}</div>
        <div class="stat__hint">容量 ${num(totals.capacity)} · 剩余 ${num(totals.remaining)}</div>
      </div>
    </div>

    <div class="section-title">号段占用情况（${totals.segments} 个号段，${totals.activeSegments} 个启用中）</div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>发牌机关</th><th>号牌种类</th><th>模板</th><th>容量</th><th>已占用</th><th>剩余</th><th>占用率</th><th>状态</th></tr>
        </thead>
        <tbody>
          ${sorted.map((s) => `
            <tr>
              <td><b>${esc(s.agency)}</b></td>
              <td>${esc(s.plateTypeName)}</td>
              <td class="mono">${esc(s.pattern)}</td>
              <td>${num(s.capacity)}</td>
              <td>${num(s.occupied)}</td>
              <td>${num(s.remaining)}</td>
              <td style="min-width:130px">
                <div class="row" style="gap:8px">
                  <div class="progress" style="flex:1">
                    <div class="progress__bar ${s.usageRate > 0.8 ? 'is-high' : ''}" style="width:${Math.min(100, s.usageRate * 100).toFixed(1)}%"></div>
                  </div>
                  <span class="small muted nowrap">${pct(s.usageRate)}</span>
                </div>
              </td>
              <td><span class="badge badge--${s.status === 'active' ? 'ok' : 'muted'}">${s.status === 'active' ? '启用' : '停用'}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-title">最近选号记录</div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>申请编号</th><th>车主</th><th>号牌种类</th><th>方式</th><th>结果</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>
          ${stats.recent.length ? stats.recent.map((r) => `
            <tr>
              <td class="mono">${esc(r.code)}</td>
              <td>${esc(r.owner_name)}</td>
              <td>${esc(state.meta.plateTypes.find((t) => t.code === r.plate_type)?.name || r.plate_type)}</td>
              <td>${r.method === 'self' ? '自编选号' : r.method === 'random' ? '随机选号' : '—'}</td>
              <td>${r.result_number ? plateHtml(r.result_number, r.plate_type) : '—'}</td>
              <td><span class="badge badge--${r.status === 'done' ? 'ok' : r.status === 'canceled' ? 'muted' : 'warn'}">${
                { done: '已完成', canceled: '已作废', random: '随机选号中', self: '自编选号中', info: '待选号' }[r.status] || r.status
              }</span></td>
              <td class="small muted">${esc(new Date(r.updated_at).toLocaleString('zh-CN'))}</td>
            </tr>`).join('') : '<tr><td colspan="7"><div class="empty">暂无记录</div></td></tr>'}
        </tbody>
      </table>
    </div>`;
}

/* ------------------------------- 号段管理 ------------------------------- */

function renderSegments() {
  const segments = state.overview.segments;
  return `
    <div class="card mb-12">
      <h2 class="card__title">投放新号段</h2>
      <p class="card__sub">模板中 9 表示数字、A 表示字母（不含 I、O）、* 表示数字或字母；新能源号段首位固定为 D 或 F。</p>
      <div class="form-grid">
        <div class="field">
          <label class="field__label" for="seg-agency">发牌机关代号</label>
          <input class="input" id="seg-agency" maxlength="2" value="${esc(state.newSegment.agency)}" placeholder="如 京A" />
        </div>
        <div class="field">
          <label class="field__label" for="seg-type">号牌种类</label>
          <select class="select" id="seg-type">
            ${state.meta.plateTypes.map((t) => `
              <option value="${esc(t.code)}" ${t.code === state.newSegment.plateType ? 'selected' : ''}>
                ${esc(t.name)}（序号 ${t.seqLen} 位，字母上限 ${t.maxLetters}）
              </option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="seg-pattern">号段模板</label>
          <input class="input" id="seg-pattern" value="${esc(state.newSegment.pattern)}" placeholder="如 9A999 / D99999" />
        </div>
        <div class="field">
          <label class="field__label" for="seg-name">号段名称（可选）</label>
          <input class="input" id="seg-name" placeholder="留空自动生成" />
        </div>
      </div>
      <button class="btn" data-action="create-segment">投放号段</button>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>ID</th><th>发牌机关</th><th>号牌种类</th><th>模板</th><th>序号构成</th>
            <th>容量</th><th>已占用</th><th>剩余</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${segments.map((s) => `
            <tr>
              <td>${s.id}</td>
              <td><b>${esc(s.agency)}</b></td>
              <td>${esc(s.plateTypeName)}</td>
              <td class="mono">${esc(s.pattern)}</td>
              <td class="small muted">${esc(s.patternText)}</td>
              <td>${num(s.capacity)}</td>
              <td>${num(s.occupied)}</td>
              <td>${num(s.remaining)}</td>
              <td><span class="badge badge--${s.status === 'active' ? 'ok' : 'muted'}">${s.status === 'active' ? '启用' : '停用'}</span></td>
              <td>
                <button class="btn btn--ghost btn--sm" data-action="toggle-segment" data-id="${s.id}"
                        data-status="${s.status === 'active' ? 'paused' : 'active'}">
                  ${s.status === 'active' ? '停用' : '启用'}
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ------------------------------- 号码池 -------------------------------- */

function renderPlates() {
  const { data, page, pageSize, keyword, segmentId, status } = state.plates;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  return `
    <div class="card mb-12">
      <div class="form-grid">
        <div class="field">
          <label class="field__label" for="pl-segment">号段</label>
          <select class="select" id="pl-segment">
            <option value="">全部号段</option>
            ${state.overview.segments.map((s) => `
              <option value="${s.id}" ${String(s.id) === String(segmentId) ? 'selected' : ''}>
                ${esc(s.agency)} ${esc(s.plateTypeName)} ${esc(s.pattern)}
              </option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="pl-status">占用状态</label>
          <select class="select" id="pl-status">
            <option value="">全部</option>
            ${[['used', '已占用'], ['reserved', '预选占用'], ['locked', '锁定']].map(([v, t]) => `
              <option value="${v}" ${v === status ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="pl-keyword">号码关键字</label>
          <input class="input" id="pl-keyword" value="${esc(keyword)}" placeholder="如 京A88 或 88888" />
        </div>
      </div>
      <div class="row">
        <button class="btn" data-action="plates-search">查询</button>
        <button class="btn btn--ghost" data-action="plates-reset">重置</button>
      </div>
    </div>

    <div class="row row--between mb-12">
      <span class="small muted">共 ${data ? num(data.total) : 0} 条记录 · 第 ${page} / ${totalPages} 页</span>
      <div class="row">
        <button class="btn btn--ghost btn--sm" data-action="plates-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn btn--ghost btn--sm" data-action="plates-page" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>号码</th><th>号牌种类</th><th>状态</th><th>来源</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          ${data && data.rows.length ? data.rows.map((r) => `
            <tr>
              <td>${plateHtml(r.number, r.plate_type)}</td>
              <td>${esc(state.meta.plateTypes.find((t) => t.code === r.plate_type)?.name || r.plate_type)}</td>
              <td><span class="badge badge--${r.status === 'reserved' ? 'warn' : r.status === 'used' ? 'danger' : 'muted'}">${
                { used: '已占用', reserved: '预选占用', locked: '锁定' }[r.status] || r.status
              }</span></td>
              <td class="small muted">${{ seed: '初始化', random: '随机选号', self: '自编选号', admin: '人工标记' }[r.source] || r.source}</td>
              <td class="small muted">${esc(new Date(r.updated_at).toLocaleString('zh-CN'))}</td>
              <td>
                <button class="btn btn--danger btn--sm" data-action="release-plate"
                        data-number="${esc(r.number)}" data-type="${esc(r.plate_type)}">释放</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无数据</div></td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card mt-20">
      <h3 class="card__title">人工占用号码</h3>
      <p class="card__sub">用于模拟历史遗留号码：输入完整号牌号码并选择号牌种类，将其标记为已占用。</p>
      <div class="row">
        <input class="input" id="occupy-number" placeholder="如 京A88888" style="max-width:240px" />
        <select class="select" id="occupy-type" style="max-width:220px">
          ${state.meta.plateTypes.map((t) => `<option value="${esc(t.code)}">${esc(t.name)}</option>`).join('')}
        </select>
        <button class="btn" data-action="occupy-plate">标记为已占用</button>
      </div>
    </div>`;
}

/* ------------------------------- 选号记录 ------------------------------- */

function renderApplications() {
  const { data, page, pageSize, keyword, status } = state.applications;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const statusText = { done: '已完成', canceled: '已作废', random: '随机选号中', self: '自编选号中', info: '待选号' };
  return `
    <div class="card mb-12">
      <div class="form-grid">
        <div class="field">
          <label class="field__label" for="ap-keyword">关键字</label>
          <input class="input" id="ap-keyword" value="${esc(keyword)}" placeholder="申请编号 / 车主 / 手机号 / 号牌号码" />
        </div>
        <div class="field">
          <label class="field__label" for="ap-status">状态</label>
          <select class="select" id="ap-status">
            <option value="">全部</option>
            ${Object.entries(statusText).map(([v, t]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row">
        <button class="btn" data-action="apps-search">查询</button>
        <button class="btn btn--ghost" data-action="apps-reset">重置</button>
      </div>
    </div>

    <div class="row row--between mb-12">
      <span class="small muted">共 ${data ? num(data.total) : 0} 条记录 · 第 ${page} / ${totalPages} 页</span>
      <div class="row">
        <button class="btn btn--ghost btn--sm" data-action="apps-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn btn--ghost btn--sm" data-action="apps-page" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr><th>申请编号</th><th>车主</th><th>手机号</th><th>属地</th><th>号牌种类</th><th>VIN</th>
            <th>方式</th><th>结果</th><th>剩余机会</th><th>状态</th><th>创建时间</th></tr>
        </thead>
        <tbody>
          ${data && data.rows.length ? data.rows.map((r) => `
            <tr>
              <td class="mono">${esc(r.code)}</td>
              <td>${esc(r.owner_name)}</td>
              <td class="mono small">${esc(r.owner_phone)}</td>
              <td>${esc(r.agency)}</td>
              <td>${esc(r.plateTypeName)}</td>
              <td class="mono small">${esc(r.vin)}</td>
              <td>${r.method === 'self' ? '自编' : r.method === 'random' ? '随机' : '—'}</td>
              <td>${r.result_number ? plateHtml(r.result_number, r.plate_type) : '—'}</td>
              <td class="small muted">随机 ${Math.max(0, 5 - r.random_batch_used)} 批 / 自编 ${Math.max(0, 20 - r.self_attempt_used)} 次</td>
              <td><span class="badge badge--${r.status === 'done' ? 'ok' : r.status === 'canceled' ? 'muted' : 'warn'}">${statusText[r.status] || r.status}</span></td>
              <td class="small muted">${esc(new Date(r.created_at).toLocaleString('zh-CN'))}</td>
            </tr>`).join('') : '<tr><td colspan="11"><div class="empty">暂无数据</div></td></tr>'}
        </tbody>
      </table>
    </div>`;
}

/* --------------------------------- 渲染 --------------------------------- */

const TABS = [
  ['overview', '数据概览'],
  ['segments', '号段管理'],
  ['plates', '号码池'],
  ['applications', '选号记录'],
];

function render() {
  if (!state.authed) {
    renderLogin();
    return;
  }
  const body = {
    overview: renderOverview,
    segments: renderSegments,
    plates: renderPlates,
    applications: renderApplications,
  }[state.tab];

  app.innerHTML = `
    <div class="row row--between mb-12">
      <div class="tabs" style="border:none;margin:0">
        ${TABS.map(([key, label]) => `
          <button class="tab ${key === state.tab ? 'is-active' : ''}" data-action="tab" data-tab="${key}">${label}</button>`).join('')}
      </div>
      <button class="btn btn--ghost btn--sm" data-action="logout">退出登录</button>
    </div>
    <div id="tab-body">${body()}</div>`;
}

/* ------------------------------- 数据加载 ------------------------------- */

async function loadOverview() {
  state.overview = await api('/api/admin/overview');
}

async function loadPlates() {
  const { page, pageSize, keyword, segmentId, status } = state.plates;
  const params = new URLSearchParams({ page, pageSize });
  if (keyword) params.set('keyword', keyword);
  if (segmentId) params.set('segmentId', segmentId);
  if (status) params.set('status', status);
  state.plates.data = await api(`/api/admin/plates?${params}`);
}

async function loadApplications() {
  const { page, pageSize, keyword, status } = state.applications;
  const params = new URLSearchParams({ page, pageSize });
  if (keyword) params.set('keyword', keyword);
  if (status) params.set('status', status);
  state.applications.data = await api(`/api/admin/applications?${params}`);
}

async function switchTab(tab) {
  state.tab = tab;
  if (tab === 'plates' && !state.plates.data) await loadPlates();
  if (tab === 'applications' && !state.applications.data) await loadApplications();
}

/* ------------------------------- 事件处理 ------------------------------- */

const actions = {
  async login() {
    const password = document.getElementById('admin-password').value;
    await api('/api/admin/login', { method: 'POST', body: { password } });
    state.authed = true;
    await loadOverview();
    toast('登录成功', 'ok');
  },

  async logout() {
    await api('/api/admin/logout', { method: 'POST' });
    state.authed = false;
    state.overview = null;
    state.plates.data = null;
    state.applications.data = null;
  },

  async tab(element) {
    await switchTab(element.dataset.tab);
  },

  async 'create-segment'() {
    const body = {
      agency: document.getElementById('seg-agency').value.trim().toUpperCase(),
      plateType: document.getElementById('seg-type').value,
      pattern: document.getElementById('seg-pattern').value.trim().toUpperCase(),
      name: document.getElementById('seg-name').value.trim(),
    };
    await api('/api/admin/segments', { method: 'POST', body });
    state.newSegment = { agency: body.agency || '京A', plateType: body.plateType, pattern: '' };
    await loadOverview();
    toast('号段投放成功', 'ok');
  },

  async 'toggle-segment'(element) {
    await api(`/api/admin/segments/${element.dataset.id}`, {
      method: 'PATCH',
      body: { status: element.dataset.status },
    });
    await loadOverview();
    toast('号段状态已更新', 'ok');
  },

  async 'plates-search'() {
    state.plates.keyword = document.getElementById('pl-keyword').value.trim();
    state.plates.segmentId = document.getElementById('pl-segment').value;
    state.plates.status = document.getElementById('pl-status').value;
    state.plates.page = 1;
    await loadPlates();
  },

  async 'plates-reset'() {
    state.plates = { ...state.plates, keyword: '', segmentId: '', status: '', page: 1, data: null };
    await loadPlates();
  },

  async 'plates-page'(element) {
    state.plates.page = Number(element.dataset.page);
    await loadPlates();
  },

  async 'release-plate'(element) {
    const { number, type } = element.dataset;
    if (!window.confirm(`确定释放号码 ${number}（${
      state.meta.plateTypes.find((t) => t.code === type)?.name}）吗？\n释放后该号码将重新进入可选号码池。`)) return;
    await api('/api/admin/plates', { method: 'POST', body: { action: 'release', number, plateType: type } });
    await loadPlates();
    await loadOverview();
    toast(`${number} 已释放`, 'ok');
  },

  async 'occupy-plate'() {
    const number = document.getElementById('occupy-number').value.trim().toUpperCase();
    const plateType = document.getElementById('occupy-type').value;
    const result = await api('/api/admin/plates', { method: 'POST', body: { action: 'occupy', number, plateType } });
    await loadPlates();
    await loadOverview();
    toast(result.message || '操作成功', 'ok');
  },

  async 'apps-search'() {
    state.applications.keyword = document.getElementById('ap-keyword').value.trim();
    state.applications.status = document.getElementById('ap-status').value;
    state.applications.page = 1;
    await loadApplications();
  },

  async 'apps-reset'() {
    state.applications = { ...state.applications, keyword: '', status: '', page: 1, data: null };
    await loadApplications();
  },

  async 'apps-page'(element) {
    state.applications.page = Number(element.dataset.page);
    await loadApplications();
  },
};

app.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger || state.busy) return;
  const handler = actions[trigger.dataset.action];
  if (!handler) return;
  event.preventDefault();
  state.busy = true;
  try {
    await handler(trigger);
    render();
  } catch (error) {
    toast(error.message, 'danger', 4200);
    if (/登录|口令|401/.test(error.message)) {
      state.authed = false;
      render();
    }
  } finally {
    state.busy = false;
  }
});

/* --------------------------------- 启动 --------------------------------- */

async function boot() {
  try {
    state.meta = await api('/api/meta');
    const session = await api('/api/admin/session');
    state.authed = Boolean(session.authed);
    if (state.authed) await loadOverview();
  } catch (error) {
    app.innerHTML = `<div class="alert alert--danger">加载失败：${esc(error.message)}</div>`;
    return;
  }
  render();
}

boot();
