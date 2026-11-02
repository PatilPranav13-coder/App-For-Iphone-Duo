import {
  DEMO_DATASET, answerLocally, formatCount, formatMoneyOrNumber,
  makeFindings, parseDatasetFile, profileDataset, summarizeForProvider
} from './analysis/engine.js';
import { listDatasets, saveDataset, readWorkspace, saveWorkspace, removeDataset, clearLocalData } from './storage/database.js';
import { renderChart, downloadChartSvg } from './visualization/chart.js';
import { initFoldableLayout } from './foldable/posture.js';
import { createNotebookCanvas } from './notebook/canvas.js';

const byId = function (id) { return document.getElementById(id); };
const state = {
  activeView: 'overview',
  activeDatasetId: DEMO_DATASET.id,
  datasets: [DEMO_DATASET],
  projects: [{ id: 'default', name: 'Q3 revenue review' }, { id: 'retention', name: 'Customer retention' }, { id: 'research', name: 'Product research' }],
  activeProjectId: 'default',
  chart: { type: 'line', x: 'Month', y: 'Revenue' },
  selectedPoint: null,
  conversation: [],
  notes: '',
  strokes: [],
  provider: 'auto',
  includeSamples: false,
  theme: 'light',
  layout: 'studio',
  tableSearch: '',
  tableSort: null,
  aiStatus: null
};

let persistTimer;
let drawing;
let dataWorker;
let workerSequence = 0;
const workerJobs = new Map();

const activeDataset = function () {
  return state.datasets.find(function (dataset) { return dataset.id === state.activeDatasetId; }) || state.datasets[0] || DEMO_DATASET;
};
const activeRows = function () { return activeDataset().rows || []; };
const currentProfile = function () {
  const dataset = activeDataset();
  return dataset.profile || profileDataset(activeRows(), dataset.columns);
};
const currentFindings = function () { return makeFindings(activeRows(), currentProfile()); };

