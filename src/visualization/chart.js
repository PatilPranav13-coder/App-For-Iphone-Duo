import { aggregateRows, formatMoneyOrNumber, formatCount } from '../analysis/engine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#574ce3', '#27a984', '#ec9a4b', '#6aa8dc', '#e57697', '#9b81d8', '#61bba8', '#d3ab44'];

export function renderChart(container, rows, settings, onPoint) {
  container.replaceChildren();
  container.dataset.pointsShown = '0';
  container.dataset.pointsTotal = '0';
  if (!rows.length) return;
  const width = 760;
  const height = 294;
  const margin = { top: 16, right: 20, bottom: 48, left: 64 };
  const graphWidth = width - margin.left - margin.right;
  const graphHeight = height - margin.top - margin.bottom;
  const chartType = settings.type || 'line';
  const values = settings.x && settings.y ? aggregateRows(rows, settings.x, settings.y, 'sum') : [];
  let points = values.map(function (item) { return { xLabel: item.label, yValue: item.value, count: item.count }; });
  if (chartType === 'histogram') points = histogram(rows, settings.y);
  if (chartType === 'scatter') {
    const valid = rows.map(function (row, i) { return { xLabel: row[settings.x], yValue: chartNumber(row[settings.y]), count: 1, raw: row, i }; })
      .filter(function (item) { return Number.isFinite(item.yValue) && Number.isFinite(chartNumber(item.xLabel)); });
    points = decimate(valid, 600);
  }
  const totalPoints = points.length;
  const zoom = Math.max(1, Math.min(8, Number(settings.zoom) || 1));
  if (chartType !== 'donut' && zoom > 1 && points.length > 1) {
    const windowSize = Math.max(2, Math.ceil(points.length / zoom));
    const offset = Math.max(0, Math.min(1, Number(settings.offset) || 0));
    const start = Math.round(offset * (points.length - windowSize));
    points = points.slice(start, start + windowSize);
  }
  if (chartType === 'bar') points = points.slice(0, 40);
  if (chartType === 'donut' && points.length > 7) {
    const ordered = points.slice().sort(function (a, b) { return b.yValue - a.yValue; });
    const head = ordered.slice(0, 6);
    const rest = ordered.slice(6);
    points = head.concat([{ label: 'Other', xLabel: 'Other', yValue: rest.reduce(function (sum, item) { return sum + item.yValue; }, 0), count: rest.reduce(function (sum, item) { return sum + item.count; }, 0), otherBucket: true }]);
  }
  else if (chartType === 'line' || chartType === 'area') points = decimate(points, 800);
  container.dataset.pointsShown = String(points.length);
  container.dataset.pointsTotal = String(totalPoints);
  if (!points.length) {
    container.innerHTML = '<div class="chart-empty">Choose a numeric column and a grouping to build a chart.</div>';
    return;
  }
  const summary = chartSummary(chartType, points, settings);
  container.setAttribute('aria-label', summary);
  if (chartType === 'donut') return drawDonut(container, points, settings, onPoint);

  const svg = element('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'chart-svg', role: 'group', 'aria-label': summary });
  const allValues = points.map(function (item) { return item.yValue; });
  let minY = Math.min.apply(null, allValues);
  let maxY = Math.max.apply(null, allValues);
  if (chartType === 'histogram') minY = 0;
  const pad = (maxY - minY) * 0.14 || Math.abs(maxY) * 0.12 || 1;
  minY = chartType === 'histogram' ? 0 : Math.min(0, minY - pad);
  maxY += pad;
  const x = function (index) { return points.length > 1 ? margin.left + index * graphWidth / (points.length - 1) : margin.left + graphWidth / 2; };
  const y = function (value) { return margin.top + graphHeight - (value - minY) / ((maxY - minY) || 1) * graphHeight; };

  for (let line = 0; line <= 4; line += 1) {
    const value = minY + (maxY - minY) * (line / 4);
    const yPos = y(value);
    svg.append(element('line', { x1: margin.left, x2: width - margin.right, y1: yPos, y2: yPos, class: 'chart-grid-line' }));
    svg.append(textNode(margin.left - 10, yPos + 4, axisFormat(value, settings.y), 'chart-axis-y'));
  }
  const step = Math.max(1, Math.ceil(points.length / 7));
  points.forEach(function (point, index) {
    if (index % step === 0 || index === points.length - 1) {
      let label = String(point.xLabel);
      if (label.length > 15) label = label.slice(0, 13) + '…';
      svg.append(textNode(x(index), height - 15, label, 'chart-axis-x'));
    }
  });

  if (chartType === 'bar' || chartType === 'histogram') {
    const slot = graphWidth / points.length;
    const barWidth = Math.max(5, Math.min(42, slot * 0.58));
    points.forEach(function (point, index) {
      const top = y(point.yValue);
      const rect = element('rect', {
        x: x(index) - barWidth / 2, y: top, width: barWidth, height: Math.max(1, margin.top + graphHeight - top),
        rx: Math.min(5, barWidth / 3), class: 'chart-bar', tabindex: 0, role: 'button',
        'aria-label': point.xLabel + ', ' + point.yValue
      });
      attachPoint(rect, point, settings.y, onPoint, chartType, settings);
      svg.append(rect);
    });
  } else if (chartType === 'scatter') {
    points.forEach(function (point) {
      const dot = element('circle', { cx: x(points.indexOf(point)), cy: y(point.yValue), r: 4, class: 'chart-point', tabindex: 0, role: 'button', 'aria-label': String(point.xLabel) + ': ' + String(point.yValue) });
      attachPoint(dot, point, settings.y, onPoint, chartType, settings);
      svg.append(dot);
    });
  } else {
    const lineD = points.map(function (point, index) { return (index ? 'L' : 'M') + x(index) + ' ' + y(point.yValue); }).join(' ');
    if (chartType === 'area') {
      svg.append(element('path', { d: lineD + ' L ' + x(points.length - 1) + ' ' + (margin.top + graphHeight) + ' L ' + x(0) + ' ' + (margin.top + graphHeight) + ' Z', class: 'chart-area-fill' }));
    }
    svg.append(element('path', { d: lineD, class: 'chart-line' }));
    points.forEach(function (point, index) {
      const dot = element('circle', { cx: x(index), cy: y(point.yValue), r: 4.2, class: 'chart-point', tabindex: 0, role: 'button', 'aria-label': String(point.xLabel) + ': ' + String(point.yValue) });
      attachPoint(dot, point, settings.y, onPoint, chartType, settings);
      svg.append(dot);
    });
  }
  container.append(svg);
}

export function downloadChartSvg(container) {
  const svg = container.querySelector('svg');
  if (!svg) return false;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', '1520');
  clone.setAttribute('height', '588');
  const source = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'tessera-chart.svg';
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

function histogram(rows, column) {
  const values = rows.map(function (row) { return chartNumber(row[column]); }).filter(Number.isFinite);
  if (!values.length) return [];
  const bounds = values.reduce(function (result, value) {
    result.min = Math.min(result.min, value);
    result.max = Math.max(result.max, value);
    return result;
  }, { min: Infinity, max: -Infinity });
  const min = bounds.min;
  const max = bounds.max;
  if (min === max) {
    const label = formatMoneyOrNumber(min, column);
    return [{ label, xLabel: label, lower: min, upper: max, yValue: values.length, count: values.length }];
  }
  const bins = Math.min(10, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const step = (max - min) / bins || 1;
  const buckets = Array.from({ length: bins }, function (_, i) {
    const label = formatMoneyOrNumber(min + i * step, column);
    return { label, xLabel: label, lower: min + i * step, upper: i === bins - 1 ? max : min + (i + 1) * step, yValue: 0, count: 0 };
  });
  values.forEach(function (value) {
    const index = Math.min(bins - 1, Math.floor((value - min) / step));
    buckets[index].yValue += 1;
    buckets[index].count += 1;
  });
  return buckets;
}

function chartNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function decimate(points, limit) {
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, function (_, index) {
    return points[Math.round(index * (points.length - 1) / (limit - 1))];
  });
}

function drawDonut(container, points, settings, onPoint) {
  const top = points.slice().sort(function (a, b) { return b.yValue - a.yValue; }).slice(0, 7);
  const total = top.reduce(function (sum, item) { return sum + Math.max(0, item.yValue); }, 0);
  const svg = element('svg', { viewBox: '0 0 760 294', class: 'chart-svg donut-svg', role: 'group', 'aria-label': container.getAttribute('aria-label') || 'Donut chart' });
  let angle = -Math.PI / 2;
  const cx = 188;
  const cy = 147;
  const radius = 96;
  const inner = 58;
  top.forEach(function (point, index) {
    const fraction = total ? Math.max(0, point.yValue) / total : 0;
    const end = angle + fraction * Math.PI * 2;
    const large = fraction > 0.5 ? 1 : 0;
    const path = element('path', {
      d: arcPath(cx, cy, radius, inner, angle, end, large),
      fill: COLORS[index % COLORS.length],
      class: 'donut-slice', tabindex: 0, role: 'button'
    });
    attachPoint(path, point, '', onPoint, 'donut', settings);
    svg.append(path);
    const label = textNode(340, 61 + index * 31, point.label + '  ·  ' + Math.round(fraction * 100) + '%', 'donut-label');
    label.style.fill = COLORS[index % COLORS.length];
    svg.append(label);
    angle = end;
  });
  svg.append(textNode(cx, cy + 5, formatCount(points.length) + ' groups', 'donut-center'));
  container.append(svg);
}

function arcPath(cx, cy, outer, inner, start, end, large) {
  const point = function (radius, angle) { return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]; };
  const a = point(outer, start);
  const b = point(outer, end);
  const c = point(inner, end);
  const d = point(inner, start);
  return 'M ' + a[0] + ' ' + a[1] + ' A ' + outer + ' ' + outer + ' 0 ' + large + ' 1 ' + b[0] + ' ' + b[1] +
    ' L ' + c[0] + ' ' + c[1] + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + d[0] + ' ' + d[1] + ' Z';
}

function attachPoint(node, point, measure, onPoint, type, settings) {
  const value = type === 'histogram' ? formatCount(point.yValue) : formatMoneyOrNumber(point.yValue, measure);
  const title = element('title');
  title.textContent = type === 'histogram'
    ? point.xLabel + '–' + formatMoneyOrNumber(point.upper, measure) + ': ' + value + ' records'
    : point.xLabel + ': ' + value;
  node.append(title);
  const selected = type === 'scatter' && Number.isInteger(point.i)
    ? settings.selectedPoint?.rowIndex === point.i
    : type === 'histogram'
      ? settings.selectedPoint?.type === 'histogram' && settings.selectedPoint?.lower === point.lower && settings.selectedPoint?.upper === point.upper
      : settings.selectedPoint?.label === String(point.xLabel) && String(settings.selectedPoint?.value) === String(value);
  if (selected) node.classList.add('selected');
  node.setAttribute('aria-pressed', String(selected));
  const filter = type === 'histogram' || type === 'scatter' || (type === 'donut' && point.xLabel === 'Other')
    ? null
    : { column: settings.x, value: String(point.xLabel) };
  const selection = {
    label: type === 'histogram' ? String(point.xLabel) + '–' + formatMoneyOrNumber(point.upper, measure) : String(point.xLabel), value, count: point.count, type, filter,
    rowIndex: type === 'scatter' ? point.i : undefined,
    xValue: type === 'scatter' ? point.raw?.[settings.x] : undefined,
    yValue: type === 'scatter' ? point.yValue : undefined,
    lower: type === 'histogram' ? point.lower : undefined,
    upper: type === 'histogram' ? point.upper : undefined,
    otherBucket: Boolean(point.otherBucket)
  };
  node.addEventListener('click', function () { onPoint(selection); });
  node.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPoint(selection);
    }
  });
}

function chartSummary(type, points, settings) {
  if (!points.length) return 'No chart data is available.';
  const values = points.map(function (item) { return item.yValue; }).filter(Number.isFinite);
  const total = values.reduce(function (sum, value) { return sum + value; }, 0);
  return (type + ' chart of ' + settings.y + ' by ' + settings.x + '. ' + points.length + ' visible marks; aggregate value ' + formatMoneyOrNumber(total, settings.y) + '. Select a mark to inspect it.');
}

function axisFormat(value, column) {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'm';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(0) + 'k';
  return formatMoneyOrNumber(value, column);
}

function element(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs || {}).forEach(function (entry) { node.setAttribute(entry[0], String(entry[1])); });
  return node;
}

function textNode(x, y, value, className) {
  const node = element('text', { x, y, class: className, 'text-anchor': className === 'chart-axis-y' ? 'end' : 'middle' });
  node.textContent = String(value);
  return node;
}
