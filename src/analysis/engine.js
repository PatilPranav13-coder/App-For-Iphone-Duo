const DEMO_FLAG = 'tessera-demo';
const MAX_IMPORT_ROWS = 250000;
const MAX_IMPORT_COLUMNS = 100;
const MAX_IMPORT_CELLS = 2500000;

export const DEMO_DATASET = Object.freeze({
  id: DEMO_FLAG,
  name: 'Northstar orders',
  source: 'DEMO',
  createdAt: new Date('2026-10-01T00:00:00.000Z').toISOString(),
  rows: Array.from({ length: 36 }, function (_, index) {
    const month = index % 12;
    const region = ['West', 'Central', 'East'][Math.floor(index / 12)];
    const seasonal = [0.84, 0.88, 0.97, 1.03, 1.08, 1.12, 0.92, 0.96, 1.04, 1.13, 1.24, 1.39][month];
    const regional = region === 'West' ? 1.13 : region === 'Central' ? 0.94 : 1.02;
    const disruption = month === 6 && region === 'East' ? 0.67 : 1;
    const revenue = Math.round((20800 + month * 980) * seasonal * regional * disruption);
    return {
      Month: new Date(Date.UTC(2025, month, 1)).toISOString().slice(0, 7),
      Region: region,
      Product: ['Studio', 'Field', 'Core'][index % 3],
      Revenue: revenue,
      Orders: Math.round(revenue / (212 + (index % 5) * 12)),
      'Margin %': Number((0.23 + (month % 4) * 0.013 + (region === 'West' ? 0.025 : 0)).toFixed(3)),
      Channel: ['Direct', 'Partner', 'Online'][(month + Math.floor(index / 12)) % 3]
    };
  }),
  columns: ['Month', 'Region', 'Product', 'Revenue', 'Orders', 'Margin %', 'Channel']
});

export function parseTextTable(text, delimiter) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const separator = delimiter || (firstLine.includes('\t') ? '\t' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === separator) {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some(function (value) { return value !== ''; })) {
        rows.push(row);
        if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error('This release can import up to 250,000 rows at a time.');
      }
      row = [];
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('This table has an unmatched quote.');
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some(function (value) { return value !== ''; })) rows.push(row);
  }
  if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error('This release can import up to 250,000 rows at a time.');
  if (!rows.length) throw new Error('No records were found in this file.');
  const columns = rows.shift().map(function (value, index) {
    return value.trim() || 'Column ' + (index + 1);
  });
  if (columns.length > MAX_IMPORT_COLUMNS) throw new Error('This release can import up to 100 columns at a time.');
  if ((rows.length * columns.length) > MAX_IMPORT_CELLS) throw new Error('This dataset exceeds the 2.5 million cell import limit.');
  const records = rows.map(function (values) {
    return Object.fromEntries(columns.map(function (column, index) {
      const raw = (values[index] ?? '').trim();
      return [column, coerceValue(raw)];
    }));
  });
  return { rows: records, columns };
}

function coerceValue(value) {
  if (value === '') return null;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}

export async function parseDatasetFile(file) {
  const extension = file.name.toLowerCase().split('.').pop();
  if (file.size > 50 * 1024 * 1024) throw new Error('This browser upload is limited to 50 MB.');
  if (extension === 'json') {
    const data = JSON.parse(await file.text());
    const rows = Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : null);
    if (!rows || !rows.length || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0]) ||
      rows.some(function (row) { return !row || typeof row !== 'object' || Array.isArray(row); })) {
      throw new Error('JSON should contain a non-empty array of row objects.');
    }
    if (rows.length > MAX_IMPORT_ROWS) throw new Error('This release can import up to 250,000 rows at a time.');
    const columns = Array.from(new Set(rows.flatMap(function (item) { return Object.keys(item); })));
    if (columns.length > MAX_IMPORT_COLUMNS) throw new Error('This release can import up to 100 columns at a time.');
    if (rows.length * columns.length > MAX_IMPORT_CELLS) throw new Error('This dataset exceeds the 2.5 million cell import limit.');
    return { rows: rows.map(function (record) { return Object.fromEntries(columns.map(function (column) { return [column, record[column] ?? null]; })); }), columns };
  }
  if (extension === 'xlsx' || extension === 'xls') {
    if (extension === 'xls') throw new Error('Legacy .xls files are not supported yet. Save this workbook as .xlsx or CSV.');
    const response = await fetch('/api/import/xlsx', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-file-name': encodeURIComponent(file.name) },
      body: file
    });
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(payload.error || 'This Excel workbook could not be read.');
    return payload;
  }
  if (extension === 'csv' || extension === 'tsv') return parseTextTable(await file.text(), extension === 'tsv' ? '\t' : undefined);
  throw new Error('Choose a CSV, TSV, JSON or Excel workbook.');
}