async function initialize() {
  try {
    const results = await Promise.all([readWorkspace(), listDatasets()]);
    const savedWorkspace = results[0];
    if (savedWorkspace) {
      Object.assign(state, {
        activeView: savedWorkspace.activeView || 'overview',
        activeDatasetId: savedWorkspace.activeDatasetId || DEMO_DATASET.id,
        projects: savedWorkspace.projects?.length ? savedWorkspace.projects : state.projects,
        activeProjectId: savedWorkspace.activeProjectId || 'default',
        chart: { ...state.chart, ...(savedWorkspace.chart || {}) },
        selectedPoint: savedWorkspace.selectedPoint || null,
        conversation: Array.isArray(savedWorkspace.conversation) ? savedWorkspace.conversation.slice(-8) : [],
        notes: savedWorkspace.notes || '',
        strokes: Array.isArray(savedWorkspace.strokes) ? savedWorkspace.strokes : [],
        provider: ['auto', 'openai', 'anthropic'].includes(savedWorkspace.provider) ? savedWorkspace.provider : 'auto',
        includeSamples: Boolean(savedWorkspace.includeSamples),
        theme: savedWorkspace.theme === 'dark' ? 'dark' : 'light',
        layout: savedWorkspace.layout || state.layout
      });
    }
    if (results[1]?.length) state.datasets = [DEMO_DATASET].concat(results[1]);
    if (!state.datasets.some(function (dataset) { return dataset.id === state.activeDatasetId; })) state.activeDatasetId = state.datasets[0].id;
    await Promise.all(state.datasets.map(ensureDatasetProfile));
  } catch (error) {
    toast('Local storage could not be opened. The workspace will work for this session only.');
    console.error('Storage initialization failed:', error);
  }
  bindEvents();
  byId('note-input').value = state.notes;
  byId('provider-select').value = state.provider;
  byId('sample-consent').checked = state.includeSamples;
  document.body.dataset.theme = state.theme;
  drawing = createNotebookCanvas(byId('drawing-canvas'), state.strokes, function (strokes) {
    state.strokes = strokes;
    scheduleSave();
  });
  renderAll();
  initFoldableLayout(setLayout);
  checkProviderStatus();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(function () {});
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') persistNow(); });
  window.addEventListener('pagehide', persistNow);
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach(function (button) { button.addEventListener('click', function () { setView(button.dataset.view); }); });
  byId('add-data-button').addEventListener('click', function () { byId('file-input').click(); });
  byId('file-input').addEventListener('change', function (event) { importFiles(Array.from(event.target.files || [])); event.target.value = ''; });
  byId('ask-form').addEventListener('submit', onAsk);
  byId('question-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); byId('ask-form').requestSubmit(); }
  });
  byId('chart-type').addEventListener('change', function () { state.chart.type = byId('chart-type').value; updateChart(); scheduleSave(); });
  byId('x-column').addEventListener('change', function () { state.chart.x = byId('x-column').value; state.selectedPoint = null; updateChart(); scheduleSave(); });
  byId('y-column').addEventListener('change', function () { state.chart.y = byId('y-column').value; state.selectedPoint = null; updateChart(); scheduleSave(); });
  byId('table-search').addEventListener('input', function () { state.tableSearch = byId('table-search').value; renderTable(); });
  byId('download-csv').addEventListener('click', exportCsv);
  byId('chart-download').addEventListener('click', function () { if (!downloadChartSvg(byId('chart-container'))) toast('Choose chart columns first.'); });
  byId('chart-menu').addEventListener('click', exportCsv);
  byId('dataset-menu').addEventListener('click', datasetMenu);
  byId('show-all-data').addEventListener('click', function () { setView('data'); });
  byId('export-button').addEventListener('click', function () { setView('reports'); });
  byId('report-html').addEventListener('click', exportReport);
  byId('report-json').addEventListener('click', exportSnapshot);
  byId('theme-toggle').addEventListener('click', toggleTheme);
  byId('open-settings').addEventListener('click', openSettings);
  byId('provider-shortcut').addEventListener('click', openSettings);
  byId('provider-select').addEventListener('change', function () { state.provider = byId('provider-select').value; scheduleSave(); updateProviderCaption(); });
  byId('sample-consent').addEventListener('change', function () { state.includeSamples = byId('sample-consent').checked; scheduleSave(); updateProviderCaption(); });
  byId('clear-workspace').addEventListener('click', clearWorkspace);
  byId('search-open').addEventListener('click', openSearch);
  byId('global-search').addEventListener('input', renderSearch);
  byId('search-dialog').addEventListener('click', function (event) { if (event.target === byId('search-dialog')) byId('search-dialog').close(); });
  byId('mobile-menu').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  document.querySelectorAll('.sidebar .nav-item').forEach(function (button) { button.addEventListener('click', function () { document.body.classList.remove('nav-open'); }); });
  byId('new-project').addEventListener('click', createProject);
  byId('project-switcher').addEventListener('click', cycleProject);
  byId('profile-button').addEventListener('click', openSettings);
  byId('share-button').addEventListener('click', shareSummary);
  document.querySelectorAll('.tool-button[data-pen]').forEach(function (button) {
    button.addEventListener('click', function () {
      drawing.setTool(button.dataset.pen);
      document.querySelectorAll('.tool-button[data-pen]').forEach(function (item) { item.classList.toggle('active', item === button); });
    });
  });
  byId('clear-canvas').addEventListener('click', function () { drawing.clear(); toast('Sketch cleared.'); });
  byId('note-input').addEventListener('input', function () { state.notes = byId('note-input').value; scheduleSave(); });
  byId('suggestion-list').addEventListener('click', function (event) {
    const button = event.target.closest('.suggestion-chip');
    if (button) { byId('question-input').value = button.textContent; byId('ask-form').requestSubmit(); }
  });
  byId('finding-list').addEventListener('click', function (event) {
    const card = event.target.closest('.finding-card');
    if (card) { byId('question-input').value = 'Explain this finding: ' + card.dataset.question; byId('question-input').focus(); }
  });
  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u') { event.preventDefault(); byId('file-input').click(); }
    if (event.key === 'Escape') document.body.classList.remove('nav-open');
  });
  document.addEventListener('dragover', function (event) { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', function (event) {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) { event.preventDefault(); importFiles(files); }
  });
}

