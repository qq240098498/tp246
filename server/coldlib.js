// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    // 后来的手工记录覆盖先前的自动记录
    if (row.source === '人工' && current.source === '自动') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT（平均动力学温度）：MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T)))/n)) − 273.15
// Ea 取 83144 J/mol、R 取 8.314，T 用开尔文；不是把温度取平均
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const ea = Number(settings.mktActivationEnergy || 83144);
  const r = Number(settings.gasConstant || 8.314);
  let sum = 0;
  for (const row of rows) {
    const kelvin = Number(row.temperatureC) + 273.15;
    sum += Math.exp((-ea) / (r * kelvin));
  }
  const mktKelvin = (-ea) / (r * Math.log(sum / rows.length));
  return store.round(mktKelvin - 273.15, 2);
}

// 探头校准有效期：校准日当天仍有效，次日起算过期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

// 探头的在册状态（台账状态 + 校准状态），口径集中在这里
// 台账状态：在用 / 停用 / 送检 / 报废（报废探头不再挂在提醒清单里）
// 校准状态：有效 / 即将到期（warnDays 天内到期）/ 已过期（逾期 overdueDays 天）
function probeCalibrationStatus(probe, day, warnDays) {
  const until = probe && probe.calibratedUntil ? String(probe.calibratedUntil) : '';
  if (!until) return { state: '无校准记录', until: '', daysLeft: null, overdueDays: 0 };
  const diff = store.daysBetween(day, until);
  if (diff < 0) return { state: '已过期', until, daysLeft: diff, overdueDays: -diff };
  if (diff <= Number(warnDays || 0)) return { state: '即将到期', until, daysLeft: diff, overdueDays: 0 };
  return { state: '有效', until, daysLeft: diff, overdueDays: 0 };
}

// 探头在某一天是否还能参与放行判定：
// 送检中 / 停用 / 报废 的探头名下记录不参与判定；校准过期后其记录也不参与判定
function probeUsableOn(data, probe, day) {
  if (!probe) return { usable: false, reason: '探头不存在' };
  if (probe.status === '报废') return { usable: false, reason: '已报废' };
  if (probe.status === '停用') return { usable: false, reason: '已停用' };
  if (probe.status === '送检') return { usable: false, reason: '送检中' };
  if (!probeValidOn(probe, day)) return { usable: false, reason: '校准已过期' };
  return { usable: true, reason: '' };
}

// 判定时被剔除/失效的探头记录（只取每支探头最早的一条失效时刻）
function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  const seen = {};
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    const recDay = String(row.at).slice(0, 10);
    const check = probeUsableOn(data, probe, recDay);
    if (check.usable || seen[probe.id]) continue;
    seen[probe.id] = true;
    bad.push({
      probeId: probe.id,
      probeCode: probe.code,
      status: probe.status,
      calibratedUntil: probe.calibratedUntil,
      reason: check.reason,
      at: row.at,
    });
  }
  return bad;
}

// 参与判定的有效记录：剔除停用/送检/报废/记录时校准已过期探头名下的记录
function judgmentRecords(data, batchId) {
  return effectiveRecords(data, batchId).filter((row) => {
    const probe = probeOf(data, row.probeId);
    return probeUsableOn(data, probe, String(row.at).slice(0, 10)).usable;
  });
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准四条，同时满足才算满足
// 没有任何温度记录不能放行；停用/送检/报废/记录时已过校准期的探头名下记录不参与判定
function releaseCheck(data, batch) {
  const settings = data.settings;
  const allStats = excursionStats(data, batch.id);
  const validRows = judgmentRecords(data, batch);
  const validStats = Object.assign(segmentStats(validRows, settings), {
    recordCount: validRows.length,
    firstAt: validRows.length ? validRows[0].at : '',
    lastAt: validRows.length ? validRows[validRows.length - 1].at : '',
  });
  // 断链只按参与判定的有效记录算
  const chain = (function () {
    const gaps = [];
    for (let i = 1; i < validRows.length; i += 1) {
      const minutes = store.minutesBetween(validRows[i - 1].at, validRows[i].at);
      if (minutes > Number(settings.chainGapMinutes)) {
        gaps.push({ from: validRows[i - 1].at, to: validRows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
      }
    }
    return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
  })();
  const expired = expiredProbes(data, batch.id, store.todayText());
  const conditions = [
    { key: 'longest', ok: validStats.longestMinutes <= Number(settings.allowExcursionMinutes), value: validStats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: validStats.totalMinutes <= Number(settings.allowTotalExcursionMinutes), value: validStats.totalMinutes, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟（按批次周期累计，跨月不重置）' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
    { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在用且在校准有效期内（送检中、停用、报废、已过期的不参与）' },
  ];
  // 独立闸门：没有任何温度记录的批次不能放行（四条之外的硬门槛）
  const hasRecords = allStats.recordCount > 0;
  const fourPass = conditions.every((c) => c.ok);
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: validStats.longestMinutes,
    totalMinutes: validStats.totalMinutes,
    recordCount: allStats.recordCount,
    validRecordCount: validStats.recordCount,
    hasRecords,
    noRecord: !hasRecords,
    firstAt: allStats.firstAt,
    lastAt: allStats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: fourPass && hasRecords,
    failed: conditions.filter((c) => !c.ok).map((c) => c.key).concat(hasRecords ? [] : ['records']),
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  judgmentRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  probeCalibrationStatus,
  probeUsableOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  releaseCheck,
};
