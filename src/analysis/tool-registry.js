import { aggregateRows, getCorrelations, profileDataset } from './engine.js';

const stringField = { type: 'string', minLength: 1, maxLength: 120 };
const limitField = { type: 'integer', minimum: 1, maximum: 50 };
const schema = function (properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
};

const definitions = [
  { name: 'profile_dataset', description: 'Return the computed dataset profile and data quality indicators.', input: schema({}) },
  { name: 'list_columns', description: 'List dataset columns, detected types and missing-value counts.', input: schema({}) },
  {
    name: 'summarize_column', description: 'Calculate count, mean, median, minimum, maximum and standard deviation for a numeric column.',
    input: schema({ column: stringField })
  },
  { name: 'calculate_statistics', description: 'Calculate standard descriptive statistics for one numeric column.', input: schema({ column: stringField }) },
  { name: 'analyse_distribution', description: 'Calculate deterministic equal-width histogram bins for one numeric column.', input: schema({ column: stringField, bins: { type: 'integer', minimum: 3, maximum: 20 } }) },
  { name: 'analyse_trend', description: 'Group a numeric measure over time and calculate the observed trend and period changes.', input: schema({ timeColumn: stringField, valueColumn: stringField, operation: { type: 'string', enum: ['sum', 'average'] }, limit: limitField }) },
  { name: 'calculate_growth', description: 'Calculate period-to-period and first-to-last growth for a numeric measure over time.', input: schema({ timeColumn: stringField, valueColumn: stringField, operation: { type: 'string', enum: ['sum', 'average'] }, limit: limitField }) },
  {
    name: 'aggregate_by', description: 'Group rows by one column and calculate sum, average or record count for a second column.',
    input: schema({ groupColumn: stringField, valueColumn: stringField, operation: { type: 'string', enum: ['sum', 'average', 'count'] }, limit: limitField })
  },
  {
    name: 'compare_groups', description: 'Compare the latest two observed periods for each group using deterministic totals.',
    input: schema({ groupColumn: stringField, periodColumn: stringField, valueColumn: stringField, limit: limitField })
  },
  {
    name: 'filter_rows', description: 'Filter records with a supported comparison and return a match count; a sample is included only with user consent.',
    input: schema({ column: stringField, operator: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'one_of'] }, value: { type: 'string', maxLength: 200 }, limit: limitField })
  },
  { name: 'find_outliers', description: 'Find IQR outlier rows for a numeric column; flags do not imply an error.', input: schema({ column: stringField }) },
  { name: 'calculate_correlation', description: 'Calculate Pearson correlation for two numeric columns using pairwise complete rows.', input: schema({ xColumn: stringField, yColumn: stringField }) },
  { name: 'inspect_selected_chart', description: 'Return the active chart aggregation and selection context.', input: schema({}) },
  { name: 'get_selected_point', description: 'Inspect the data records that correspond to the currently selected chart point.', input: schema({}) },
  { name: 'get_data_quality_report', description: 'Return missing-value, duplicate-row, quality-score and outlier scan results.', input: schema({}) }
];

export const ANALYSIS_TOOL_SPECS = Object.freeze(definitions);

export function providerTools(provider) {
  if (provider === 'anthropic') return definitions.map(function (tool) {
    return { name: tool.name, description: tool.description, input_schema: tool.input };
  });
  return definitions.map(function (tool) {
    return { type: 'function', name: tool.name, description: tool.description, parameters: openAISchema(tool.input), strict: true };
  });
}

function openAISchema(input) {
  const properties = Object.fromEntries(Object.entries(input.properties).map(function (entry) {
    const field = { ...entry[1] };
    delete field.minLength;
    delete field.maxLength;
    delete field.minimum;
    delete field.maximum;
    return [entry[0], field];
  }));
  return { ...input, properties };
}