export function profileDataset(rows, suppliedColumns) {
  const columns = suppliedColumns?.length ? suppliedColumns : Array.from(new Set(rows.flatMap(function (row) { return Object.keys(row); })));
  const columnProfiles = columns.map(function (name) {
    const values = rows.map(function (row) { return row[name]; });
    const present = values.filter(isPresent);
    const numeric = present.filter(function (value) { return typeof value === 'number' && Number.isFinite(value); });
    const dates = present.filter(function (value) { return value instanceof Date || (typeof value === 'string' && isDateLike(value)); });
    const booleans = present.filter(function (value) { return typeof value === 'boolean'; });
    const type = !present.length ? 'empty' :
      numeric.length / present.length >= 0.82 ? 'number' :
      dates.length / present.length >= 0.82 ? 'date' :
      booleans.length / present.length >= 0.82 ? 'boolean' : 'category';
    const distinct = new Set(present.map(normalize)).size;
    const valuesNumeric = numeric.sort(function (a, b) { return a - b; });
    const outliers = type === 'number' ? countIqrOutliers(valuesNumeric) : 0;
    return {
      name,
      type,
      missing: values.length - present.length,
      missingPct: values.length ? (values.length - present.length) / values.length : 0,
      distinct,
      min: type === 'number' && valuesNumeric.length ? valuesNumeric[0] : null,
      max: type === 'number' && valuesNumeric.length ? valuesNumeric[valuesNumeric.length - 1] : null,
      mean: type === 'number' && valuesNumeric.length ? mean(valuesNumeric) : null,
      outliers
    };
  });
  const rowKeys = new Set();
  let duplicateRows = 0;
  rows.forEach(function (row) {
    const key = JSON.stringify(columns.map(function (column) { return normalize(row[column]); }));
    if (rowKeys.has(key)) duplicateRows += 1;
    rowKeys.add(key);
  });
  return {
    rowCount: rows.length,
    columnCount: columns.length,
    columns: columnProfiles,
    duplicateRows,
    missingCells: columnProfiles.reduce(function (sum, column) { return sum + column.missing; }, 0),
    qualityScore: qualityScore(rows.length, columnProfiles, duplicateRows),
    numericColumns: columnProfiles.filter(function (column) { return column.type === 'number'; }).map(function (column) { return column.name; }),
    categoryColumns: columnProfiles.filter(function (column) { return column.type === 'category' || column.type === 'date'; }).map(function (column) { return column.name; })
  };
}