function renderAll() {
  renderProjectNav();
  renderDatasetChrome();
  renderMetrics();
  renderChartControls();
  updateChart();
  renderFindings();
  renderConversation();
  renderTable();
  setView(state.activeView, false);
  document.querySelectorAll('[data-layout]').forEach(function (button) { button.classList.toggle('active', button.dataset.layout === state.layout); });
  updateProviderCaption();
}

function renderProjectNav() {
  const label = state.projects.find(function (project) { return project.id === state.activeProjectId; })?.name || 'Q3 revenue review';
  document.querySelector('.breadcrumbs strong').textContent = label;
  document.querySelectorAll('.project-link').forEach(function (item) { item.remove(); });
  const labelNode = Array.from(document.querySelectorAll('.nav-label')).find(function (node) { return node.textContent.includes('PROJECTS'); });
  const colors = ['dot-violet', 'dot-blue', 'dot-amber'];
  let previous = labelNode;
  state.projects.forEach(function (project, index) {
    const button = document.createElement('button');
    button.className = 'project-link' + (project.id === state.activeProjectId ? ' active' : '');
    button.type = 'button';
    const dot = document.createElement('span');
    dot.className = 'project-dot ' + colors[index % colors.length];
    const title = document.createElement('span');
    title.textContent = project.name;
    button.append(dot, title);
    button.addEventListener('click', function () { state.activeProjectId = project.id; renderProjectNav(); scheduleSave(); });
    previous.after(button);
    previous = button;
  });
}

function renderDatasetChrome() {
  const dataset = activeDataset();
  byId('dataset-title').textContent = dataset.name;
  byId('table-source').textContent = dataset.source || 'LOCAL';
  byId('demo-tag').classList.toggle('hidden', dataset.id !== DEMO_DATASET.id);
  byId('dataset-count').textContent = state.datasets.filter(function (item) { return item.id !== DEMO_DATASET.id; }).length + (dataset.id === DEMO_DATASET.id ? 1 : 0);
}

function renderMetrics() {
  const profile = currentProfile();
  const numericColumn = profile.columns.find(function (column) { return column.type === 'number'; });
  const total = numericColumn ? activeRows().reduce(function (sum, row) { const value = Number(row[numericColumn.name]); return Number.isFinite(value) ? sum + value : sum; }, 0) : null;
  const outliers = profile.columns.reduce(function (sum, column) { return sum + column.outliers; }, 0);
  const cards = [
    { label: numericColumn ? 'Total ' + numericColumn.name : 'Dataset size', value: numericColumn ? formatMoneyOrNumber(total, numericColumn.name) : formatCount(profile.rowCount), caption: numericColumn ? 'Calculated from all valid values' : profile.columnCount + ' columns in this file', symbol: '↗' },
    { label: 'Records', value: formatCount(profile.rowCount), caption: 'Rows in the active dataset', symbol: '▤' },
    { label: 'Data quality', value: profile.qualityScore + '/100', caption: profile.missingCells ? formatCount(profile.missingCells) + ' missing cells' : 'No missing values detected', symbol: '◇', tone: profile.qualityScore < 80 ? 'warning' : 'positive' },
    { label: 'Potential outliers', value: formatCount(outliers), caption: '1.5× interquartile range rule', symbol: '⌁', tone: outliers ? 'warning' : 'positive' }
  ];
  byId('metric-grid').replaceChildren(...cards.map(function (card) {
    const article = document.createElement('article');
    article.className = 'metric-card';
    article.innerHTML = '<div class="metric-head"><span></span><span class="metric-mark"></span></div><div class="metric-value"></div><div class="metric-caption"></div>';
    article.querySelector('.metric-head > span:first-child').textContent = card.label;
    article.querySelector('.metric-mark').textContent = card.symbol;
    article.querySelector('.metric-value').textContent = card.value;
    article.querySelector('.metric-caption').textContent = card.caption;
    if (card.tone) article.querySelector('.metric-caption').classList.add(card.tone);
    return article;
  }));
}