export function executeAnalysisTool(name, args, context) {
  const definition = definitions.find(function (tool) { return tool.name === name; });
  if (!definition) throw new Error('That analysis operation is not available.');
  validateArgs(definition, args);
  const rows = Array.isArray(context?.rows) ? context.rows : [];
  const columns = Array.isArray(context?.columns) ? context.columns : [];
  const profile = context?.profile || profileDataset(rows, columns);
  const provenance = function (method, usedRows, usedColumns) {
    return { method, rowsUsed: usedRows, columns: usedColumns || [], datasetVersion: context?.datasetVersion || null };
  };
  if (name === 'profile_dataset') return { result: profile, provenance: provenance('Full dataset profile', rows.length, columns) };
  if (name === 'list_columns') return { result: profile.columns, provenance: provenance('Detected column types and missing-value counts', rows.length, columns) };
  if (name === 'get_data_quality_report') {
    return {
      result: { rowCount: profile.rowCount, columnCount: profile.columnCount, missingCells: profile.missingCells, duplicateRows: profile.duplicateRows, qualityScore: profile.qualityScore, outliers: profile.columns.filter(function (column) { return column.outliers > 0; }).map(function (column) { return { column: column.name, count: column.outliers, method: '1.5× IQR' }; }) },
      provenance: provenance('Full dataset quality scan', rows.length, columns)
    };
  }
  if (name === 'summarize_column' || name === 'calculate_statistics') {
    const column = requireColumn(args.column, profile, 'number');
    const values = numericValues(rows, column.name);
    return { result: columnStatistics(values), provenance: provenance('Arithmetic summary over present numeric values', values.length, [column.name]) };
  }
  if (name === 'analyse_distribution') {
    const column = requireColumn(args.column, profile, 'number');
    const values = numericValues(rows, column.name);
    const bounds = values.reduce(function (result, value) {
      result.min = Math.min(result.min, value);
      result.max = Math.max(result.max, value);
      return result;
    }, { min: Infinity, max: -Infinity });
    const min = values.length ? bounds.min : null;
    const max = values.length ? bounds.max : null;
    if (values.length && min === max) {
      return { result: { count: values.length, bins: [{ lower: min, upper: max, count: values.length }] }, provenance: provenance('Equal-width histogram bins', values.length, [column.name]) };
    }
    const width = values.length ? ((max - min) / args.bins || 1) : 0;
    const bins = Array.from({ length: args.bins }, function (_, index) {
      return { lower: min === null ? null : min + index * width, upper: min === null ? null : (index === args.bins - 1 ? max : min + (index + 1) * width), count: 0 };
    });
    values.forEach(function (value) {
      const index = Math.min(args.bins - 1, Math.floor((value - min) / (width || 1)));
      bins[index].count += 1;
    });
    return { result: { count: values.length, bins }, provenance: provenance('Equal-width histogram bins', values.length, [column.name]) };
  }
  if (name === 'analyse_trend' || name === 'calculate_growth') {
    const time = requireColumn(args.timeColumn, profile);
    const measure = requireColumn(args.valueColumn, profile, 'number');
    const allPoints = aggregateOverTime(rows, time.name, measure.name, args.operation);
    if (!allPoints.length) throw new Error('No valid numeric values are available for this time series.');
    const firstPoint = allPoints[0];
    const lastPoint = allPoints[allPoints.length - 1];
    const first = firstPoint.value;
    const last = lastPoint.value;
    const recentPoints = allPoints.slice(-args.limit);
    const deltas = recentPoints.slice(1).map(function (point, index) {
      const previous = recentPoints[index];
      return { period: point.period, change: point.value - previous.value, changePct: previous.value ? (point.value - previous.value) / Math.abs(previous.value) : null };
    });
    const slope = linearSlope(allPoints.map(function (point, index) { return { x: index, y: point.value }; }));
    const result = name === 'calculate_growth'
      ? { periods: allPoints.length, firstPeriod: firstPoint.period, lastPeriod: lastPoint.period, firstValue: first, lastValue: last, totalChange: last - first, totalChangePct: first ? (last - first) / Math.abs(first) : null, recentPeriodChanges: deltas }
      : { periods: allPoints.length, direction: slope > 0 ? 'upward' : slope < 0 ? 'downward' : 'flat', linearSlopePerPeriod: slope, firstPeriod: firstPoint.period, lastPeriod: lastPoint.period, firstValue: first, lastValue: last, totalChangePct: first ? (last - first) / Math.abs(first) : null, recentPoints };
    return { result, provenance: provenance(args.operation + ' by ' + time.name + '; linear least-squares slope over ordered periods', rows.length, [time.name, measure.name]) };
  }
  if (name === 'aggregate_by') {
    const group = requireColumn(args.groupColumn, profile);
    const measure = requireColumn(args.valueColumn, profile, args.operation === 'count' ? null : 'number');
    const groups = aggregate(rows, group.name, measure.name, args.operation).slice(0, args.limit);
    return { result: groups, provenance: provenance(args.operation + ' grouped by ' + group.name, rows.length, [group.name, measure.name]) };
  }
  if (name === 'compare_groups') {
    const group = requireColumn(args.groupColumn, profile);
    const period = requireColumn(args.periodColumn, profile);
    const measure = requireColumn(args.valueColumn, profile, 'number');
    const result = comparePeriods(rows, group.name, period.name, measure.name, args.limit);
    return { result: result.items, periods: result.periods, provenance: provenance('Sum by group and latest two observed ' + period.name + ' values', rows.length, [group.name, period.name, measure.name]) };
  }
  if (name === 'filter_rows') {
    const column = requireColumn(args.column, profile);
    const matching = rows.filter(function (row) { return matches(row[column.name], args.operator, args.value); });
    const sample = context?.includeSamples === true ? matching.slice(0, Math.min(5, args.limit)).map(function (row) { return selectValues(row, columns, 20); }) : [];
    return { result: { matchedCount: matching.length, sample }, provenance: provenance('Whitelisted ' + args.operator + ' filter on ' + column.name, matching.length, [column.name]) };
  }
  if (name === 'find_outliers') {
    const column = requireColumn(args.column, profile, 'number');
    const values = rows.map(function (row, index) { return { value: numericValue(row[column.name]), rowIndex: index + 1, row }; }).filter(function (item) { return Number.isFinite(item.value); });
    const sorted = values.map(function (item) { return item.value; }).sort(function (a, b) { return a - b; });
    if (sorted.length < 4) return { result: { count: 0, bounds: null, sample: [] }, provenance: provenance('Tukey 1.5× IQR', sorted.length, [column.name]) };
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const spread = q3 - q1;
    const lower = q1 - 1.5 * spread;
    const upper = q3 + 1.5 * spread;
    const found = values.filter(function (item) { return item.value < lower || item.value > upper; });
    return { result: { count: found.length, bounds: { lower, upper }, sample: found.slice(0, 20).map(function (item) { return { rowIndex: item.rowIndex, value: item.value }; }) }, provenance: provenance('Tukey 1.5× IQR', sorted.length, [column.name]) };
  }
  if (name === 'calculate_correlation') {
    const x = requireColumn(args.xColumn, profile, 'number');
    const y = requireColumn(args.yColumn, profile, 'number');
    const pairs = getCorrelations(rows, [x.name, y.name]);
    const pair = pairs[0];
    const count = rows.filter(function (row) { return Number.isFinite(numericValue(row[x.name])) && Number.isFinite(numericValue(row[y.name])); }).length;
    return { result: { x: x.name, y: y.name, pearsonR: pair?.r ?? null, sampleSize: count, interpretation: 'Association only; this does not establish causation.' }, provenance: provenance('Pearson correlation on pairwise complete rows', count, [x.name, y.name]) };
  }
  if (name === 'inspect_selected_chart') {
    const chart = context?.chart || {};
    if (!chart.x || !chart.y) throw new Error('Choose chart columns before inspecting the chart.');
    const type = chart.type || 'line';
    let points;
    if (type === 'histogram') {
      const validCount = numericValues(rows, chart.y).length;
      const binCount = validCount ? Math.min(10, Math.max(5, Math.ceil(Math.sqrt(validCount)))) : 10;
      const distribution = executeAnalysisTool('analyse_distribution', { column: chart.y, bins: binCount }, { rows, columns, profile, datasetVersion: context?.datasetVersion });
      points = distribution.result.bins.map(function (bin) { return { label: String(bin.lower), value: bin.count, lower: bin.lower, upper: bin.upper }; });
    } else if (type === 'scatter') {
      requireColumn(chart.x, profile, 'number');
      points = rows.map(function (row, rowIndex) {
        const x = numericValue(row[chart.x]);
        const y = numericValue(row[chart.y]);
        return Number.isFinite(x) && Number.isFinite(y) ? { rowIndex, x, y } : null;
      }).filter(Boolean).slice(0, 50);
    } else {
      const allPoints = aggregateRows(rows, chart.x, chart.y, 'sum').map(function (item) { return { label: item.label, value: item.value, count: item.count }; });
      if (type === 'donut' && allPoints.length > 7) {
        const top = allPoints.slice().sort(function (a, b) { return b.value - a.value; });
        points = top.slice(0, 6).concat([{ label: 'Other', value: top.slice(6).reduce(function (sum, item) { return sum + item.value; }, 0), count: top.slice(6).reduce(function (sum, item) { return sum + item.count; }, 0) }]);
      } else {
        points = allPoints.slice(0, 50);
      }
    }
    return { result: { type, xColumn: chart.x, yColumn: chart.y, points, selectedPoint: context?.selectedPoint || null }, provenance: provenance(type === 'histogram' ? 'Equal-width bins over active numeric values' : type === 'scatter' ? 'Pairwise complete numeric chart points' : 'Chart aggregation from the active rows', rows.length, [chart.x, chart.y]) };
  }
  if (name === 'get_selected_point') {
    const point = context?.selectedPoint;
    const chart = context?.chart || {};
    if (!point || !chart.x || !chart.y) throw new Error('Select a point on a chart first.');
    if (point.type === 'scatter' && Number.isInteger(point.rowIndex) && rows[point.rowIndex]) {
      const row = rows[point.rowIndex];
      const sample = context?.includeSamples === true ? selectValues(row, columns, 20) : undefined;
      return { result: { rowIndex: point.rowIndex, x: numericValue(row[chart.x]), y: numericValue(row[chart.y]), ...(sample ? { sample } : {}) }, provenance: provenance('Selected scatter observation from active rows', 1, [chart.x, chart.y]) };
    }
    let matching;
    let method = 'Rows matching selected ' + chart.x + ' value';
    if (point.type === 'histogram' && Number.isFinite(point.lower) && Number.isFinite(point.upper)) {
      const valuesForBin = numericValues(rows, chart.y);
      const maxValue = valuesForBin.reduce(function (max, value) { return Math.max(max, value); }, -Infinity);
      const isLastBin = point.upper === maxValue;
      matching = rows.filter(function (row) {
        const value = numericValue(row[chart.y]);
        return Number.isFinite(value) && value >= point.lower && (isLastBin ? value <= point.upper : value < point.upper);
      });
      method = 'Selected histogram interval for ' + chart.y;
    } else if (point.type === 'donut' && point.otherBucket) {
      const topLabels = new Set(aggregateRows(rows, chart.x, chart.y, 'sum').sort(function (a, b) { return b.value - a.value; }).slice(0, 6).map(function (item) { return item.label; }));
      matching = rows.filter(function (row) {
        const raw = row[chart.x] instanceof Date ? row[chart.x].toISOString().slice(0, 10) : row[chart.x];
        return !topLabels.has(String(raw ?? 'Missing'));
      });
      method = 'Rows grouped into the chart’s Other category';
    } else {
      matching = rows.filter(function (row) { return String(row[chart.x] instanceof Date ? row[chart.x].toISOString().slice(0, 10) : row[chart.x]) === String(point.label); });
    }
    const values = numericValues(matching, chart.y);
    const sample = context?.includeSamples === true ? matching.slice(0, 5).map(function (row) { return selectValues(row, columns, 20); }) : [];
    return { result: { label: point.label, count: matching.length, ...columnStatistics(values), sample }, provenance: provenance(method, matching.length, [chart.x, chart.y]) };
  }
  throw new Error('That analysis operation could not be completed.');
}

