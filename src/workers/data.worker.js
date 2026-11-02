import { parseDatasetFile, profileDataset } from '../analysis/engine.js';
import { executeAnalysisTool } from '../analysis/tool-registry.js';

const datasetCache = new Map();

self.addEventListener('message', async function (event) {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'parse') {
      const parsed = await parseDatasetFile(payload.file);
      if (parsed.rows.length > 250000) throw new Error('This release can import up to 250,000 rows at a time.');
      const profile = profileDataset(parsed.rows, parsed.columns);
      self.postMessage({ id, result: { ...parsed, profile } });
      return;
    }
    if (type === 'profile') {
      self.postMessage({ id, result: profileDataset(payload.rows, payload.columns) });
      return;
    }
    if (type === 'cacheDataset') {
      datasetCache.set(payload.datasetId, { rows: payload.rows, columns: payload.columns, profile: payload.profile, datasetVersion: payload.datasetVersion });
      self.postMessage({ id, result: true });
      return;
    }
    if (type === 'clearCache') {
      datasetCache.clear();
      self.postMessage({ id, result: true });
      return;
    }
    if (type === 'tool') {
      const cached = datasetCache.get(payload.datasetId);
      if (!cached) throw new Error('The active dataset is not available in the analysis worker.');
      const activeFilters = normalizeFilters(payload.context?.activeFilters, cached.columns);
      const rows = activeFilters.length ? applyFilters(cached.rows, activeFilters) : cached.rows;
      const profile = activeFilters.length ? profileDataset(rows, cached.columns) : cached.profile;
      self.postMessage({ id, result: executeAnalysisTool(payload.name, payload.args, { ...payload.context, rows, columns: cached.columns, profile, datasetVersion: cached.datasetVersion }) });
      return;
    }
    throw new Error('Unknown data worker task.');
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Data processing failed.' });
  }
});

function normalizeFilters(filters, columns) {
  if (!Array.isArray(filters) || filters.length > 20) throw new Error('The active filter set is invalid.');
  return filters.map(function (filter) {
    if (!filter || filter.operator !== 'equals' || !columns.includes(filter.column) || typeof filter.value !== 'string' || filter.value.length > 200) {
      throw new Error('The analysis worker only accepts validated equality filters.');
    }
    return filter;
  });
}

function applyFilters(rows, filters) {
  return rows.filter(function (row) {
    return filters.every(function (filter) {
      const raw = row[filter.column];
      const value = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? '');
      return value === filter.value;
    });
  });
}
