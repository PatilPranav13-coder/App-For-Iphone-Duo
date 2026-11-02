import { parseDatasetFile, profileDataset } from '../analysis/engine.js';

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
    throw new Error('Unknown data worker task.');
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Data processing failed.' });
  }
});
