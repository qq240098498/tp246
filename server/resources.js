const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
// 送检与报废不在台账编辑里手改：送检由「登记送检」置为送检中，报废由不合格送检结果置为报废
const PROBE_STATUS = ['在用', '停用', '送检', '报废'];
const PROBE_MANUAL_STATUS = ['在用', '停用'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];
const CALIBRATION_RESULT = ['换证', '复校', '不合格'];
const CALIBRATION_FAIL_ACTION = ['停用', '报废'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  const today = store.todayText();
  const cal = coldlib.probeCalibrationStatus(probe, today, data.settings.calibrationWarnDays);
  const openCal = openCalibrationOf(data, probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    lastRecordAt: records.length
      ? records.map((r) => r.at).sort((a, b) => (a < b ? 1 : -1))[0]
      : '',
    calState: cal.state,
    daysLeft: cal.daysLeft,
    overdueDays: cal.overdueDays,
    expired: cal.state === '已过期',
    calibrationId: openCal ? openCal.id : '',
    expectedReturnAt: openCal ? openCal.expectedReturnAt : '',
  });
}

// 当前未闭环的送检单（送检中，还没有登记结果）
function openCalibrationOf(data, probeId) {
  return data.calibrations.find((c) => c.probeId === probeId && !c.returnedAt) || null;
}

