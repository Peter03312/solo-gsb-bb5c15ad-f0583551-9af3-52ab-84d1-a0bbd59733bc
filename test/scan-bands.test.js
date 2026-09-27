'use strict';

// 现场扫描采样导入测试：核心函数 scanCsvToBands 与 POST /api/scan-bands 接口，
// 以及扫描生成区间并入 /api/coordinate 协调流程并随方案保存。
// 使用独立临时 DATA_DIR，通过 HTTP 调用导出的 app（监听随机端口）。
process.env.DATA_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  `mic-scan-test-${process.pid}-${Date.now()}`,
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const app = require('../server');
const { scanCsvToBands, SCAN_MAX_RECORDS } = require('../lib/intermod');

let server;
let port;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  db.exec('DELETE FROM devices; DELETE FROM plans;');
});

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createDevice(name, frequency, guard = 0.25, locked = false) {
  const res = await request('POST', '/api/devices', { name, frequency, guard, locked });
  assert.equal(res.status, 201, res.data.error);
  return res.data;
}

/* ---------- 核心函数 scanCsvToBands ---------- */

test('达阈值频点扩展为 ±半采样间隔闭区间，相交/相接区间合并并按频率排序', () => {
  // 间隔 0.05 → 半宽 0.025
  // 500.000(-80 ≥ -90) → [499.975, 500.025]
  // 500.025(-70 ≥ -90) → [500.000, 500.050]，与前一区间重叠 → 合并 [499.975, 500.050]
  // 500.100(-95 < -90)  → 不生成
  const r = scanCsvToBands('500.100,-95\n500.000,-80\n500.025,-70', 0.05, -90);
  assert.deepEqual(r.bands, [{ lo: 499.975, hi: 500.05 }]);
  assert.equal(r.records, 3);
  assert.equal(r.points, 3);
  assert.equal(r.occupied, 2);
});

test('电平恰好等于阈值也算达到（闭区间阈值语义）', () => {
  const r = scanCsvToBands('500,-90', 0.1, -90);
  assert.equal(r.occupied, 1);
  assert.deepEqual(r.bands, [{ lo: 499.95, hi: 500.05 }]);
});

test('同频点取最高电平（记录顺序无关）', () => {
  for (const csv of ['500,-95\n500,-70', '500,-70\n500,-95']) {
    const r = scanCsvToBands(csv, 0.1, -90);
    assert.equal(r.points, 1);
    assert.equal(r.occupied, 1);
    assert.deepEqual(r.bands, [{ lo: 499.95, hi: 500.05 }]);
  }
  // 最高电平仍低于阈值 → 不生成区间
  const low = scanCsvToBands('500,-95\n500,-92', 0.1, -90);
  assert.equal(low.points, 1);
  assert.equal(low.occupied, 0);
  assert.deepEqual(low.bands, []);
});

test('相邻采样点的扩展区间端点相接即合并', () => {
  // 间隔 0.05：[499.975,500.025] 与 [500.025,500.075] 在 500.025 相接
  const r = scanCsvToBands('500,-70\n500.05,-70', 0.05, -90);
  assert.deepEqual(r.bands, [{ lo: 499.975, hi: 500.075 }]);
});

test('间隔的频点不合并', () => {
  // 间隔 0.05：500 与 500.1 的扩展区间 [499.975,500.025]、[500.075,500.125] 不相交
  const r = scanCsvToBands('500,-70\n500.1,-70', 0.05, -90);
  assert.deepEqual(r.bands, [
    { lo: 499.975, hi: 500.025 },
    { lo: 500.075, hi: 500.125 },
  ]);
});

test('整批校验：非法数值与列数错误指出原始行号（空行占行）', () => {
  assert.throws(() => scanCsvToBands('500,-80\n\nabc,1', 0.05, -90), /第 3 行/);
  assert.throws(() => scanCsvToBands('500,-80\n501,', 0.05, -90), /第 2 行/);
  assert.throws(() => scanCsvToBands('500,-80\n,-70', 0.05, -90), /第 2 行/);
  assert.throws(() => scanCsvToBands('500', 0.05, -90), /第 1 行/);
  assert.throws(() => scanCsvToBands('500,-80,extra', 0.05, -90), /第 1 行/);
  assert.throws(() => scanCsvToBands('500,Infinity', 0.05, -90), /第 1 行/);
});

test('整批校验：采样间隔必须为正，阈值必须为有限数值', () => {
  assert.throws(() => scanCsvToBands('500,-80', 0, -90), /采样间隔/);
  assert.throws(() => scanCsvToBands('500,-80', -0.05, -90), /采样间隔/);
  assert.throws(() => scanCsvToBands('500,-80', NaN, -90), /采样间隔/);
  assert.throws(() => scanCsvToBands('500,-80', '', -90), /采样间隔/);
  assert.throws(() => scanCsvToBands('500,-80', 0.05, 'abc'), /阈值/);
  assert.throws(() => scanCsvToBands('500,-80', 0.05, Infinity), /阈值/);
});

