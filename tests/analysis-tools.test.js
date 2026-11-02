import test from 'node:test';
import assert from 'node:assert/strict';
import { profileDataset } from '../src/analysis/engine.js';
import { executeAnalysisTool, isAnalysisTool, validateAnalysisToolCall } from '../src/analysis/tool-registry.js';
import { createWorkspaceState, hydrateWorkspaceState, workspaceSnapshot } from '../src/workspace/state.js';

function context(rows, columns, options) {
  return { rows, columns, profile: profileDataset(rows, columns), datasetVersion: 3, ...options };
}

test('analysis tools return deterministic statistics and provenance', function () {
  const rows = [{ region: 'East', sales: 10 }, { region: 'West', sales: 20 }, { region: 'West', sales: 30 }];
  const result = executeAnalysisTool('calculate_statistics', { column: 'sales' }, context(rows, ['region', 'sales']));

  assert.deepEqual(result.result, { count: 3, mean: 20, median: 20, min: 10, max: 30, standardDeviation: Math.sqrt(200 / 3) });
  assert.deepEqual(result.provenance, { method: 'Arithmetic summary over present numeric values', rowsUsed: 3, columns: ['sales'], datasetVersion: 3 });
});

test('tool validation rejects unknown tools, extra fields, and unsupported operations', function () {
  assert.equal(isAnalysisTool('run_sql_analysis'), false);
  assert.match(validateAnalysisToolCall('aggregate_by', { groupColumn: 'region', valueColumn: 'sales', operation: 'median', limit: 5 }), /Invalid operation/);
  assert.match(validateAnalysisToolCall('calculate_statistics', { column: 'sales', sql: 'SELECT * FROM data' }), /do not match/);
  assert.throws(function () { executeAnalysisTool('execute_code', {}, context([], [])); }, /not available/);
});

test('filter_rows excludes missing numeric values and only returns samples after opt-in', function () {
  const rows = [{ value: 2, group: 'a' }, { value: null, group: 'b' }, { value: -1, group: 'c' }];
  const base = { column: 'value', operator: 'greater_than', value: '-2', limit: 5 };
  const privateResult = executeAnalysisTool('filter_rows', base, context(rows, ['value', 'group']));
  const optedInResult = executeAnalysisTool('filter_rows', base, context(rows, ['value', 'group'], { includeSamples: true }));

  assert.equal(privateResult.result.matchedCount, 2);
  assert.deepEqual(privateResult.result.sample, []);
  assert.equal(optedInResult.result.sample.length, 2);
});

test('constant-valued selected histogram bins include every matching record', function () {
  const rows = [{ group: 'a', value: 5 }, { group: 'b', value: 5 }, { group: 'c', value: null }];
  const result = executeAnalysisTool('get_selected_point', {}, context(rows, ['group', 'value'], {
    chart: { type: 'histogram', x: 'group', y: 'value' },
    selectedPoint: { type: 'histogram', label: '5–5', lower: 5, upper: 5 }
  }));

  assert.equal(result.result.count, 2);
  assert.equal(result.result.mean, 5);
  assert.equal(result.provenance.rowsUsed, 2);
});

test('chart inspection uses the same histogram bin count as the visible chart', function () {
  const rows = Array.from({ length: 16 }, function (_, index) { return { group: 'g' + index, value: index }; });
  const result = executeAnalysisTool('inspect_selected_chart', {}, context(rows, ['group', 'value'], {
    chart: { type: 'histogram', x: 'group', y: 'value' }
  }));

  assert.equal(result.result.points.length, 5);
  assert.equal(result.result.points.reduce(function (sum, point) { return sum + point.value; }, 0), 16);
});

test('workspace restoration clamps settings and snapshots project context', function () {
  const demo = { id: 'demo', rows: [], columns: [] };
  const state = createWorkspaceState(demo);
  hydrateWorkspaceState(state, {
    projectId: 'project-2',
    activeDatasetId: 'dataset-7',
    layout: 'focus',
    layoutPreference: 'auto',
    chart: { type: 'histogram', x: 'Month', y: 'Revenue', zoom: 100, offset: -2 },
    panelSizes: { navigation: 1000, inspector: 220 },
    activeFilters: [{ column: 'Region', operator: 'equals', value: 'West' }, { column: 'Region', operator: 'contains', value: 'e' }]
  });
  const snapshot = workspaceSnapshot(state);

  assert.equal(state.chart.zoom, 8);
  assert.equal(state.chart.offset, 0);
  assert.deepEqual(state.panelSizes, { navigation: 300, inspector: 280 });
  assert.deepEqual(state.activeFilters, [{ column: 'Region', operator: 'equals', value: 'West' }]);
  assert.equal(snapshot.projectId, 'project-2');
  assert.equal(snapshot.activeDatasetId, 'dataset-7');
  assert.equal(snapshot.schemaVersion, 2);
});