function decorateCalibration(data, cal) {
  const probe = data.probes.find((p) => p.id === cal.probeId);
  const room = probe ? data.rooms.find((r) => r.id === probe.roomId) : null;
  return Object.assign({}, cal, {
    probeCode: probe ? probe.code : '',
    position: probe ? probe.position : '',
    roomId: probe ? probe.roomId : '',
    roomCode: room ? room.code : '',
    roomName: room ? room.name : '',
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  // 台账表单只能手动置「在用/停用」；送检与报废必须走送检流程
  const allowed = current && (current.status === '送检' || current.status === '报废')
    ? PROBE_MANUAL_STATUS.concat([current.status])
    : PROBE_MANUAL_STATUS;
  if (!allowed.includes(merged.status)) errors.status = '状态只能是：' + PROBE_MANUAL_STATUS.join('、') + '；送检与报废请在「校准提醒」里走送检流程';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  const calCount = data.calibrations.filter((c) => c.probeId === id).length;
  if (calCount > 0) throw new AppError(409, 'PROBE_HAS_CALIBRATIONS', '这支探头有 ' + calCount + ' 张送检单，不能删除；不合格请在送检结果里走停用或报废', { count: calCount });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const rows = coldlib.recordsOfBatch(data, id).map((r) => {
    const probe = coldlib.probeOf(data, r.probeId);
    const usable = coldlib.probeUsableOn(data, probe, String(r.at).slice(0, 10));
    return Object.assign({}, r, {
      probeCode: probeCode(data, r.probeId),
      probeStatus: probe ? probe.status : '',
      probeExpired: !usable.usable,
      probeUsableReason: usable.reason,
    });
  });
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  return rows
    .map((r) => Object.assign({}, r, {
      batchCode: batchCode(data, r.batchId),
      probeCode: probeCode(data, r.probeId),
      outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId) }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

/* ---------- 校准提醒与送检 ---------- */

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 到期/即将到期/送检中清单。报废探头不再挂在清单上；逾期不处理的探头会一直挂着，逾期天数按天增长
function listCalibrationWatch(data, query) {
  const q = query || {};
  const today = store.todayText();
  const warnDays = q.warnDays !== undefined && q.warnDays !== ''
    ? Number(q.warnDays)
    : Number(data.settings.calibrationWarnDays);
  let rows = data.probes.filter((p) => p.status !== '报废');
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  const items = rows.map((p) => {
    const d = decorateProbe(data, p);
    // 清单的分桶按本次请求的提前天数重算（页面上可以临时改），台账字段保留设置值口径
    const cal = coldlib.probeCalibrationStatus(p, today, warnDays);
    d.calState = cal.state;
    d.daysLeft = cal.daysLeft;
    d.overdueDays = cal.overdueDays;
    d.expired = cal.state === '已过期';
    let bucket;
    if (d.status === '送检') bucket = 'sent';
    else if (d.calState === '已过期') bucket = 'overdue';
    else if (d.calState === '即将到期') bucket = 'dueSoon';
    else if (d.calState === '无校准记录') bucket = 'none';
    else bucket = 'ok';
    return Object.assign(d, { bucket });
  });
  let shown = items;
  if (q.bucket === 'open') {
    shown = items.filter((i) => i.bucket === 'overdue' || i.bucket === 'dueSoon' || i.bucket === 'sent');
  } else if (q.bucket) {
    shown = items.filter((i) => i.bucket === q.bucket);
  }
  const rank = { overdue: 0, dueSoon: 1, sent: 2, none: 3, ok: 4 };
  shown.sort((a, b) => {
    if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket];
    if (a.bucket === 'overdue') return b.overdueDays - a.overdueDays;
    if (a.bucket === 'dueSoon') return a.daysLeft - b.daysLeft;
    if (a.bucket === 'sent') return String(a.expectedReturnAt).localeCompare(String(b.expectedReturnAt));
    return String(a.calibratedUntil).localeCompare(String(b.calibratedUntil));
  });
  return {
    today,
    warnDays,
    counts: {
      overdue: items.filter((i) => i.bucket === 'overdue').length,
      dueSoon: items.filter((i) => i.bucket === 'dueSoon').length,
      sent: items.filter((i) => i.bucket === 'sent').length,
      none: items.filter((i) => i.bucket === 'none').length,
    },
    items: shown,
  };
}

function listCalibrations(data, query) {
  const q = query || {};
  let rows = data.calibrations.slice();
  if (q.probeId) rows = rows.filter((c) => c.probeId === q.probeId);
  if (q.open === '1' || q.open === 'true') rows = rows.filter((c) => !c.returnedAt);
  return rows.map((c) => decorateCalibration(data, c)).sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
}

function validateSendCalibration(data, probeId, payload) {
  const probe = data.probes.find((p) => p.id === probeId);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const errors = {};
  if (probe.status === '报废') errors.probeId = '已报废的探头不能再送检';
  if (openCalibrationOf(data, probeId)) errors.probeId = '这支探头已有一单未闭环的送检，回来登记结果后才能再送检';
  if (!DATETIME_RE.test(String(payload.sentAt || ''))) errors.sentAt = '送检时刻格式要像 2026-10-01 09:00:00';
  if (!String(payload.lab || '').trim()) errors.lab = '送检单位要填';
  if (!DATE_RE.test(String(payload.expectedReturnAt || ''))) errors.expectedReturnAt = '预计返回日期格式要像 2026-10-15';
  if (!String(payload.sender || '').trim()) errors.sender = '送检人要填';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '送检单没通过校验', errors);
  return probe;
}

// 登记送检：探头置「送检」。送检期间其名下记录不参与放行判定（口径等同停用），
// 期间到达的自动记录仍可登记留痕，但放行第四条会点名这支探头
function sendCalibration(data, probeId, payload) {
  const probe = validateSendCalibration(data, probeId, payload || {});
  const cal = {
    id: store.nextId('cl', data.calibrations),
    probeId: probe.id,
    sentAt: String(payload.sentAt),
    lab: String(payload.lab).trim(),
    expectedReturnAt: String(payload.expectedReturnAt),
    sender: String(payload.sender).trim(),
    remark: String(payload.remark || '').trim(),
    // 快照送检前的状态，回来登记结果时用它对比「这一趟」前后的批次判定变化
    preStatus: probe.status,
    preCalibratedUntil: probe.calibratedUntil,
    returnedAt: '',
    result: '',
    newCalibratedUntil: '',
    certificateNo: '',
    failAction: '',
    receiver: '',
    resultRemark: '',
  };
  data.calibrations.push(cal);
  const preStatus = probe.status;
  probe.status = '送检';
  return {
    calibration: decorateCalibration(data, cal),
    probe: decorateProbe(data, probe),
    affectedBatches: affectedBatches(data, probe, { status: preStatus, calibratedUntil: probe.calibratedUntil }),
  };
}

// 临时把探头改成指定状态算一遍放行判定，算完恢复
function withProbeOverride(probe, overrides, fn) {
  const saved = {};
  Object.keys(overrides).forEach((k) => { saved[k] = probe[k]; probe[k] = overrides[k]; });
  try {
    return fn();
  } finally {
    Object.assign(probe, saved);
  }
}

function batchImpact(data, batch, probe, beforeOverride) {
  const after = coldlib.releaseCheck(data, batch);
  const before = withProbeOverride(probe, beforeOverride, () => coldlib.releaseCheck(data, batch));
  const afterMap = {};
  after.conditions.forEach((c) => { afterMap[c.key] = c; });
  const changedConditions = [];
  before.conditions.forEach((bc) => {
    const ac = afterMap[bc.key];
    if (!ac || bc.ok === ac.ok) return;
    changedConditions.push({
      key: bc.key,
      text: bc.text,
      before: bc.ok ? '满足' : '不满足',
      after: ac.ok ? '满足' : '不满足',
      beforeValue: bc.value,
      afterValue: ac.value,
    });
  });
  return {
    batchId: batch.id,
    batchCode: batch.code,
    product: batch.product,
    status: batch.status,
    beforePass: before.pass,
    afterPass: after.pass,
    passChanged: before.pass !== after.pass,
    beforeFailed: before.failed,
    afterFailed: after.failed,
    changedConditions,
  };
}

// 这趟送检涉及的批次：名下有这支探头记录的批次（含已放行/已拒收的，便于回看结论变化）
function affectedBatches(data, probe, beforeOverride) {
  const batchIds = {};
  data.records.forEach((r) => { if (r.probeId === probe.id) batchIds[r.batchId] = true; });
  const list = data.batches
    .filter((b) => batchIds[b.id])
    .map((b) => batchImpact(data, b, probe, beforeOverride));
  return {
    count: list.length,
    changedCount: list.filter((x) => x.changedConditions.length).length,
    passChangedCount: list.filter((x) => x.passChanged).length,
    batches: list.sort((a, b) => (a.batchCode < b.batchCode ? -1 : 1)),
  };
}

// 送检回来登记结果：
// 换证 / 复校 → 更新校准有效期，探头恢复在用；
// 不合格 → 按口径停用或报废（报废后不再挂提醒、名下记录永不参与判定）
function returnCalibration(data, calId, payload) {
  const cal = data.calibrations.find((c) => c.id === calId);
  if (!cal) throw new AppError(404, 'CALIBRATION_NOT_FOUND', '这张送检单不存在');
  if (cal.returnedAt) throw new AppError(409, 'CALIBRATION_CLOSED', '这张送检单已经登记过结果，不能重复登记', { id: cal.id });
  const probe = data.probes.find((p) => p.id === cal.probeId);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这支探头已经不在台账里');
  const body = payload || {};
  const errors = {};
  if (!CALIBRATION_RESULT.includes(body.result)) errors.result = '结果只能是：' + CALIBRATION_RESULT.join('、');
  if (!DATETIME_RE.test(String(body.returnedAt || ''))) errors.returnedAt = '返回时刻格式要像 2026-10-12 15:00:00';
  if (body.result === '换证' || body.result === '复校') {
    if (!DATE_RE.test(String(body.newCalibratedUntil || ''))) errors.newCalibratedUntil = '新的校准有效期格式要像 2027-10-12';
  }
  if (body.result === '不合格' && !CALIBRATION_FAIL_ACTION.includes(body.failAction)) {
    errors.failAction = '不合格的处理口径只能是：' + CALIBRATION_FAIL_ACTION.join('、');
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '送检结果没通过校验', errors);

  // 对比口径：回来前按送检单上的送检前快照算（在用 + 旧有效期），回来后按结果算
  const beforeOverride = {
    status: cal.preStatus || '在用',
    calibratedUntil: cal.preCalibratedUntil || probe.calibratedUntil,
  };

  Object.assign(cal, {
    returnedAt: String(body.returnedAt),
    result: body.result,
    newCalibratedUntil: body.result === '不合格' ? '' : String(body.newCalibratedUntil),
    certificateNo: String(body.certificateNo || '').trim(),
    failAction: body.result === '不合格' ? body.failAction : '',
    receiver: String(body.receiver || '').trim(),
    resultRemark: String(body.resultRemark || '').trim(),
  });

  if (body.result === '换证' || body.result === '复校') {
    probe.calibratedUntil = String(body.newCalibratedUntil);
    probe.status = '在用';
  } else {
    probe.status = body.failAction === '报废' ? '报废' : '停用';
  }

  return {
    calibration: decorateCalibration(data, cal),
    probe: decorateProbe(data, probe),
    affectedBatches: affectedBatches(data, probe, beforeOverride),
  };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  listCalibrationWatch, listCalibrations, sendCalibration, returnCalibration,
  openCalibrationOf,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, PROBE_MANUAL_STATUS, BATCH_STATUS, SOURCE_LIST,
  CALIBRATION_RESULT, CALIBRATION_FAIL_ACTION,
};