export function makeFindings(rows, profile) {
  if (!rows.length) return [];
  const findings = [];
  if (profile.missingCells) {
    findings.push({
      id: 'quality-missing', kind: 'quality', title: 'Some values are missing',
      detail: formatCount(profile.missingCells) + ' empty cells across ' + profile.columns.filter(function (column) { return column.missing; }).length + ' columns.',
      evidence: 'Computed from all ' + formatCount(rows.length) + ' rows.'
    });
  }
  if (profile.duplicateRows) {
    findings.push({
      id: 'quality-duplicates', kind: 'quality', title: 'Duplicate records detected',
      detail: formatCount(profile.duplicateRows) + ' repeated row' + (profile.duplicateRows === 1 ? '' : 's') + ' found.',
      evidence: 'Rows are compared across all detected columns.'
    });
  }
  const outlierColumn = profile.columns.filter(function (column) { return column.outliers > 0; }).sort(function (a, b) { return b.outliers - a.outliers; })[0];
  if (outlierColumn) {
    findings.push({
      id: 'outlier-' + outlierColumn.name, kind: 'signal', title: 'Unusual values in ' + outlierColumn.name,
      detail: outlierColumn.outliers + ' potential outlier' + (outlierColumn.outliers === 1 ? '' : 's') + ' by the 1.5× IQR rule.',
      evidence: 'A statistical flag for investigation; not evidence of an error.'
    });
  }
  const dateCol = profile.columns.find(function (column) { return column.type === 'date'; });
  const numericCol = profile.columns.find(function (column) { return column.type === 'number'; });
  if (dateCol && numericCol) {
    const timeline = aggregateRows(rows, dateCol.name, numericCol.name, 'sum');
    if (timeline.length > 1) {
      const first = timeline[0].value;
      const last = timeline[timeline.length - 1].value;
      const change = first ? (last - first) / Math.abs(first) : null;
      if (change !== null) {
        findings.push({
          id: 'trend-' + numericCol.name, kind: change >= 0 ? 'positive' : 'signal',
          title: (change >= 0 ? 'Growth' : 'Decline') + ' across the observed period',
          detail: formatPercent(change) + ' change in ' + numericCol.name + ' from ' + timeline[0].label + ' to ' + timeline[timeline.length - 1].label + '.',
          evidence: formatMoneyOrNumber(first, numericCol.name) + ' → ' + formatMoneyOrNumber(last, numericCol.name) + '; grouped by ' + dateCol.name + '.'
        });
      }
    }
  }
  const category = profile.columns.find(function (column) { return column.type === 'category' && column.distinct <= 50; });
  if (category && numericCol) {
    const groups = aggregateRows(rows, category.name, numericCol.name, 'sum').sort(function (a, b) { return b.value - a.value; });
    if (groups.length > 1) {
      findings.push({
        id: 'leader-' + category.name, kind: 'insight',
        title: groups[0].label + ' leads ' + numericCol.name,
        detail: formatMoneyOrNumber(groups[0].value, numericCol.name) + ' across ' + formatCount(groups[0].count) + ' records.',
        evidence: 'Highest total among ' + groups.length + ' ' + category.name + ' groups.'
      });
    }
  }
  if (!findings.length) {
    findings.push({
      id: 'profile-ready', kind: 'insight',
      title: 'Dataset is ready to explore',
      detail: formatCount(profile.rowCount) + ' records across ' + profile.columnCount + ' columns.',
      evidence: 'Use the chart controls to select a measure and grouping.'
    });
  }
  return findings.slice(0, 5);
}

export function aggregateRows(rows, xColumn, yColumn, operation) {
  const groups = new Map();
  rows.forEach(function (row) {
    const rawX = row[xColumn];
    const x = rawX instanceof Date ? rawX.toISOString().slice(0, 10) : (rawX ?? 'Missing');
    const key = String(x);
    if (!groups.has(key)) groups.set(key, { label: key, total: 0, count: 0, values: [] });
    const group = groups.get(key);
    const value = Number(row[yColumn]);
    if (isPresent(row[yColumn]) && Number.isFinite(value)) {
      group.total += value;
      group.count += 1;
      group.values.push(value);
    }
  });
  const output = Array.from(groups.values()).map(function (item) {
    return { label: item.label, value: operation === 'average' ? (item.count ? item.total / item.count : 0) : item.total, count: item.count };
  });
  if (output.length && output.every(function (item) { return !Number.isNaN(Date.parse(item.label)); })) {
    output.sort(function (a, b) { return Date.parse(a.label) - Date.parse(b.label); });
  } else if (output.length && output.every(function (item) { return Number.isFinite(Number(item.label)); })) {
    output.sort(function (a, b) { return Number(a.label) - Number(b.label); });
  } else {
    output.sort(function (a, b) { return b.value - a.value; });
  }
  return output;
}

export function getCorrelations(rows, numericColumns) {
  const pairs = [];
  for (let i = 0; i < numericColumns.length; i += 1) {
    for (let j = i + 1; j < numericColumns.length; j += 1) {
      const a = rows.map(function (row) { return isPresent(row[numericColumns[i]]) ? Number(row[numericColumns[i]]) : NaN; });
      const b = rows.map(function (row) { return isPresent(row[numericColumns[j]]) ? Number(row[numericColumns[j]]) : NaN; });
      const correlation = pearson(a, b);
      if (Number.isFinite(correlation)) pairs.push({ x: numericColumns[i], y: numericColumns[j], r: correlation });
    }
  }
  return pairs.sort(function (a, b) { return Math.abs(b.r) - Math.abs(a.r); });
}