export function validateAnalysisToolCall(name, args) {
  const definition = definitions.find(function (tool) { return tool.name === name; });
  if (!definition) return 'That analysis operation is not available.';
  try { validateArgs(definition, args); return null; } catch (error) { return error.message; }
}

export function isAnalysisTool(name) {
  return definitions.some(function (tool) { return tool.name === name; });
}

function validateArgs(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  const props = definition.input.properties;
  if (Object.keys(args).some(function (key) { return !Object.hasOwn(props, key); }) || definition.input.required.some(function (key) { return !Object.hasOwn(args, key); })) {
    throw new Error('Tool arguments do not match the approved operation schema.');
  }
  Object.entries(props).forEach(function (entry) {
    const value = args[entry[0]];
    const field = entry[1];
    if (field.type === 'string' && (typeof value !== 'string' || value.length > (field.maxLength || 1000) || (field.minLength && value.length < field.minLength))) throw new Error('Invalid ' + entry[0] + ' argument.');
    if (field.type === 'integer' && (!Number.isInteger(value) || value < field.minimum || value > field.maximum)) throw new Error('Invalid ' + entry[0] + ' argument.');
    if (field.enum && !field.enum.includes(value)) throw new Error('Invalid ' + entry[0] + ' argument.');
  });
}

function requireColumn(name, profile, type) {
  const column = profile.columns.find(function (item) { return item.name === name; });
  if (!column) throw new Error('Column “' + name + '” is not in the active dataset.');
  if (type && column.type !== type) throw new Error('Column “' + name + '” must be detected as ' + type + '.');
  return column;
}