function renderChartControls() {
  const profile = currentProfile();
  const all = profile.columns.map(function (column) { return column.name; });
  const numeric = profile.numericColumns;
  const primary = profile.categoryColumns;
  const xOptions = primary.concat(all.filter(function (column) { return !primary.includes(column); }));
  if (!xOptions.includes(state.chart.x)) state.chart.x = xOptions[0] || all[0] || '';
  if (!numeric.includes(state.chart.y)) state.chart.y = numeric[0] || '';
  byId('x-column').replaceChildren(...xOptions.map(makeOption));
  byId('y-column').replaceChildren(...numeric.map(makeOption));
  byId('x-column').value = state.chart.x;
  byId('y-column').value = state.chart.y;
  byId('y-column').disabled = !numeric.length;
  byId('chart-type').value = state.chart.type;
  byId('chart-title').textContent = state.chart.y ? state.chart.y + (state.chart.type === 'donut' ? ' by ' + state.chart.x : ' trend') : 'Choose a numeric measure';
}

function makeOption(value) { const option = document.createElement('option'); option.value = value; option.textContent = value; return option; }

function updateChart() {
  const dataset = activeDataset();
  if (!dataset.rows?.length || !state.chart.y) {
    byId('chart-container').innerHTML = '<div class="chart-empty">Add a dataset with at least one numeric column to chart your data.</div>';
    return;
  }
  renderChart(byId('chart-container'), dataset.rows, state.chart, function (point) {
    state.selectedPoint = point;
    byId('question-input').placeholder = 'Ask about ' + point.label + '…';
    toast(point.label + ' selected · ask a follow-up about this point.');
    scheduleSave();
  });
  byId('chart-legend').innerHTML = '<span class="legend-item"><i class="legend-dot"></i>' + escapeHtml(state.chart.y) + '</span><span class="chart-note">Select a value to follow up with context</span>';
}

function renderFindings() {
  byId('finding-list').replaceChildren(...currentFindings().map(function (finding) {
    const card = document.createElement('article');
    card.className = 'finding-card';
    card.dataset.kind = finding.kind;
    card.dataset.question = finding.title;
    card.innerHTML = '<b></b><p></p><small></small>';
    card.querySelector('b').textContent = finding.title;
    card.querySelector('p').textContent = finding.detail;
    card.querySelector('small').textContent = finding.evidence;
    return card;
  }));
  const prompts = ['Summarise this dataset', state.chart.y ? 'What is driving ' + state.chart.y + '?' : 'What should I explore first?', 'Find potential outliers'];
  byId('suggestion-list').replaceChildren(...prompts.map(function (prompt) {
    const chip = document.createElement('button');
    chip.className = 'suggestion-chip';
    chip.type = 'button';
    chip.textContent = prompt;
    return chip;
  }));
}