export function answerLocally(question, rows, profile, selectedPoint, chart) {
  const query = question.toLowerCase();
  const findings = makeFindings(rows, profile);
  const reference = function (label, value) { return { label, value: String(value) }; };
  if (selectedPoint && chart?.x && chart?.y && /this point|selected|here|this month|why did|why is/.test(query)) {
    let selectedRows;
    if (selectedPoint.type === 'scatter' && Number.isInteger(selectedPoint.rowIndex) && rows[selectedPoint.rowIndex]) {
      selectedRows = [rows[selectedPoint.rowIndex]];
    } else if (selectedPoint.type === 'histogram' && Number.isFinite(selectedPoint.lower) && Number.isFinite(selectedPoint.upper)) {
      const values = rows.map(function (row) { return Number(row[chart.y]); }).filter(Number.isFinite);
      const max = values.reduce(function (result, value) { return Math.max(result, value); }, -Infinity);
      selectedRows = rows.filter(function (row) {
        const value = Number(row[chart.y]);
        return Number.isFinite(value) && value >= selectedPoint.lower && (selectedPoint.upper === max ? value <= selectedPoint.upper : value < selectedPoint.upper);
      });
    } else if (selectedPoint.type === 'donut' && selectedPoint.otherBucket) {
      const topLabels = new Set(aggregateRows(rows, chart.x, chart.y, 'sum').slice().sort(function (a, b) { return b.value - a.value; }).slice(0, 6).map(function (item) { return item.label; }));
      selectedRows = rows.filter(function (row) {
        const raw = row[chart.x] instanceof Date ? row[chart.x].toISOString().slice(0, 10) : row[chart.x];
        return !topLabels.has(String(raw ?? 'Missing'));
      });
    } else {
      selectedRows = rows.filter(function (row) {
        const value = row[chart.x] instanceof Date ? row[chart.x].toISOString().slice(0, 10) : row[chart.x];
        return String(value) === selectedPoint.label;
      });
    }
    const selectedValues = selectedRows.map(function (row) { return Number(row[chart.y]); }).filter(Number.isFinite);
    if (selectedValues.length) {
      const total = selectedValues.reduce(function (sum, value) { return sum + value; }, 0);
      const average = total / selectedValues.length;
      return {
        text: selectedPoint.label + ' contains ' + formatCount(selectedValues.length) + ' valid ' + chart.y + ' values, with a total of ' + formatMoneyOrNumber(total, chart.y) + ' and an average of ' + formatMoneyOrNumber(average, chart.y) + '. This describes the selected records; more context is needed to explain why the value changed.',
        references: [reference('Filtered by', chart.x + ' = ' + selectedPoint.label), reference('Calculation', 'sum and mean of ' + chart.y)]
      };
    }
  }
  if (/correlat|relationship between/.test(query)) {
    const pairs = getCorrelations(rows, profile.numericColumns);
    if (!pairs.length) return null;
    const pair = pairs[0];
    return {
      text: 'The strongest pairwise linear relationship is between ' + pair.x + ' and ' + pair.y + ' (Pearson r = ' + pair.r.toFixed(3) + '). This measures association in the available rows; it does not establish causation.',
      references: [reference('Rows used', rows.length), reference('Calculation', 'Pearson correlation')]
    };
  }
  if (/highest|top|best|leader/.test(query) && profile.numericColumns.length) {
    const number = profile.numericColumns.find(function (name) { return query.includes(name.toLowerCase()); }) || profile.numericColumns[0];
    const groupColumn = profile.columns.find(function (column) { return column.type === 'category' && column.distinct <= 100; });
    if (groupColumn) {
      const top = aggregateRows(rows, groupColumn.name, number, 'sum')[0];
      if (top) return {
        text: top.label + ' has the highest total ' + number + ' in this dataset: ' + formatMoneyOrNumber(top.value, number) + ' across ' + formatCount(top.count) + ' non-empty records.',
        references: [reference('Grouped by', groupColumn.name), reference('Calculation', 'sum of ' + number)]
      };
    }
  }
  if (/missing|null|empty|quality|duplicate/.test(query)) {
    return {
      text: 'The quality scan found ' + formatCount(profile.missingCells) + ' missing cells and ' + formatCount(profile.duplicateRows) + ' duplicate rows across ' + formatCount(profile.rowCount) + ' records.',
      references: [reference('Quality score', profile.qualityScore + '/100'), reference('Calculation', 'all rows and detected columns')]
    };
  }
  if (/outlier|unusual|anomal/.test(query)) {
    const columns = profile.columns.filter(function (column) { return column.outliers > 0; });
    return {
      text: columns.length ? columns.map(function (column) { return column.name + ': ' + column.outliers + ' potential value' + (column.outliers === 1 ? '' : 's'); }).join('; ') + '. Flags use the 1.5× IQR rule and should be investigated in context.' : 'No values crossed the 1.5× IQR outlier rule in the numeric columns.',
      references: [reference('Method', 'Tukey 1.5× IQR')]
    };
  }
  if (/average|mean|typical/.test(query)) {
    const column = profile.columns.find(function (item) { return item.type === 'number' && query.includes(item.name.toLowerCase()); }) || profile.columns.find(function (item) { return item.type === 'number'; });
    if (column && column.mean !== null) return {
      text: 'The average ' + column.name + ' is ' + formatMoneyOrNumber(column.mean, column.name) + ' across ' + formatCount(rows.filter(function (row) { return isPresent(row[column.name]) && Number.isFinite(Number(row[column.name])); }).length) + ' numeric records.',
      references: [reference('Calculation', 'arithmetic mean')]
    };
  }
  if (/analyse|analyze|summar|overview|dataset/.test(query)) {
    return {
      text: 'This dataset contains ' + formatCount(profile.rowCount) + ' rows and ' + profile.columnCount + ' columns. The quality score is ' + profile.qualityScore + '/100, with ' + formatCount(profile.missingCells) + ' missing cells and ' + formatCount(profile.duplicateRows) + ' duplicate rows. ' + (findings[0]?.detail || 'It is ready to explore.'),
      references: [reference('Profile', profile.rowCount + ' rows × ' + profile.columnCount + ' columns')]
    };
  }
  return null;
}

