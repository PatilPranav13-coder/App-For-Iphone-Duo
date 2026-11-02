import test from 'node:test';
import assert from 'node:assert/strict';
import { answerLocally, makeFindings, parseTextTable, profileDataset } from '../src/analysis/engine.js';

test('CSV parser respects quoted delimiters, embedded lines and numeric values', function () {
  const parsed = parseTextTable('city,amount,note\r\n"New York",25,"first, then second"\r\nOslo,,plain');
  assert.deepEqual(parsed.columns, ['city', 'amount', 'note']);
  assert.equal(parsed.rows[0].city, 'New York');
  assert.equal(parsed.rows[0].amount, 25);
  assert.equal(parsed.rows[0].note, 'first, then second');
  assert.equal(parsed.rows[1].amount, null);
});

test('profile identifies types, missing values, duplicates and outliers', function () {
  const rows = [
    { label: 'A', value: 10, day: '2025-01-01' },
    { label: 'A', value: 11, day: '2025-02-01' },
    { label: 'B', value: 12, day: '2025-03-01' },
    { label: 'B', value: 13, day: '2025-04-01' },
    { label: 'C', value: 14, day: '2025-05-01' },
    { label: 'D', value: 100, day: '2025-06-01' },
    { label: 'D', value: null, day: null },
    { label: 'D', value: null, day: null }
  ];
  const profile = profileDataset(rows, ['label', 'value', 'day']);
  assert.equal(profile.rowCount, 8);
  assert.equal(profile.columns.find(function (column) { return column.name === 'value'; }).type, 'number');
  assert.equal(profile.columns.find(function (column) { return column.name === 'day'; }).type, 'date');
  assert.equal(profile.missingCells, 4);
  assert.equal(profile.duplicateRows, 1);
  assert.equal(profile.columns.find(function (column) { return column.name === 'value'; }).outliers, 1);
});

test('local analyst returns figures derived from the dataset', function () {
  const rows = [
    { region: 'East', sales: 7 },
    { region: 'West', sales: 10 },
    { region: 'West', sales: 12 },
    { region: 'East', sales: 9 }
  ];
  const profile = profileDataset(rows, ['region', 'sales']);
  const answer = answerLocally('Which has the highest sales?', rows, profile);
  assert.match(answer.text, /West/);
  assert.match(answer.text, /22/);
  assert.equal(answer.references[0].value, 'region');
});

test('local quality answers cite actual scan results', function () {
  const rows = [{ x: 1, group: 'a' }, { x: 1, group: 'a' }, { x: null, group: 'b' }];
  const profile = profileDataset(rows, ['x', 'group']);
  const answer = answerLocally('Find missing values and duplicates', rows, profile);
  assert.match(answer.text, /1 missing cells/);
  assert.match(answer.text, /1 duplicate rows/);
  assert.ok(makeFindings(rows, profile).some(function (finding) { return finding.kind === 'quality'; }));
});

test('selected chart questions calculate values from the matching source records', function () {
  const rows = [{ month: '2025-01', sales: 10 }, { month: '2025-01', sales: 15 }, { month: '2025-02', sales: 8 }];
  const profile = profileDataset(rows, ['month', 'sales']);
  const answer = answerLocally('What happened at the selected point?', rows, profile, { label: '2025-01' }, { x: 'month', y: 'sales' });
  assert.match(answer.text, /2 valid sales values/);
  assert.match(answer.text, /25/);
});