function renderConversation() {
  const feed = byId('conversation');
  feed.replaceChildren();
  state.conversation.slice(-8).forEach(function (message) {
    const item = document.createElement('div');
    item.className = 'chat-message ' + (message.role === 'user' ? 'user' : 'assistant');
    item.textContent = message.content;
    if (message.provider) {
      const label = document.createElement('small');
      const references = message.references?.length
        ? ' · ' + message.references.map(function (item) { return item.label + ': ' + item.value; }).join(' · ')
        : '';
      label.textContent = message.provider + (message.model ? ' · ' + message.model : '') + references;
      item.append(label);
    }
    feed.append(item);
  });
  const scroll = byId('analyst-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function renderTable() {
  const rows = filteredRows();
  const columns = activeDataset().columns || currentProfile().columns.map(function (column) { return column.name; });
  const head = byId('data-table').querySelector('thead');
  const body = byId('data-table').querySelector('tbody');
  head.replaceChildren();
  body.replaceChildren();
  const headerRow = document.createElement('tr');
  columns.forEach(function (column) {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = column + (state.tableSort?.key === column ? (state.tableSort.direction === 'asc' ? ' ↑' : ' ↓') : '');
    button.addEventListener('click', function () {
      state.tableSort = { key: column, direction: state.tableSort?.key === column && state.tableSort.direction === 'asc' ? 'desc' : 'asc' };
      renderTable();
    });
    th.append(button);
    headerRow.append(th);
  });
  head.append(headerRow);
  const display = rows.slice(0, 8);
  display.forEach(function (row) {
    const tr = document.createElement('tr');
    columns.forEach(function (column) {
      const td = document.createElement('td');
      const value = row[column];
      td.textContent = value === null || value === undefined ? '—' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
      if (typeof value === 'number') td.className = 'numeric';
      tr.append(td);
    });
    body.append(tr);
  });
  const profile = currentProfile();
  const pill = document.createElement('span');
  pill.className = 'quality-pill' + (profile.qualityScore < 80 ? ' warning' : '');
  pill.textContent = '◇ Data quality ' + profile.qualityScore + '/100';
  const meta = document.createElement('span');
  meta.textContent = formatCount(profile.rowCount) + ' rows · ' + profile.columnCount + ' columns · ' + profile.duplicateRows + ' duplicate rows';
  byId('table-meta').replaceChildren(pill, meta);
  byId('table-count').textContent = 'Showing ' + formatCount(display.length) + ' of ' + formatCount(rows.length) + ' matching records';
}

function filteredRows() {
  const needle = state.tableSearch.trim().toLowerCase();
  let rows = activeRows();
  if (needle) rows = rows.filter(function (row) { return Object.values(row).some(function (value) { return String(value ?? '').toLowerCase().includes(needle); }); });
  if (state.tableSort) {
    const sort = state.tableSort;
    rows = rows.slice().sort(function (a, b) {
      const x = a[sort.key] ?? '';
      const y = b[sort.key] ?? '';
      const compare = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.direction === 'asc' ? compare : -compare;
    });
  }
  return rows;
}

async function importFiles(files) {
  for (const file of files) {
    try {
      const parsed = await runDataWorker('parse', { file });
      const dataset = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ''),
        source: 'LOCAL',
        createdAt: new Date().toISOString(),
        fileName: file.name,
        rows: parsed.rows,
        columns: parsed.columns,
        profile: parsed.profile
      };
      state.datasets.push(dataset);
      state.activeDatasetId = dataset.id;
      state.selectedPoint = null;
      state.conversation = [];
      await saveDataset(dataset);
      toast(file.name + ' is ready · ' + formatCount(parsed.rows.length) + ' rows profiled locally.');
    } catch (error) {
      toast(file.name + ': ' + error.message);
    }
  }
  renderAll();
  scheduleSave();
}

async function ensureDatasetProfile(dataset) {
  if (dataset.profile) return dataset.profile;
  const profile = await runDataWorker('profile', { rows: dataset.rows || [], columns: dataset.columns || [] });
  dataset.profile = profile;
  if (dataset.id !== DEMO_DATASET.id) await saveDataset(dataset).catch(function () {});
  return profile;
}

function runDataWorker(type, payload) {
  if (!('Worker' in window)) return fallbackWorker(type, payload);
  try {
    if (!dataWorker) {
      dataWorker = new Worker(new URL('./workers/data.worker.js', import.meta.url), { type: 'module' });
      dataWorker.addEventListener('message', function (event) {
        const job = workerJobs.get(event.data.id);
        if (!job) return;
        workerJobs.delete(event.data.id);
        if (event.data.error) job.reject(new Error(event.data.error));
        else job.resolve(event.data.result);
      });
      dataWorker.addEventListener('error', function (event) {
        workerJobs.forEach(function (job) { job.reject(new Error(event.message || 'Data worker failed.')); });
        workerJobs.clear();
        dataWorker.terminate();
        dataWorker = null;
      });
    }
    const id = ++workerSequence;
    return new Promise(function (resolve, reject) {
      workerJobs.set(id, { resolve, reject });
      dataWorker.postMessage({ id, type, payload });
    });
  } catch (error) {
    return fallbackWorker(type, payload).catch(function () { throw error; });
  }
}

async function fallbackWorker(type, payload) {
  if (type === 'parse') {
    const parsed = await parseDatasetFile(payload.file);
    return { ...parsed, profile: profileDataset(parsed.rows, parsed.columns) };
  }
  return profileDataset(payload.rows, payload.columns);
}

