/**
 * HTTP 服务入口：提供静态页面 + REST API。
 */
import http from 'node:http';
import path from 'node:path';
import { ADMIN_COOKIE, ADMIN_PASSWORD, DB_FILE, PUBLIC_DIR, RULES, SERVER, SESSION_MAX_AGE } from './config.js';
import './quiet.js';
import {
  clearCookie,
  clientIp,
  createRouter,
  parseCookies,
  readJsonBody,
  sendError,
  sendJson,
  serveStatic,
  setCookie,
} from './http.js';
import { PLATE_TYPES, PROVINCES, describePattern } from './rules.js';
import { log } from './db.js';
import * as store from './store.js';
import * as service from './service.js';

const router = createRouter();

/** 统一包装异步处理器，捕获异常并转成 JSON 错误响应 */
function handle(fn) {
  return async (req, res, params, url) => {
    try {
      const result = await fn(req, res, params, url);
      if (result !== undefined && !res.writableEnded) {
        sendJson(res, result.statusCode ?? 200, result.body ?? result);
      }
    } catch (error) {
      const statusCode = error.statusCode ?? error.status ?? 500;
      if (statusCode >= 500) {
        console.error('[error]', error);
        log('system', 'error', { message: error.message, ip: clientIp(req) });
      }
      if (!res.writableEnded) {
        sendError(res, statusCode, error.message || '服务器内部错误');
      }
    }
  };
}

/* --------------------------------- 元数据 --------------------------------- */

router.get(
  '/api/meta',
  handle(() => ({
    provinces: PROVINCES,
    plateTypes: Object.values(PLATE_TYPES),
    rules: RULES,
    segments: service.publicSegments(),
  })),
);

router.get(
  '/api/segments',
  handle((req, res, params, url) => ({
    segments: service.publicSegments({
      agency: url.searchParams.get('agency') || undefined,
      plateType: url.searchParams.get('plateType') || undefined,
    }),
  })),
);

router.get(
  '/api/plates/check',
  handle((req, res, params, url) =>
    service.checkNumber(
      url.searchParams.get('number') || '',
      url.searchParams.get('plateType') || undefined,
    ),
  ),
);

/* --------------------------------- 选号申请 -------------------------------- */

router.post(
  '/api/applications',
  handle(async (req) => {
    const payload = await readJsonBody(req);
    return { statusCode: 201, body: service.createApplication(payload) };
  }),
);

router.get(
  '/api/applications/:code',
  handle((req, res, params) => service.getApplicationDetail(params.code)),
);

router.post(
  '/api/applications/:code/random/batch',
  handle((req, res, params) => service.nextRandomBatch(params.code)),
);

router.post(
  '/api/applications/:code/random/pick',
  handle(async (req, res, params) => {
    const body = await readJsonBody(req);
    return service.pickRandomNumber(params.code, { batchNo: body.batchNo, number: body.number });
  }),
);

router.post(
  '/api/applications/:code/random/confirm',
  handle((req, res, params) => service.confirmRandomPick(params.code)),
);

router.post(
  '/api/applications/:code/self/attempt',
  handle(async (req, res, params) => {
    const body = await readJsonBody(req);
    return service.selfAttempt(params.code, { number: body.number });
  }),
);

router.post(
  '/api/applications/:code/cancel',
  handle((req, res, params) => service.cancelApplication(params.code)),
);

router.get(
  '/api/applications/:code/voucher',
  handle((req, res, params) => {
    const detail = service.getApplicationDetail(params.code);
    if (!detail.voucher) {
      return { statusCode: 404, body: { ok: false, error: '本次申请尚未完成选号，暂无凭证' } };
    }
    return detail.voucher;
  }),
);

/* -------------------------------- 管理后台 -------------------------------- */

function requireAdmin(req) {
  if (parseCookies(req)[ADMIN_COOKIE] !== ADMIN_PASSWORD) {
    const error = new Error('请先登录管理后台');
    error.statusCode = 401;
    throw error;
  }
}

router.post(
  '/api/admin/login',
  handle(async (req, res) => {
    const body = await readJsonBody(req);
    if (String(body.password || '') !== ADMIN_PASSWORD) {
      log('admin', 'login_failed', { ip: clientIp(req) });
      return { statusCode: 401, body: { ok: false, error: '管理口令不正确' } };
    }
    setCookie(res, ADMIN_COOKIE, ADMIN_PASSWORD, { maxAge: SESSION_MAX_AGE });
    log('admin', 'login', { ip: clientIp(req) });
    return { ok: true };
  }),
);

router.post(
  '/api/admin/logout',
  handle((req, res) => {
    clearCookie(res, ADMIN_COOKIE);
    return { ok: true };
  }),
);

router.get(
  '/api/admin/session',
  handle((req) => ({ authed: parseCookies(req)[ADMIN_COOKIE] === ADMIN_PASSWORD })),
);

router.get(
  '/api/admin/overview',
  handle((req) => {
    requireAdmin(req);
    const stats = store.stats();
    const occupied = new Map(
      store.countPlatesBySegment().map((r) => [Number(r.segment_id), Number(r.occupied)]),
    );
    const segments = store.listSegments().map((s) => service.decorateSegment(s, occupied));
    const totalCapacity = segments.reduce((sum, s) => sum + s.capacity, 0);
    const totalOccupied = segments.reduce((sum, s) => sum + s.occupied, 0);
    return {
      stats,
      segments,
      totals: {
        segments: segments.length,
        activeSegments: segments.filter((s) => s.status === 'active').length,
        capacity: totalCapacity,
        occupied: totalOccupied,
        remaining: totalCapacity - totalOccupied,
        usageRate: totalCapacity ? totalOccupied / totalCapacity : 0,
      },
    };
  }),
);

