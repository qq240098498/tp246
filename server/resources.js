const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检', '报废'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];
const CALIBRATION_STATUS = ['送检中', '已完成'];
const CALIBRATION_RESULT = ['换证', '复校', '不合格'];
const CALIBRATION_HANDLING = ['停用', '报废'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function roomName(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.name : '';
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
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
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
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
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
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
  }));
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

/* ---------- 探头校准与送检 ---------- */

function decorateCalibration(data, cal) {
  const probe = coldlib.probeOf(data, cal.probeId);
  const today = store.nowText().slice(0, 10);
  const sentDay = String(cal.sentAt || '').slice(0, 10);
  const endDay = cal.status === '送检中' ? today : String(cal.resultAt || '').slice(0, 10);
  return Object.assign({}, cal, {
    probeCode: probe ? probe.code : '',
    probeStatus: probe ? probe.status : '',
    roomCode: probe ? roomCode(data, probe.roomId) : '',
    roomName: probe ? roomName(data, probe.roomId) : '',
    position: probe ? probe.position : '',
    daysOut: sentDay && endDay ? coldlib.daysBetween(sentDay, endDay) : 0,
    lateDays: cal.expectedBack && endDay ? Math.max(0, coldlib.daysBetween(String(cal.expectedBack), endDay)) : 0,
  });
}

function listCalibrations(data, query) {
  const q = query || {};
  let rows = data.calibrations.slice();
  if (q.probeId) rows = rows.filter((c) => c.probeId === q.probeId);
  if (q.status) rows = rows.filter((c) => c.status === q.status);
  return rows.map((c) => decorateCalibration(data, c)).sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
}

// 到期提醒清单：只盯在用探头；已过期的一直挂着并累计逾期天数，直到送检或者更新有效期
function calibrationDueList(data) {
  const today = store.nowText().slice(0, 10);
  const remindDays = Math.max(0, Number(data.settings.calibrationRemindDays) || 0);
  const expired = [];
  const dueSoon = [];
  for (const p of data.probes) {
    if (p.status !== '在用') continue;
    if (!p.calibratedUntil) continue;
    const daysLeft = coldlib.daysBetween(today, p.calibratedUntil);
    const row = {
      probeId: p.id,
      code: p.code,
      roomCode: roomCode(data, p.roomId),
      roomName: roomName(data, p.roomId),
      position: p.position,
      status: p.status,
      calibratedUntil: p.calibratedUntil,
      lastRecordAt: coldlib.lastRecordAt(data, p.id),
      daysLeft,
    };
    if (daysLeft < 0) expired.push(Object.assign({}, row, { overdueDays: -daysLeft }));
    else if (daysLeft <= remindDays) dueSoon.push(row);
  }
  expired.sort((a, b) => (b.overdueDays - a.overdueDays) || (a.code < b.code ? -1 : 1));
  dueSoon.sort((a, b) => (a.daysLeft - b.daysLeft) || (a.code < b.code ? -1 : 1));
  const inCalibration = data.calibrations
    .filter((c) => c.status === '送检中')
    .map((c) => decorateCalibration(data, c))
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
  return { today, remindDays, expired, dueSoon, inCalibration };
}

// 这趟送检涉及的批次：在办（在库/待放行）且名下有这个探头记录的批次
function affectedBatches(data, probeId) {
  const batchIds = {};
  for (const r of data.records) {
    if (r.probeId === probeId) batchIds[r.batchId] = true;
  }
  return data.batches.filter((b) => batchIds[b.id] && (b.status === '在库' || b.status === '待放行'));
}

function checkSnapshot(data, batch) {
  const check = coldlib.releaseCheck(data, batch);
  return {
    batchId: batch.id,
    code: batch.code,
    pass: check.pass,
    ok: check.pass && check.expiredProbes.length === 0 && check.recordCount > 0,
    failed: check.failed,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    recordCount: check.recordCount,
  };
}

// 登记送检：建送检单、探头转「送检」，并快照涉及批次当时的判定结论
function dispatchProbe(data, probeId, payload) {
  const probe = data.probes.find((p) => p.id === probeId);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  if (probe.status === '报废') throw new AppError(409, 'PROBE_SCRAPPED', '报废探头不再送检', { code: probe.code });
  const open = data.calibrations.find((c) => c.probeId === probeId && c.status === '送检中');
  if (open) throw new AppError(409, 'CALIBRATION_OPEN', '这个探头已有在途送检单（' + open.id + '），先登记结果或者撤销', { calibrationId: open.id });
  const errors = {};
  if (!String(payload.agency || '').trim()) errors.agency = '送检单位不能为空';
  if (!String(payload.sentBy || '').trim()) errors.sentBy = '送检人不能为空';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.expectedBack || ''))) errors.expectedBack = '预计返回日期要像 2026-10-15';
  if (payload.sentAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.sentAt))) errors.sentAt = '送检时刻格式要像 2026-10-04 09:00:00';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '送检登记有几项没通过校验', errors);
  const beforeChecks = affectedBatches(data, probe.id).map((b) => checkSnapshot(data, b));
  const cal = {
    id: store.nextId('cal', data.calibrations),
    probeId: probe.id,
    sentAt: String(payload.sentAt || store.nowText()),
    agency: String(payload.agency).trim(),
    sentBy: String(payload.sentBy).trim(),
    expectedBack: String(payload.expectedBack),
    status: '送检中',
    remark: String(payload.remark || '').trim(),
    beforeChecks,
  };
  data.calibrations.push(cal);
  probe.status = '送检';
  return decorateCalibration(data, cal);
}