function numericValue(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return typeof value === 'number' ? (Number.isFinite(value) ? value : NaN) : NaN;
}

function numericValues(rows, column) { return rows.map(function (row) { return numericValue(row[column]); }).filter(Number.isFinite); }

function columnStatistics(values) {
  if (!values.length) return { count: 0, mean: null, median: null, min: null, max: null, standardDeviation: null };
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mean = values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
  const variance = values.reduce(function (sum, value) { return sum + Math.pow(value - mean, 2); }, 0) / values.length;
  return { count: values.length, mean, median: quantile(sorted, 0.5), min: sorted[0], max: sorted[sorted.length - 1], standardDeviation: Math.sqrt(variance) };
}

function aggregate(rows, groupColumn, valueColumn, operation) {
  const groups = new Map();
  rows.forEach(function (row) {
    const raw = row[groupColumn];
    const label = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? 'Missing');
    const item = groups.get(label) || { label, value: 0, count: 0 };
    if (operation === 'count') { item.value += 1; item.count += 1; }
    else {
      const number = numericValue(row[valueColumn]);
      if (Number.isFinite(number)) { item.value += number; item.count += 1; }
    }
    groups.set(label, item);
  });
  const output = Array.from(groups.values());
  if (operation === 'average') output.forEach(function (item) { item.value = item.count ? item.value / item.count : 0; });
  return output.sort(function (a, b) { return b.value - a.value; });
}