test('整批校验：非空记录最多 1000 条，超出指出行号', () => {
  const lines = [];
  for (let i = 0; i < SCAN_MAX_RECORDS; i++) lines.push(`${400 + i},-80`);
  assert.equal(scanCsvToBands(lines.join('\n'), 0.05, -90).records, SCAN_MAX_RECORDS);

  // 第 1001 条（其原始行号为 1001）
  lines.push(`${500 + SCAN_MAX_RECORDS},-80`);
  assert.throws(() => scanCsvToBands(lines.join('\n'), 0.05, -90), new RegExp(`第 ${SCAN_MAX_RECORDS + 1} 行`));
});

test('空数据、仅空行与非字符串 CSV 报错；CRLF 与首尾空白正常解析', () => {
  assert.throws(() => scanCsvToBands('', 0.05, -90), /为空/);
  assert.throws(() => scanCsvToBands('  \n \n\t', 0.05, -90), /为空/);
  assert.throws(() => scanCsvToBands(undefined, 0.05, -90), /CSV 文本/);

  const r = scanCsvToBands(' 500 , -80 \r\n501,-60\r\n\r\n', 0.05, -90);
  assert.equal(r.records, 2);
  assert.equal(r.points, 2);
  assert.equal(r.occupied, 2);
});

/* ---------- HTTP 接口 ---------- */

test('POST /api/scan-bands：返回合并区间与统计', async () => {
  const res = await request('POST', '/api/scan-bands', {
    csv: '500,-80\n500.025,-70\n500.1,-95',
    interval: 0.05,
    threshold: -90,
  });
  assert.equal(res.status, 200, res.data.error);
  assert.deepEqual(res.data.bands, [{ lo: 499.975, hi: 500.05 }]);
  assert.equal(res.data.records, 3);
  assert.equal(res.data.points, 3);
  assert.equal(res.data.occupied, 2);
});

test('POST /api/scan-bands：校验失败返回 400 且错误指出行号', async () => {
  const res = await request('POST', '/api/scan-bands', {
    csv: '500,-80\nxyz,-1',
    interval: 0.05,
    threshold: -90,
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /第 2 行/);

  const badInterval = await request('POST', '/api/scan-bands', {
    csv: '500,-80',
    interval: 0,
    threshold: -90,
  });
  assert.equal(badInterval.status, 400);
  assert.match(badInterval.data.error, /采样间隔/);
});

test('扫描区间与手填区间合并送入协调：避让生效，结果与保存的方案记录合并后区间', async () => {
  await createDevice('A', 500);
  // 扫描：500 MHz 电平 -70，间隔 0.1 → [499.95, 500.05]
  const scan = await request('POST', '/api/scan-bands', { csv: '500,-70', interval: 0.1, threshold: -90 });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.data.bands, [{ lo: 499.95, hi: 500.05 }]);

  // 手填区间 [600, 601] 不影响候选，仅验证两类区间一并合并、记录
  const coord = await request('POST', '/api/coordinate', {
    bandMin: 490,
    bandMax: 510,
    step: 0.025,
    maxOffset: 2,
    occupiedBands: [...scan.data.bands, { lo: 600, hi: 601 }],
  });
  assert.equal(coord.status, 200, coord.data.error);
  assert.equal(coord.data.solved, true);

  // 新载频保护区 [f-0.25, f+0.25] 不得与扫描区间 [499.95, 500.05] 相交（闭区间）
  const f = coord.data.assignments[0].frequency;
  assert.ok(f + 0.25 < 499.95 || f - 0.25 > 500.05, `频率 ${f} 未避让扫描区间`);
  assert.notEqual(f, 500);

  // 合并后的区间随协调结果返回（按频率排序）
  assert.deepEqual(coord.data.params.occupiedBands, [
    { lo: 499.95, hi: 500.05 },
    { lo: 600, hi: 601 },
  ]);

  // 保存方案时记录合并后的区间
  const saved = await request('POST', '/api/plans', {
    name: '扫描避让方案',
    params: coord.data.params,
    assignments: coord.data.assignments,
    totalOffset: coord.data.totalOffset,
    solved: coord.data.solved,
  });
  assert.equal(saved.status, 201);
  const plans = await request('GET', '/api/plans');
  const plan = plans.data.find((p) => p.id === saved.data.id);
  assert.deepEqual(plan.params.occupiedBands, [
    { lo: 499.95, hi: 500.05 },
    { lo: 600, hi: 601 },
  ]);
});

test('扫描接口为纯计算：不写入设备、方案，原始采样不入库', async () => {
  const res = await request('POST', '/api/scan-bands', { csv: '500,-70', interval: 0.1, threshold: -90 });
  assert.equal(res.status, 200);
  const plans = await request('GET', '/api/plans');
  assert.equal(plans.data.length, 0);
  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.length, 0);
  // 数据库中不存在任何采样数据（plans 仅记录合并后的占用区间；此处无方案）
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get().c, 0);
});