// 登记结果：换证/复校更新校准有效期并回到在用；不合格按口径停用或者报废；
// 并给出这一趟涉及哪些批次、哪些批次的判定结论发生了变化
function completeCalibration(data, calId, payload) {
  const cal = data.calibrations.find((c) => c.id === calId);
  if (!cal) throw new AppError(404, 'CALIBRATION_NOT_FOUND', '这趟送检不存在');
  if (cal.status !== '送检中') throw new AppError(409, 'CALIBRATION_DONE', '这趟送检已经登记过结果', { id: cal.id });
  const probe = coldlib.probeOf(data, cal.probeId);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '送检单名下的探头不存在');
  const result = String(payload.result || '');
  const errors = {};
  if (!CALIBRATION_RESULT.includes(result)) errors.result = '结果只能是：' + CALIBRATION_RESULT.join('、');
  if ((result === '换证' || result === '复校') && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.newCalibratedUntil || ''))) {
    errors.newCalibratedUntil = '换证或者复校要填新的校准有效期，格式像 2027-10-13';
  }
  if (result === '不合格' && !CALIBRATION_HANDLING.includes(payload.handling)) {
    errors.handling = '不合格时要选处理方式：' + CALIBRATION_HANDLING.join('、');
  }
  if (payload.resultAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.resultAt))) {
    errors.resultAt = '结果登记时刻格式要像 2026-10-14 10:00:00';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '送检结果有几项没通过校验', errors);

  cal.result = result;
  cal.resultAt = String(payload.resultAt || store.nowText());
  cal.status = '已完成';
  cal.resultRemark = String(payload.remark || '').trim();
  if (result === '换证' || result === '复校') {
    cal.newCalibratedUntil = String(payload.newCalibratedUntil);
    probe.calibratedUntil = cal.newCalibratedUntil;
    probe.status = '在用';
  } else {
    cal.handling = payload.handling;
    probe.status = payload.handling;
  }

  const beforeMap = {};
  for (const s of cal.beforeChecks || []) beforeMap[s.batchId] = s;
  const afterList = affectedBatches(data, cal.probeId).map((b) => checkSnapshot(data, b));
  const afterMap = {};
  for (const s of afterList) afterMap[s.batchId] = s;
  const ids = [];
  for (const id of Object.keys(beforeMap).concat(Object.keys(afterMap))) {
    if (ids.indexOf(id) === -1) ids.push(id);
  }
  const rows = ids.map((id) => {
    const before = beforeMap[id] || null;
    const after = afterMap[id] || null;
    const changed = !!(before && after && (
      before.ok !== after.ok ||
      before.pass !== after.pass ||
      JSON.stringify(before.failed) !== JSON.stringify(after.failed) ||
      JSON.stringify(before.expiredProbeCodes) !== JSON.stringify(after.expiredProbeCodes)
    ));
    return { batchId: id, code: (before || after).code, before, after, changed };
  });
  rows.sort((a, b) => (a.changed === b.changed ? (a.code < b.code ? -1 : 1) : a.changed ? -1 : 1));
  cal.impact = { batches: rows, changedCount: rows.filter((r) => r.changed).length };
  return { calibration: decorateCalibration(data, cal), impact: cal.impact };
}

// 撤销在途送检：删掉送检单，探头回到「在用」
function cancelCalibration(data, calId) {
  const cal = data.calibrations.find((c) => c.id === calId);
  if (!cal) throw new AppError(404, 'CALIBRATION_NOT_FOUND', '这趟送检不存在');
  if (cal.status !== '送检中') throw new AppError(409, 'CALIBRATION_DONE', '只有送检中的单子能撤销', { id: cal.id });
  data.calibrations = data.calibrations.filter((c) => c.id !== calId);
  const probe = coldlib.probeOf(data, cal.probeId);
  if (probe && probe.status === '送检') probe.status = '在用';
  return { removed: calId };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  listCalibrations, calibrationDueList, dispatchProbe, completeCalibration, cancelCalibration,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
  CALIBRATION_STATUS, CALIBRATION_RESULT, CALIBRATION_HANDLING,
};