export function summarizeForProvider(rows, profile, findings, includeSamples) {
  return {
    profile: {
      rowCount: profile.rowCount,
      columnCount: profile.columnCount,
      qualityScore: profile.qualityScore,
      columns: profile.columns.map(function (column) { return { name: column.name, type: column.type, missing: column.missing, distinct: column.distinct, mean: column.mean, min: column.min, max: column.max, outliers: column.outliers }; })
    },
    findings: findings.map(function (item) { return { title: item.title, detail: item.detail, evidence: item.evidence }; }),
    sampleRows: includeSamples ? rows.slice(0, 5) : undefined
  };
}

export function formatCount(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(value) {
  return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(value);
}

export function formatMoneyOrNumber(value, column) {
  return new Intl.NumberFormat('en-US', {
    notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 10000 ? 1 : 2
  }).format(value);
}

export function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function normalize(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mean(values) {
  return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function countIqrOutliers(sorted) {
  if (sorted.length < 4) return 0;
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const spread = q3 - q1;
  const min = q1 - 1.5 * spread;
  const max = q3 + 1.5 * spread;
  return sorted.filter(function (value) { return value < min || value > max; }).length;
}

function qualityScore(rowCount, columns, duplicates) {
  if (!rowCount || !columns.length) return 0;
  const cellCount = rowCount * columns.length;
  const missing = columns.reduce(function (sum, column) { return sum + column.missing; }, 0);
  const missingPenalty = cellCount ? missing / cellCount * 55 : 0;
  const duplicatePenalty = rowCount ? duplicates / rowCount * 45 : 0;
  return Math.max(0, Math.round(100 - missingPenalty - duplicatePenalty));
}

function isDateLike(value) {
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(value)) return true;
  return value.length >= 8 && !Number.isFinite(Number(value)) && Number.isFinite(Date.parse(value));
}

function pearson(x, y) {
  const pairs = x.map(function (a, i) { return [a, y[i]]; }).filter(function (pair) { return Number.isFinite(pair[0]) && Number.isFinite(pair[1]); });
  if (pairs.length < 3) return NaN;
  const meanX = mean(pairs.map(function (pair) { return pair[0]; }));
  const meanY = mean(pairs.map(function (pair) { return pair[1]; }));
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  pairs.forEach(function (pair) {
    const dx = pair[0] - meanX;
    const dy = pair[1] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  });
  return varianceX && varianceY ? covariance / Math.sqrt(varianceX * varianceY) : NaN;
}