function aggregateOverTime(rows, timeColumn, valueColumn, operation) {
  const groups = new Map();
  rows.forEach(function (row) {
    const raw = row[timeColumn];
    if (raw === null || raw === undefined || raw === '') return;
    const period = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw);
    const value = numericValue(row[valueColumn]);
    if (!Number.isFinite(value)) return;
    const item = groups.get(period) || { period, value: 0, count: 0 };
    item.value += value;
    item.count += 1;
    groups.set(period, item);
  });
  const output = Array.from(groups.values());
  if (operation === 'average') output.forEach(function (item) { item.value /= item.count; });
  sortPeriods(output, function (item) { return item.period; });
  return output;
}

function linearSlope(points) {
  if (points.length < 2) return 0;
  const meanX = points.reduce(function (sum, point) { return sum + point.x; }, 0) / points.length;
  const meanY = points.reduce(function (sum, point) { return sum + point.y; }, 0) / points.length;
  const numerator = points.reduce(function (sum, point) { return sum + (point.x - meanX) * (point.y - meanY); }, 0);
  const denominator = points.reduce(function (sum, point) { return sum + Math.pow(point.x - meanX, 2); }, 0);
  return denominator ? numerator / denominator : 0;
}

function comparePeriods(rows, groupColumn, periodColumn, valueColumn, limit) {
  const periods = Array.from(new Set(rows.map(function (row) { return String(row[periodColumn] ?? ''); }).filter(Boolean)));
  sortPeriods(periods, function (value) { return value; });
  if (periods.length < 2) throw new Error('At least two distinct values are needed in “' + periodColumn + '”.');
  const previous = periods[periods.length - 2];
  const current = periods[periods.length - 1];
  const groupValues = new Map();
  rows.forEach(function (row) {
    const period = String(row[periodColumn] ?? '');
    if (period !== previous && period !== current) return;
    const key = String(row[groupColumn] ?? 'Missing');
    const value = numericValue(row[valueColumn]);
    if (!Number.isFinite(value)) return;
    const item = groupValues.get(key) || { group: key, previous: 0, current: 0 };
    item[period === previous ? 'previous' : 'current'] += value;
    groupValues.set(key, item);
  });
  const items = Array.from(groupValues.values()).map(function (item) {
    return { ...item, change: item.current - item.previous, changePct: item.previous ? (item.current - item.previous) / Math.abs(item.previous) : null };
  }).sort(function (a, b) { return a.change - b.change; }).slice(0, limit);
  return { periods: { previous, current }, items };
}

