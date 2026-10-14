/** 号码池查询页逻辑 */

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

function plateHtml(number, plateType, size = '') {
  const cls = ['plate', `plate--${PLATE_COLOR[plateType] || 'blue'}`, size ? `plate--${size}` : ''].join(' ');
  return `<span class="${cls}">${esc(number.slice(0, 2))}<span class="plate__dot">·</span>${esc(number.slice(2))}</span>`;
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  document.getElementById('toast-host').appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

let meta = null;

async function init() {
  meta = await (await fetch('/api/meta')).json();
  const select = document.getElementById('q-type');
  for (const type of meta.plateTypes) {
    select.insertAdjacentHTML('beforeend', `<option value="${esc(type.code)}">${esc(type.name)}</option>`);
  }
  document.getElementById('q-submit').addEventListener('click', submit);
  document.getElementById('q-number').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  document.getElementById('q-lucky').addEventListener('click', () => {
    const agencies = meta.segments.map((s) => s.agency);
    const agency = agencies[Math.floor(Math.random() * agencies.length)];
    const pretty = ['88888', '66666', '99999', '12345', '52013'][Math.floor(Math.random() * 5)];
    document.getElementById('q-number').value = agency + pretty;
    submit();
  });
}

async function submit() {
  const number = document.getElementById('q-number').value.trim();
  const plateType = document.getElementById('q-type').value;
  const host = document.getElementById('q-result');
  if (!number) {
    toast('请输入号牌号码', 'warn');
    return;
  }
  host.innerHTML = '<div class="loading">查询中…</div>';
  try {
    const url = `/api/plates/check?number=${encodeURIComponent(number)}${plateType ? `&plateType=${plateType}` : ''}`;
    const result = await (await fetch(url)).json();
    host.innerHTML = renderResult(result, plateType);
  } catch (error) {
    host.innerHTML = `<div class="alert alert--danger">查询失败：${esc(error.message)}</div>`;
  }
}

function renderResult(result, plateType) {
  if (!result.ok) {
    return `<div class="card"><div class="alert alert--warn mb-0">${esc(result.reason)}</div></div>`;
  }
  const colorType = plateType || stateTypeOf(result.number);
  const statusBadge = result.available
    ? '<span class="badge badge--ok">可选用</span>'
    : result.occupied
      ? '<span class="badge badge--danger">已被占用</span>'
      : '<span class="badge badge--warn">不在已投放号段内</span>';

  return `
    <div class="card">
      <div class="voucher__plate" style="padding:20px 16px">
        ${plateHtml(result.number, colorType, 'lg')}
        ${statusBadge}
      </div>
      <div class="kv">
        <div class="kv__k">号牌号码</div><div class="kv__v">${esc(result.formatted)}</div>
        <div class="kv__k">占用状态</div><div class="kv__v">${result.occupied ? '号码池中已存在（已被占用）' : '号码池中不存在（当前未被占用）'}</div>
        <div class="kv__k">号段范围</div><div class="kv__v">${result.inSegment ? '在已投放号段范围内' : '不在任何已投放号段内'}</div>
        <div class="kv__k">号牌种类</div><div class="kv__v">${esc(result.plateTypeName || '未指定（按通用规则校验）')}</div>
      </div>
      <div class="alert alert--info mt-20 mb-0">
        「未被占用」仅表示查询时该号码可用，实际选号以提交时的占用状态为准。
      </div>
    </div>`;
}

/** 未指定号牌种类时，按公示号段猜一个用于配色（优先选剩余号码最多的号段） */
function stateTypeOf(number) {
  const agency = number.slice(0, 2);
  const seq = number.slice(2);
  const hits = meta.segments
    .filter((s) => {
      if (s.agency !== agency || s.pattern.length !== seq.length) return false;
      return [...s.pattern].every((ch, i) => {
        if (ch === '9') return /[0-9]/.test(seq[i]);
        if (ch === 'A') return /[A-Z]/.test(seq[i]);
        if (ch === '*') return /[0-9A-Z]/.test(seq[i]);
        return ch === seq[i];
      });
    })
    .sort((a, b) => b.remaining - a.remaining);
  return hits[0]?.plate_type || 'small_car';
}

init();