async function onAsk(event) {
  event.preventDefault();
  const question = byId('question-input').value.trim();
  if (!question) return;
  const rows = activeRows();
  if (!rows.length) return toast('Add a dataset before asking a question.');
  state.conversation.push({ role: 'user', content: question, at: new Date().toISOString() });
  byId('question-input').value = '';
  renderConversation();
  const button = byId('send-question');
  button.disabled = true;
  button.textContent = '…';
  try {
    const profile = currentProfile();
    const localAnswer = answerLocally(question, rows, profile, state.selectedPoint, state.chart);
    if (localAnswer) {
      state.conversation.push({ role: 'assistant', content: localAnswer.text, provider: 'Local calculation', references: localAnswer.references, at: new Date().toISOString() });
    } else {
      const context = {
        ...summarizeForProvider(rows, profile, currentFindings(), state.includeSamples),
        chart: { ...state.chart },
        selectedPoint: state.selectedPoint
      };
      const history = state.conversation.slice(-8, -1).map(function (message) { return { role: message.role, content: message.content }; });
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, provider: state.provider, context, history, includeSamples: state.includeSamples })
      });
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || 'The AI provider could not answer this question.');
      state.conversation.push({ role: 'assistant', content: payload.text, provider: payload.provider, model: payload.model, usage: payload.usage, at: new Date().toISOString() });
    }
    state.conversation = state.conversation.slice(-8);
  } catch (error) {
    state.conversation.push({ role: 'assistant', content: error.message, provider: 'Notice', at: new Date().toISOString() });
  } finally {
    button.disabled = false;
    button.textContent = '↑';
    renderConversation();
    scheduleSave();
  }
}

function setView(view, save) {
  if (!['overview', 'data', 'notebook', 'findings', 'reports'].includes(view)) return;
  state.activeView = view;
  document.querySelectorAll('.sidebar .nav-item[data-view]').forEach(function (button) { button.classList.toggle('active', button.dataset.view === view); });
  byId('notebook-panel').classList.toggle('hidden', view !== 'notebook');
  byId('reports-panel').classList.toggle('hidden', view !== 'reports');
  const hideMain = view === 'notebook' || view === 'reports';
  document.querySelector('.metric-grid').classList.toggle('hidden', hideMain);
  document.querySelector('.dashboard-grid').classList.toggle('hidden', hideMain);
  byId('data-panel').classList.toggle('hidden', hideMain);
  const pages = {
    overview: ['Revenue, in focus.', 'A clear view of what’s moving — and what deserves a closer look.'],
    data: ['Explore the details.', 'Search, sort and inspect the records behind the summary.'],
    findings: ['Signals worth a closer look.', 'Evidence-led observations from the active dataset.'],
    notebook: ['Your thinking, in context.', 'Notes and sketches stay attached to this analysis.'],
    reports: ['Make the work shareable.', 'Build a clear export from the current project.']
  };
  byId('page-title').textContent = pages[view][0];
  byId('page-subtitle').textContent = pages[view][1];
  if (view === 'data') byId('data-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (view === 'findings') document.querySelector('.analyst-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (save !== false) scheduleSave();
}

function setLayout(layout, options) {
  state.layout = layout;
  document.body.dataset.layout = layout;
  document.querySelectorAll('[data-layout]').forEach(function (button) { button.classList.toggle('active', button.dataset.layout === layout); });
  if (options?.manual) {
    const url = new URL(location.href);
    url.searchParams.set('layout', layout);
    history.replaceState(null, '', url);
  }
  scheduleSave();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = state.theme;
  window.dispatchEvent(new Event('themechange'));
  scheduleSave();
}

async function persistNow() {
  clearTimeout(persistTimer);
  try {
    await saveWorkspace({
      activeView: state.activeView, activeDatasetId: state.activeDatasetId,
      projects: state.projects, activeProjectId: state.activeProjectId,
      chart: state.chart, selectedPoint: state.selectedPoint,
      conversation: state.conversation.slice(-8), notes: state.notes, strokes: state.strokes,
      provider: state.provider, includeSamples: state.includeSamples,
      theme: state.theme, layout: state.layout
    });
    byId('save-label').textContent = 'All changes saved';
  } catch (error) {
    byId('save-label').textContent = 'Save needs attention';
    console.error('Workspace save failed:', error);
  }
}

function scheduleSave() {
  byId('save-label').textContent = 'Saving…';
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 380);
}