function matches(actual, operator, expected) {
  const a = actual === null || actual === undefined ? '' : String(actual);
  if (operator === 'equals') return a.toLowerCase() === expected.toLowerCase();
  if (operator === 'not_equals') return a.toLowerCase() !== expected.toLowerCase();
  if (operator === 'contains') return a.toLowerCase().includes(expected.toLowerCase());
  if (operator === 'one_of') return expected.split(',').map(function (part) { return part.trim().toLowerCase(); }).includes(a.toLowerCase());
  if (actual === null || actual === undefined || actual === '') return false;
  const numeric = Number(actual);
  const target = Number(expected);
  if (!Number.isFinite(numeric) || !Number.isFinite(target)) return false;
  return operator === 'greater_than' ? numeric > target : numeric < target;
}

function selectValues(row, columns, limit) {
  return Object.fromEntries(columns.slice(0, limit).map(function (column) {
    const value = row[column] instanceof Date ? row[column].toISOString() : (row[column] ?? null);
    return [column, typeof value === 'string' ? value.slice(0, 160) : value];
  }));
}

function sortPeriods(values, getValue) {
  const periods = values.map(getValue);
  if (periods.every(function (value) { return /^-?\d+(\.\d+)?$/.test(String(value)); })) {
    values.sort(function (a, b) { return Number(getValue(a)) - Number(getValue(b)); });
  } else if (periods.every(function (value) { return Number.isFinite(Date.parse(value)); })) {
    values.sort(function (a, b) { return Date.parse(getValue(a)) - Date.parse(getValue(b)); });
  } else {
    values.sort(function (a, b) { return String(getValue(a)).localeCompare(String(getValue(b))); });
  }
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