router.post(
  '/api/admin/segments',
  handle(async (req) => {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const agency = String(body.agency || '').toUpperCase();
    const plateType = String(body.plateType || '');
    const pattern = String(body.pattern || '').toUpperCase();

    const check = service.validateSegmentSpec({ agency, plateType, pattern });
    if (!check.ok) return { statusCode: 400, body: { ok: false, error: check.reason } };
    if (store.findSegment(agency, plateType, pattern)) {
      return { statusCode: 409, body: { ok: false, error: '该号段已存在' } };
    }
    const segment = store.createSegment({
      agency,
      plateType,
      pattern,
      name: String(body.name || '').trim() || `${agency}·${PLATE_TYPES[plateType].name}（${pattern}）`,
      remark: String(body.remark || '').trim() || null,
    });
    log('admin', 'segment_create', { agency, plateType, pattern });
    return {
      statusCode: 201,
      body: { segment: service.decorateSegment(segment, new Map()), patternText: describePattern(pattern) },
    };
  }),
);

router.patch(
  '/api/admin/segments/:id',
  handle(async (req, res, params) => {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const segment = store.getSegment(params.id);
    if (!segment) return { statusCode: 404, body: { ok: false, error: '号段不存在' } };
    const status = body.status === 'paused' ? 'paused' : 'active';
    const updated = store.setSegmentStatus(segment.id, status);
    log('admin', 'segment_status', { id: segment.id, status });
    return { segment: updated };
  }),
);

router.get(
  '/api/admin/plates',
  handle((req, res, params, url) => {
    requireAdmin(req);
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(200, Math.max(5, Number(url.searchParams.get('pageSize') || 50)));
    const result = store.listPlates({
      segmentId: url.searchParams.get('segmentId') || null,
      keyword: (url.searchParams.get('keyword') || '').trim(),
      status: url.searchParams.get('status') || '',
      plateType: url.searchParams.get('plateType') || '',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { page, pageSize, total: result.total, rows: result.rows };
  }),
);

router.post(
  '/api/admin/plates',
  handle(async (req) => {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const action = String(body.action || '');

    if (action === 'release') {
      const released = store.releaseNumber(String(body.number || ''), body.plateType || null);
      if (!released) return { statusCode: 404, body: { ok: false, error: '号码不存在或已被释放' } };
      log('admin', 'plate_release', { number: body.number });
      return { ok: true, message: `已释放 ${released} 条号码记录（${body.number}）` };
    }

    if (action === 'occupy') {
      const parsed = String(body.number || '').toUpperCase().match(/^([\u4e00-\u9fa5][A-HJ-NP-Z])(.+)$/);
      if (!parsed) return { statusCode: 400, body: { ok: false, error: '号牌号码格式不正确' } };
      const [, agency, seq] = parsed;
      const allSegments = store.listSegments();
      const segment =
        allSegments.find((s) => s.agency === agency && s.pattern.length === seq.length && s.plate_type === body.plateType) ??
        allSegments.find((s) => s.agency === agency && s.pattern.length === seq.length);
      if (!segment) return { statusCode: 400, body: { ok: false, error: '未找到匹配的号段，请先创建号段' } };
      const inserted = store.insertPlate({
        number: agency + seq,
        agency,
        seq,
        plateType: segment.plate_type,
        segmentId: segment.id,
        status: 'used',
        source: 'admin',
      });
      if (!inserted) return { statusCode: 409, body: { ok: false, error: '该号码已存在于号码池中' } };
      log('admin', 'plate_occupy', { number: body.number });
      return { ok: true, message: `已标记 ${agency}·${seq} 为已占用` };
    }

    return { statusCode: 400, body: { ok: false, error: '未知操作' } };
  }),
);

router.get(
  '/api/admin/applications',
  handle((req, res, params, url) => {
    requireAdmin(req);
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(200, Math.max(5, Number(url.searchParams.get('pageSize') || 20)));
    const result = store.listApplications({
      keyword: (url.searchParams.get('keyword') || '').trim(),
      status: url.searchParams.get('status') || '',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return {
      page,
      pageSize,
      total: result.total,
      rows: result.rows.map((row) => ({
        ...row,
        plateTypeName: PLATE_TYPES[row.plate_type]?.name ?? row.plate_type,
        resultNumberFormatted: row.result_number
          ? `${row.result_number.slice(0, 2)}·${row.result_number.slice(2)}`
          : null,
      })),
    };
  }),
);

/* --------------------------------- 静态资源 -------------------------------- */

const PAGE_ALIASES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/query': 'query.html',
  '/query.html': 'query.html',
};

function servePage(urlPath, res) {
  const alias = PAGE_ALIASES[urlPath];
  if (alias) return serveStatic(PUBLIC_DIR, `/${alias}`, res);
  return serveStatic(PUBLIC_DIR, urlPath, res);
}

/* ---------------------------------- 主循环 --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    const route = router.match(req.method, pathname);
    if (!route) {
      sendError(res, 404, `接口不存在：${req.method} ${pathname}`);
      return;
    }
    await route.handler(req, res, route.params, url);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, '不支持的请求方法');
    return;
  }

  if (!servePage(pathname, res)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>页面不存在。<a href="/">返回首页</a></p>');
  }
});

server.listen(SERVER.port, SERVER.host, () => {
  const base = `http://${SERVER.host}:${SERVER.port}`;
  console.log('');
  console.log('  车牌选号系统已启动');
  console.log(`  选号大厅   ${base}/`);
  console.log(`  号码查询   ${base}/query`);
  console.log(`  管理后台   ${base}/admin`);
  console.log(`  数据库     ${DB_FILE}`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在关闭服务...');
    server.close(() => process.exit(0));
  });
}