function datasetMenu() {
  const dataset = activeDataset();
  const action = prompt('Dataset options: type rename or delete.', 'rename');
  if (action === null) return;
  if (action.toLowerCase() === 'rename') {
    const name = prompt('Name this dataset', dataset.name);
    if (!name?.trim()) return;
    dataset.name = name.trim().slice(0, 90);
    if (dataset.id !== DEMO_DATASET.id) saveDataset(dataset).catch(function () {});
    renderDatasetChrome();
    scheduleSave();
  } else if (action.toLowerCase() === 'delete') {
    if (dataset.id === DEMO_DATASET.id) return toast('The labelled demo dataset cannot be deleted.');
    if (!confirm('Delete ' + dataset.name + ' from this device?')) return;
    state.datasets = state.datasets.filter(function (item) { return item.id !== dataset.id; });
    removeDataset(dataset.id).catch(function () {});
    state.activeDatasetId = state.datasets[0]?.id || DEMO_DATASET.id;
    state.conversation = [];
    state.selectedPoint = null;
    renderAll();
    scheduleSave();
  }
}

function createProject() {
  const name = prompt('Name this project');
  if (!name?.trim()) return;
  const project = { id: crypto.randomUUID(), name: name.trim().slice(0, 80) };
  state.projects.unshift(project);
  state.activeProjectId = project.id;
  renderProjectNav();
  scheduleSave();
}

function cycleProject() {
  if (!state.projects.length) return;
  const current = state.projects.findIndex(function (project) { return project.id === state.activeProjectId; });
  state.activeProjectId = state.projects[(current + 1) % state.projects.length].id;
  renderProjectNav();
  scheduleSave();
}

function openSettings() { byId('settings-dialog').showModal(); checkProviderStatus(); }

async function checkProviderStatus() {
  try {
    const response = await fetch('/api/health');
    const payload = await response.json();
    state.aiStatus = payload.providers;
    const configured = Object.entries(payload.providers || {}).filter(function (entry) { return entry[1]; }).map(function (entry) { return entry[0]; });
    byId('provider-status').textContent = configured.length ? 'Available on this server: ' + configured.join(', ') + '. Credentials are not sent to the browser.' : 'No AI provider is configured. Add an API key and model ID in the server .env file.';
    byId('ai-status-dot').style.background = configured.length ? '#49b887' : '#c0a26d';
  } catch {
    state.aiStatus = null;
    byId('provider-status').textContent = 'The local API is unavailable. Local analysis still works.';
    byId('ai-status-dot').style.background = '#d19a56';
  }
  updateProviderCaption();
}

function updateProviderCaption() {
  const configured = state.provider === 'auto'
    ? state.aiStatus?.openai || state.aiStatus?.anthropic
    : state.aiStatus?.[state.provider];
  byId('ai-provider-label').textContent = configured
    ? (state.provider === 'auto' ? 'AI available · summary only' : state.provider + ' · summary only')
    : 'Local analysis · private by default';
  byId('privacy-hint').textContent = state.includeSamples ? 'Includes up to 5 sample rows' : 'Summary only';
}

function openSearch() {
  byId('search-dialog').showModal();
  byId('global-search').value = '';
  renderSearch();
  setTimeout(function () { byId('global-search').focus(); }, 40);
}

function renderSearch() {
  const query = byId('global-search').value.trim().toLowerCase();
  const matches = state.datasets.filter(function (dataset) { return !query || dataset.name.toLowerCase().includes(query) || dataset.columns.some(function (column) { return column.toLowerCase().includes(query); }); }).slice(0, 8);
  const results = byId('search-results');
  results.replaceChildren();
  matches.forEach(function (dataset) {
    const item = document.createElement('div');
    item.className = 'search-result';
    const icon = document.createElement('span');
    icon.textContent = '▤';
    const name = document.createElement('b');
    name.textContent = dataset.name;
    const count = document.createElement('small');
    count.textContent = formatCount(dataset.rows.length) + ' rows';
    item.append(icon, name, count);
    item.addEventListener('click', function () {
      state.activeDatasetId = dataset.id;
      state.conversation = [];
      byId('search-dialog').close();
      renderAll();
      setView('data');
      scheduleSave();
    });
    results.append(item);
  });
  if (query && state.notes.toLowerCase().includes(query)) {
    const note = document.createElement('div');
    note.className = 'search-result';
    note.textContent = '▧  Project notes';
    note.addEventListener('click', function () { byId('search-dialog').close(); setView('notebook'); });
    results.append(note);
  }
}

function exportCsv() {
  const rows = filteredRows();
  if (!rows.length) return toast('No matching rows to export.');
  const columns = activeDataset().columns;
  const content = [columns].concat(rows.map(function (row) { return columns.map(function (column) { return row[column]; }); }))
    .map(function (row) { return row.map(csvValue).join(','); }).join('\r\n');
  downloadBlob(content, activeDataset().name + '.csv', 'text/csv;charset=utf-8');
}

function exportReport() {
  const profile = currentProfile();
  const findings = currentFindings();
  const chart = byId('chart-container').querySelector('svg')?.outerHTML || '';
  const html = '<!doctype html><meta charset="utf-8"><title>' + escapeHtml(activeDataset().name) + ' · Tessera report</title>' +
    '<style>body{font:16px system-ui;max-width:980px;margin:44px auto;padding:0 20px;color:#202438}h1{font-size:32px}li{margin:12px 0}svg{max-width:100%;height:auto;border:1px solid #eee;border-radius:12px}small{color:#73788d}</style>' +
    '<p><small>TESSERA · ANALYSIS REPORT</small></p><h1>' + escapeHtml(activeDataset().name) + '</h1>' +
    '<p>' + formatCount(profile.rowCount) + ' rows · ' + profile.columnCount + ' columns · Data quality ' + profile.qualityScore + '/100</p>' +
    '<h2>Visualisation</h2>' + chart + '<h2>Findings</h2><ul>' +
    findings.map(function (finding) { return '<li><b>' + escapeHtml(finding.title) + '</b><br>' + escapeHtml(finding.detail) + '<br><small>' + escapeHtml(finding.evidence) + '</small></li>'; }).join('') +
    '</ul><h2>Notes</h2><p>' + escapeHtml(state.notes || 'No notes saved.') + '</p><p><small>Calculations are produced from the local dataset. Potential outliers are review flags, not proof of an error.</small></p>';
  downloadBlob(html, 'tessera-analysis-report.html', 'text/html;charset=utf-8');
}

function exportSnapshot() {
  const profile = currentProfile();
  const snapshot = {
    product: 'Tessera', exportedAt: new Date().toISOString(),
    project: state.projects.find(function (project) { return project.id === state.activeProjectId; }),
    dataset: { name: activeDataset().name, source: activeDataset().source, profile, columns: activeDataset().columns },
    findings: currentFindings(), chart: state.chart, conversation: state.conversation, notes: state.notes
  };
  downloadBlob(JSON.stringify(snapshot, null, 2), 'tessera-project-snapshot.json', 'application/json');
}

async function shareSummary() {
  const profile = currentProfile();
  const summary = activeDataset().name + ': ' + formatCount(profile.rowCount) + ' rows, ' + profile.columnCount + ' columns. Quality score ' + profile.qualityScore + '/100.';
  try {
    if (navigator.share) await navigator.share({ title: 'Tessera analysis', text: summary });
    else { await navigator.clipboard.writeText(summary); toast('Summary copied to clipboard.'); }
  } catch (error) { if (error.name !== 'AbortError') toast('Share is not available in this browser.'); }
}

async function clearWorkspace() {
  if (!confirm('Delete all datasets, notes and analysis history saved by Tessera in this browser?')) return;
  await clearLocalData();
  state.datasets = [DEMO_DATASET];
  state.activeDatasetId = DEMO_DATASET.id;
  state.conversation = [];
  state.notes = '';
  state.strokes = [];
  state.selectedPoint = null;
  drawing.clear();
  byId('note-input').value = '';
  byId('settings-dialog').close();
  renderAll();
  scheduleSave();
  toast('Local workspace cleared.');
}

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvValue(value) {
  const raw = value instanceof Date ? value.toISOString() : (value ?? '');
  const text = String(raw);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

function toast(message) {
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  byId('toast-region').append(item);
  setTimeout(function () { item.remove(); }, 4200);
}

initialize();
