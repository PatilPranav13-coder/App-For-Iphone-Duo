import {
  DEMO_DATASET, answerLocally, formatCount, formatMoneyOrNumber,
  makeFindings, parseDatasetFile, profileDataset, summarizeForProvider
} from './analysis/engine.js';
import { executeAnalysisTool, isAnalysisTool, validateAnalysisToolCall } from './analysis/tool-registry.js';
import { listDatasets, listProjects, ensureProjects, listWorkspaceRevisions, saveProject, saveDataset, saveDatasetAndWorkspace, readWorkspace, saveWorkspace, removeDataset, clearLocalData } from './storage/database.js';
import { createWorkspaceState, hydrateWorkspaceState, workspaceSnapshot } from './workspace/state.js';
import { renderChart, downloadChartSvg } from './visualization/chart.js';
import { detectAutomaticLayout, initFoldableLayout } from './foldable/posture.js';
import { createNotebookCanvas } from './notebook/canvas.js';

const byId = function (id) { return document.getElementById(id); };
const state = createWorkspaceState(DEMO_DATASET);
const EMPTY_DATASET = { id: 'empty', name: 'No dataset yet', source: 'LOCAL', rows: [], columns: [], profile: null };

let persistTimer;
let drawing;
let dataWorker;
let questionController;
let savingWorkspace = Promise.resolve();
let workerCacheReady = Promise.resolve();
let workerSequence = 0;
const workerJobs = new Map();

const activeDataset = function () {
  return state.datasets.find(function (dataset) { return dataset.id === state.activeDatasetId; }) || state.datasets[0] || EMPTY_DATASET;
};
const activeRows = function () { return activeDataset().rows || []; };
const analysisRows = function () {
  let rows = activeRows();
  state.activeFilters.forEach(function (filter) {
    rows = rows.filter(function (row) { return filter.operator === 'equals' && String(row[filter.column] ?? '') === String(filter.value); });
  });
  return rows;
};
const currentProfile = function () {
  const dataset = activeDataset();
  if (!state.activeFilters.length && dataset.profile) return dataset.profile;
  return profileDataset(analysisRows(), dataset.columns);
};
const currentFindings = function () { return makeFindings(analysisRows(), currentProfile()); };

async function initialize() {
  try {
    await ensureProjects(state.projects);
    const [savedWorkspace, savedProjects] = await Promise.all([readWorkspace(), listProjects()]);
    if (savedProjects?.length) state.projects = savedProjects.sort(function (a, b) { return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)); });
    if (savedWorkspace) hydrateWorkspaceState(state, savedWorkspace);
    if (!state.projects.some(function (project) { return project.id === state.activeProjectId; })) state.activeProjectId = 'default';
    const projectDatasets = await listDatasets(state.activeProjectId);
    state.datasets = (state.activeProjectId === 'default' ? [DEMO_DATASET] : []).concat(projectDatasets);
    if (!state.datasets.some(function (dataset) { return dataset.id === state.activeDatasetId; })) state.activeDatasetId = state.datasets[0]?.id || EMPTY_DATASET.id;
    if (activeDataset().rows?.length) { await ensureDatasetProfile(activeDataset()); workerCacheReady = cacheDatasetForWorker(activeDataset(), true); await workerCacheReady; }
  } catch (error) {
    toast('Local storage could not be opened. The workspace will work for this session only.');
    console.error('Storage initialization failed:', error);
  }
  bindEvents();
  byId('note-input').value = state.notes;
  byId('compact-note').value = state.notes;
  byId('provider-select').value = state.provider;
  byId('sample-consent').checked = state.includeSamples;
  document.body.dataset.theme = state.theme;
  drawing = createNotebookCanvas(byId('drawing-canvas'), state.strokes, function (strokes, view) {
    state.strokes = strokes;
    state.canvasView = view;
    scheduleSave();
  }, state.canvasView, function () { return state.annotationContext ? JSON.parse(JSON.stringify(state.annotationContext)) : null; });
  syncNotebookControls();
  renderAll();
  initFoldableLayout(setLayout, state.layoutPreference);
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
  byId('chart-type').addEventListener('change', function () { state.chart.type = byId('chart-type').value; state.selectedPoint = null; state.annotationContext = null; updateChart(); scheduleSave(); });
  byId('x-column').addEventListener('change', function () { state.chart.x = byId('x-column').value; state.selectedPoint = null; state.annotationContext = null; updateChart(); scheduleSave(); });
  byId('y-column').addEventListener('change', function () { state.chart.y = byId('y-column').value; state.selectedPoint = null; state.annotationContext = null; updateChart(); scheduleSave(); });
  byId('chart-zoom').addEventListener('input', function () { state.chart.zoom = Number(byId('chart-zoom').value); if (state.chart.zoom === 1) state.chart.offset = 0; updateChart(); scheduleSave(); });
  byId('chart-pan-left').addEventListener('click', function () { panChart(-0.16); });
  byId('chart-pan-right').addEventListener('click', function () { panChart(0.16); });
  byId('chart-reset-view').addEventListener('click', function () { state.chart.zoom = 1; state.chart.offset = 0; byId('chart-zoom').value = '1'; updateChart(); scheduleSave(); });
  byId('table-search').addEventListener('input', function () { state.tableSearch = byId('table-search').value; renderTable(); });
  byId('download-csv').addEventListener('click', exportCsv);
  byId('chart-download').addEventListener('click', function () { if (!downloadChartSvg(byId('chart-container'))) toast('Choose chart columns first.'); });
  byId('chart-menu').addEventListener('click', function () {
    const menu = byId('chart-options-menu');
    const open = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !open);
    byId('chart-menu').setAttribute('aria-expanded', String(open));
  });
  byId('chart-menu-svg').addEventListener('click', function () { closeChartMenu(); if (!downloadChartSvg(byId('chart-container'))) toast('Choose chart columns first.'); });
  byId('chart-menu-csv').addEventListener('click', function () { closeChartMenu(); exportCsv(); });
  byId('dataset-menu').addEventListener('click', datasetMenu);
  byId('ask-selected-point').addEventListener('click', askAboutSelectedPoint);
  byId('ask-annotation-context').addEventListener('click', askAboutSelectedPoint);
  byId('filter-selected-point').addEventListener('click', filterToSelectedPoint);
  byId('explore-group').addEventListener('click', drilldownSelectedPoint);
  byId('filter-chips').addEventListener('click', function (event) {
    const button = event.target.closest('[data-filter-index]');
    if (!button) return;
    state.activeFilters.splice(Number(button.dataset.filterIndex), 1);
    state.selectedPoint = null;
    state.annotationContext = null;
    renderAll();
    scheduleSave();
  });
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
  byId('recover-workspace').addEventListener('click', recoverPreviousRevision);
  byId('search-open').addEventListener('click', openSearch);
  byId('global-search').addEventListener('input', renderSearch);
  byId('search-dialog').addEventListener('click', function (event) { if (event.target === byId('search-dialog')) byId('search-dialog').close(); });
  byId('mobile-menu').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  document.querySelectorAll('.sidebar .nav-item').forEach(function (button) { button.addEventListener('click', function () { document.body.classList.remove('nav-open'); }); });
  byId('new-project').addEventListener('click', createProject);
  byId('project-switcher').addEventListener('click', cycleProject);
  byId('profile-button').addEventListener('click', openSettings);
  byId('share-button').addEventListener('click', shareSummary);
  byId('assistant-menu').addEventListener('click', createConversationBranch);
  byId('conversation-branch').addEventListener('change', function () { switchConversationBranch(byId('conversation-branch').value); });
  byId('panel-arrangement').addEventListener('change', function () { state.panelArrangement = byId('panel-arrangement').value; updatePanelArrangement(); scheduleSave(); });
  byId('inspector-size').addEventListener('input', function () {
    state.panelSizes.inspector = Number(byId('inspector-size').value);
    document.documentElement.style.setProperty('--inspector-size', state.panelSizes.inspector + 'px');
    scheduleSave();
  });
  byId('navigation-size').addEventListener('input', function () {
    state.panelSizes.navigation = Number(byId('navigation-size').value);
    document.documentElement.style.setProperty('--navigation-size', state.panelSizes.navigation + 'px');
    scheduleSave();
  });
  byId('toggle-navigation').addEventListener('click', function () {
    state.openPanels.navigation = !state.openPanels.navigation;
    updatePanelArrangement();
    scheduleSave();
  });
  byId('toggle-inspector').addEventListener('click', function () {
    state.openPanels.inspector = !state.openPanels.inspector;
    updatePanelArrangement();
    scheduleSave();
  });
  byId('compact-upload').addEventListener('click', function () { byId('file-input').click(); });
  byId('compact-open-studio').addEventListener('click', function () { setLayout('studio', { manual: true }); });
  byId('compact-open-analysis').addEventListener('click', function () { setLayout('focus', { manual: true }); setView('overview'); });
  byId('compact-ask-form').addEventListener('submit', function (event) {
    event.preventDefault();
    byId('question-input').value = byId('compact-question').value;
    byId('compact-question').value = '';
    byId('ask-form').requestSubmit();
  });
  byId('compact-datasets').addEventListener('click', selectCompactDataset);
  byId('compact-insights').addEventListener('click', function (event) {
    const button = event.target.closest('[data-insight-question]');
    if (!button) return;
    byId('question-input').value = 'Explain this finding: ' + button.dataset.insightQuestion;
    setLayout('focus');
    byId('ask-form').requestSubmit();
  });
  byId('compact-conversation').addEventListener('click', function () { setLayout('focus', { manual: true }); });
  byId('compact-note').addEventListener('input', function () { state.notes = byId('compact-note').value; byId('note-input').value = state.notes; scheduleSave(); });
  byId('cancel-question').addEventListener('click', function () { questionController?.abort(); });
  document.querySelectorAll('.tool-button[data-pen]').forEach(function (button) {
    button.addEventListener('click', function () {
      state.notebookTool = button.dataset.pen;
      drawing.setTool(button.dataset.pen);
      document.querySelectorAll('.tool-button[data-pen]').forEach(function (item) { item.classList.toggle('active', item === button); });
      scheduleSave();
    });
  });
  byId('pen-color').addEventListener('input', function () { state.notebookColor = byId('pen-color').value; drawing.setColor(state.notebookColor); scheduleSave(); });
  byId('pen-width').addEventListener('input', function () { state.notebookWidth = Number(byId('pen-width').value); drawing.setWidth(state.notebookWidth); scheduleSave(); });
  byId('undo-stroke').addEventListener('click', function () { if (!drawing.undo()) toast('There is no stroke to undo.'); });
  byId('redo-stroke').addEventListener('click', function () { if (!drawing.redo()) toast('There is no stroke to redo.'); });
  byId('delete-selection').addEventListener('click', function () { if (!drawing.deleteSelection()) toast('Use the lasso to select strokes first.'); });
  byId('zoom-out').addEventListener('click', function () { drawing.setZoom(drawing.getView().zoom - 0.2); });
  byId('zoom-in').addEventListener('click', function () { drawing.setZoom(drawing.getView().zoom + 0.2); });
  byId('reset-canvas-view').addEventListener('click', function () { drawing.resetView(); });
  byId('clear-canvas').addEventListener('click', function () { drawing.clear(); toast('Sketch cleared.'); });
  byId('note-input').addEventListener('input', function () { state.notes = byId('note-input').value; byId('compact-note').value = state.notes; scheduleSave(); });
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
    if (event.key === 'Escape') { document.body.classList.remove('nav-open'); closeChartMenu(); }
  });
  document.addEventListener('click', function (event) { if (!event.target.closest('.chart-menu-wrap')) closeChartMenu(); });
  document.addEventListener('dragover', function (event) { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', function (event) {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) { event.preventDefault(); importFiles(files); }
  });
  byId('workspace-scroll').addEventListener('scroll', function () { state.scrollPositions[ state.activeView ] = byId('workspace-scroll').scrollTop; scheduleSave(); }, { passive: true });
}

function renderAll() {
  byId('compact-hub').classList.remove('hidden');
  byId('table-search').value = state.tableSearch;
  renderProjectNav();
  renderDatasetChrome();
  renderMetrics();
  renderChartControls();
  renderFilters();
  updateChart();
  renderFindings();
  renderConversation();
  renderTable();
  renderCompactHub();
  renderConversationBranches();
  setView(state.activeView, false);
  updatePanelArrangement();
  document.querySelectorAll('[data-layout]').forEach(function (button) { button.classList.toggle('active', button.dataset.layout === (state.layoutPreference === 'auto' ? 'auto' : state.layout)); });
  updateProviderCaption();
}

function syncNotebookControls() {
  drawing.setTool(state.notebookTool);
  drawing.setColor(state.notebookColor);
  drawing.setWidth(state.notebookWidth);
  byId('pen-color').value = state.notebookColor;
  byId('pen-width').value = String(state.notebookWidth);
  document.querySelectorAll('.tool-button[data-pen]').forEach(function (item) { item.classList.toggle('active', item.dataset.pen === state.notebookTool); });
}

function renderFilters() {
  const container = byId('filter-chips');
  container.replaceChildren();
  if (!state.activeFilters.length) {
    const hint = document.createElement('span');
    hint.className = 'filter-empty';
    hint.textContent = 'No chart filters';
    container.append(hint);
    return;
  }
  state.activeFilters.forEach(function (filter, index) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.filterIndex = String(index);
    chip.className = 'filter-chip';
    chip.textContent = filter.column + ' = ' + filter.value + '  ×';
    container.append(chip);
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'filter-clear';
  clear.textContent = 'Clear filters';
  clear.addEventListener('click', function () { state.activeFilters = []; state.selectedPoint = null; state.annotationContext = null; renderAll(); scheduleSave(); });
  container.append(clear);
}

function askAboutSelectedPoint() {
  if (!state.selectedPoint) return;
  if (state.activeView !== 'overview') setView('overview', false);
  if (state.layout === 'compact') setLayout('focus', { manual: true });
  const point = state.selectedPoint;
  const question = point.type === 'scatter'
    ? 'Explain the selected scatter observation: ' + state.chart.x + ' = ' + point.xValue + ', ' + state.chart.y + ' = ' + point.yValue + '. Show the supporting record calculation.'
    : point.type === 'histogram'
      ? 'Explain the selected ' + state.chart.y + ' histogram interval from ' + point.lower + ' to ' + point.upper + '. Show the count and distribution context.'
      : point.type === 'donut' && point.otherBucket
        ? 'Explain the Other category in the ' + state.chart.y + ' by ' + state.chart.x + ' chart. Show its aggregate and contributing groups.'
        : 'Explain the selected ' + state.chart.y + ' point for ' + state.chart.x + ' = ' + point.label + '. Show the supporting calculation and compare it with nearby groups.';
  byId('question-input').value = question;
  byId('ask-form').requestSubmit();
}

function filterToSelectedPoint() {
  const filter = state.selectedPoint?.filter;
  if (!filter) return;
  const current = state.activeFilters.findIndex(function (item) { return item.column === filter.column && item.value === filter.value; });
  if (current === -1) state.activeFilters.push({ ...filter, operator: 'equals' });
  renderAll();
  scheduleSave();
  toast('The chart and table now show ' + filter.column + ' = ' + filter.value + '.');
}

function drilldownSelectedPoint() {
  const filter = state.selectedPoint?.filter;
  const next = currentProfile().categoryColumns.find(function (column) { return column !== state.chart.x; });
  if (!filter || !next) return;
  if (!state.activeFilters.some(function (item) { return item.column === filter.column && item.value === filter.value; })) state.activeFilters.push({ ...filter, operator: 'equals' });
  state.chart.x = next;
  state.chart.type = 'bar';
  state.selectedPoint = null;
  renderAll();
  scheduleSave();
  toast('Chart drilled into ' + next + ' for ' + filter.value + '.');
}

function compactToolOutput(output) {
  let safe = JSON.parse(JSON.stringify(output));
  let text = JSON.stringify(safe);
  const result = safe.result;
  if (text.length > 3_000) {
    if (Array.isArray(result)) safe.result = result.slice(0, 12);
    else if (result && Array.isArray(result.sample)) result.sample = result.sample.slice(0, 2);
    else if (result && Array.isArray(result.points)) result.points = result.points.slice(-12);
    else if (result && Array.isArray(result.columns)) result.columns = result.columns.slice(0, 20);
    text = JSON.stringify(safe);
  }
  if (text.length > 3_000) return { result: { note: 'The deterministic result was larger than the response limit; narrow the group or filter and run the calculation again.' }, provenance: safe.provenance };
  return safe;
}

function compactCalculationHistory(trace) {
  return trace.map(function (round) {
    return {
      calls: round.calls.slice(0, 3).map(function (call) { return { callId: call.callId, name: call.name, arguments: call.arguments }; }),
      results: round.results.slice(0, 3).map(function (result) {
        const output = JSON.parse(JSON.stringify(result.output));
        const data = output?.result;
        if (Array.isArray(data)) output.result = data.slice(0, 10);
        else if (data && Array.isArray(data.sample)) data.sample = data.sample.slice(0, 4);
        else if (data && Array.isArray(data.points)) data.points = data.points.slice(0, 12);
        else if (data && Array.isArray(data.columns)) data.columns = data.columns.slice(0, 24);
        if (JSON.stringify(output).length > 2500) output.result = { summary: 'Calculation completed; detailed output is in the current investigation.' };
        return { callId: result.callId, output, error: result.error };
      })
    };
  });
}

function updatePointContext() {
  const point = state.selectedPoint;
  const selected = Boolean(point);
  byId('ask-selected-point').classList.toggle('hidden', !selected);
  byId('filter-selected-point').classList.toggle('hidden', !point?.filter);
  const drillColumn = currentProfile().categoryColumns.find(function (column) { return column !== state.chart.x; });
  byId('explore-group').classList.toggle('hidden', !point?.filter || !drillColumn);
  byId('chart-note').textContent = selected ? point.label + ' · ' + point.value : 'Select a mark for context';
  const annotation = state.annotationContext;
  byId('ask-annotation-context').classList.toggle('hidden', !annotation?.point || !selected);
  byId('notebook-link-label').textContent = annotation?.point
    ? 'Linked to ' + annotation.point.label + ' · ' + (annotation.chart?.y || 'chart')
    : (activeDataset().rows?.length ? 'Linked to ' + activeDataset().name : 'Linked to this project');
}

function renderCompactHub() {
  const project = state.projects.find(function (item) { return item.id === state.activeProjectId; });
  const dataset = activeDataset();
  const profile = currentProfile();
  byId('compact-project-name').textContent = project?.name || 'Personal workspace';
  byId('compact-dataset-name').textContent = dataset.name;
  byId('compact-dataset-meta').textContent = dataset.rows?.length ? formatCount(profile.rowCount) + ' rows · ' + profile.columnCount + ' columns' : 'No data yet · add a dataset to begin';
  const datasetList = byId('compact-datasets');
  datasetList.replaceChildren();
  const recent = state.datasets.slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }).slice(0, 4);
  recent.forEach(function (item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.datasetId = item.id;
    button.className = 'compact-list-item';
    button.innerHTML = '<span class="compact-list-icon">▤</span><span><b></b><small></small></span><span class="compact-arrow">›</span>';
    button.querySelector('b').textContent = item.name;
    button.querySelector('small').textContent = formatCount(item.rows?.length || 0) + ' rows';
    datasetList.append(button);
  });
  if (!recent.length) datasetList.append(compactEmpty('Datasets you add to this project will appear here.'));
  const insightList = byId('compact-insights');
  insightList.replaceChildren();
  currentFindings().slice(0, 3).forEach(function (finding) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.insightQuestion = finding.title;
    button.className = 'compact-insight';
    const title = document.createElement('b');
    const detail = document.createElement('small');
    title.textContent = finding.title;
    detail.textContent = finding.detail;
    button.append(title, detail);
    insightList.append(button);
  });
  if (!insightList.childElementCount) insightList.append(compactEmpty('Import a dataset to surface evidence-led findings.'));
  const conversation = byId('compact-conversation');
  conversation.replaceChildren();
  state.conversation.slice(-3).reverse().forEach(function (message) {
    const item = document.createElement('div');
    item.className = 'compact-message ' + message.role;
    item.textContent = message.content;
    conversation.append(item);
  });
  if (!conversation.childElementCount) conversation.append(compactEmpty('Your next question will start an investigation here.'));
  byId('compact-note').value = state.notes;
}

function compactEmpty(message) {
  const empty = document.createElement('p');
  empty.className = 'compact-empty';
  empty.textContent = message;
  return empty;
}

function selectCompactDataset(event) {
  const button = event.target.closest('[data-dataset-id]');
  if (!button) return;
  switchDataset(button.dataset.datasetId);
  setView('data');
}

function updatePanelArrangement() {
  const grid = document.querySelector('.dashboard-grid');
  grid.classList.toggle('assistant-first', state.panelArrangement === 'assistant-chart');
  grid.classList.toggle('inspector-hidden', !state.openPanels.inspector);
  document.body.classList.toggle('nav-collapsed', !state.openPanels.navigation);
  byId('panel-arrangement').value = state.panelArrangement;
  byId('navigation-size').value = String(state.panelSizes.navigation || 238);
  document.documentElement.style.setProperty('--navigation-size', (state.panelSizes.navigation || 238) + 'px');
  byId('toggle-navigation').textContent = state.openPanels.navigation ? 'Hide navigation' : 'Show navigation';
  byId('toggle-navigation').setAttribute('aria-pressed', String(state.openPanels.navigation));
  byId('toggle-inspector').textContent = state.openPanels.inspector ? 'Hide assistant' : 'Show assistant';
  byId('toggle-inspector').setAttribute('aria-pressed', String(state.openPanels.inspector));
  byId('inspector-size').value = String(state.panelSizes.inspector || 360);
  document.documentElement.style.setProperty('--inspector-size', (state.panelSizes.inspector || 360) + 'px');
}

function renderConversationBranches() {
  const select = byId('conversation-branch');
  const branchIds = Object.keys(state.conversationBranches || { main: [] });
  if (!branchIds.includes(state.conversationBranchId)) branchIds.push(state.conversationBranchId);
  select.replaceChildren(...branchIds.map(function (id, index) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id === 'main' ? 'Main investigation' : 'Branch ' + index;
    return option;
  }));
  select.value = state.conversationBranchId;
}

function renderProjectNav() {
  const label = state.projects.find(function (project) { return project.id === state.activeProjectId; })?.name || 'Q3 revenue review';
  document.querySelector('.breadcrumbs strong').textContent = label;
  document.querySelector('#project-switcher b').textContent = label;
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
    button.addEventListener('click', function () { switchProject(project.id); });
    previous.after(button);
    previous = button;
  });
}

function renderDatasetChrome() {
  const dataset = activeDataset();
  byId('dataset-title').textContent = dataset.name;
  byId('table-source').textContent = dataset.source || 'LOCAL';
  byId('demo-tag').classList.toggle('hidden', dataset.id !== DEMO_DATASET.id);
  byId('dataset-count').textContent = String(state.datasets.filter(function (item) { return item.id !== DEMO_DATASET.id; }).length + (dataset.id === DEMO_DATASET.id ? 1 : 0));
}

function renderMetrics() {
  const profile = currentProfile();
  const numericColumn = profile.columns.find(function (column) { return column.type === 'number'; });
  const total = numericColumn ? analysisRows().reduce(function (sum, row) { const value = Number(row[numericColumn.name]); return Number.isFinite(value) ? sum + value : sum; }, 0) : null;
  const outliers = profile.columns.reduce(function (sum, column) { return sum + column.outliers; }, 0);
  const cards = [
    { label: numericColumn ? 'Total ' + numericColumn.name : 'Dataset size', value: numericColumn ? formatMoneyOrNumber(total, numericColumn.name) : formatCount(profile.rowCount), caption: numericColumn ? (state.activeFilters.length ? 'Calculated with active filters' : 'Calculated from all valid values') : profile.columnCount + ' columns in this file', symbol: '↗' },
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
  byId('chart-zoom').value = String(state.chart.zoom || 1);
  byId('chart-title').textContent = state.chart.y ? state.chart.y + (state.chart.type === 'donut' ? ' by ' + state.chart.x : ' trend') : 'Choose a numeric measure';
}

function makeOption(value) { const option = document.createElement('option'); option.value = value; option.textContent = value; return option; }

function panChart(delta) {
  if ((state.chart.zoom || 1) <= 1) return toast('Zoom in before panning the chart.');
  state.chart.offset = Math.max(0, Math.min(1, (Number(state.chart.offset) || 0) + delta));
  updateChart();
  scheduleSave();
}

function updateChart() {
  const dataset = activeDataset();
  if (!dataset.rows?.length || !state.chart.y) {
    byId('chart-container').innerHTML = '<div class="chart-empty">Add a dataset with at least one numeric column to chart your data.</div>';
    updatePointContext();
    return;
  }
  const rows = analysisRows();
  if (!rows.length) {
    byId('chart-container').innerHTML = '<div class="chart-empty">No rows match these filters. Clear a filter to see the chart again.</div>';
    byId('chart-container').setAttribute('aria-label', 'No rows match the active filters.');
    updatePointContext();
    return;
  }
  renderChart(byId('chart-container'), rows, { ...state.chart, selectedPoint: state.selectedPoint }, function (point) {
    state.selectedPoint = point;
    state.annotationContext = { projectId: state.activeProjectId, datasetId: dataset.id, chart: { ...state.chart }, point: { label: point.label, value: point.value } };
    byId('question-input').placeholder = 'Ask about ' + point.label + '…';
    updatePointContext();
    toast(point.label + ' selected · chart context saved with this project.');
    updateChart();
    scheduleSave();
  });
  const shown = Number(byId('chart-container').dataset.pointsShown || 0);
  const total = Number(byId('chart-container').dataset.pointsTotal || 0);
  const pointNote = shown < total ? 'Showing ' + formatCount(shown) + ' of ' + formatCount(total) + ' groups · ' : '';
  byId('chart-legend').innerHTML = '<span class="legend-item"><i class="legend-dot"></i>' + escapeHtml(state.chart.y) + '</span><span class="chart-note">' + pointNote + 'Select a value to follow up with context</span>';
  updatePointContext();
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
    if (message.analysisEvidence?.length) {
      const evidence = document.createElement('small');
      evidence.className = 'analysis-evidence';
      evidence.textContent = message.analysisEvidence.slice(0, 6).map(function (entry) { return entry.name + ' · ' + entry.method + ' · ' + formatCount(entry.rowsUsed) + ' rows'; }).join('  /  ');
      item.append(evidence);
    }
    if (message.analysisCalculations?.length) {
      const details = document.createElement('details');
      details.className = 'calculation-details';
      const summary = document.createElement('summary');
      const pre = document.createElement('pre');
      summary.textContent = 'View calculation inputs and results';
      pre.textContent = JSON.stringify(message.analysisCalculations, null, 2);
      details.append(summary, pre);
      item.append(details);
    }
    feed.append(item);
  });
  const scroll = byId('analyst-feed');
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
  let rows = analysisRows();
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
    const previousDatasetId = state.activeDatasetId;
    let pendingDataset = null;
    try {
      const parsed = await runDataWorker('parse', { file });
      pendingDataset = {
        id: crypto.randomUUID(),
        projectId: state.activeProjectId,
        version: 1,
        name: file.name.replace(/\.[^.]+$/, ''),
        source: 'LOCAL',
        createdAt: new Date().toISOString(),
        fileName: file.name,
        rows: parsed.rows,
        columns: parsed.columns,
        profile: parsed.profile
      };
      state.datasets.push(pendingDataset);
      state.activeDatasetId = pendingDataset.id;
      state.selectedPoint = null;
      state.activeFilters = [];
      openDatasetConversation(pendingDataset.id);
      const savedWorkspace = await saveDatasetAndWorkspace(pendingDataset, workspaceSnapshot(state));
      state.revision = savedWorkspace.revision;
      workerCacheReady = cacheDatasetForWorker(pendingDataset);
      await workerCacheReady;
      toast(file.name + ' is ready · ' + formatCount(parsed.rows.length) + ' rows profiled locally.');
    } catch (error) {
      if (pendingDataset) {
        state.datasets = state.datasets.filter(function (item) { return item.id !== pendingDataset.id; });
        state.activeDatasetId = state.datasets.some(function (item) { return item.id === previousDatasetId; }) ? previousDatasetId : (state.datasets[0]?.id || EMPTY_DATASET.id);
      }
      toast(file.name + ': ' + error.message);
    }
  }
  renderAll();
  scheduleSave();
}

async function ensureDatasetProfile(dataset) {
  if (dataset.profile) return dataset.profile;
  const profile = await runDataWorker('profile', { rows: dataset.rows || [], columns: dataset.columns || [] });
  const profiledDataset = { ...dataset, profile };
  const index = state.datasets.findIndex(function (item) { return item.id === dataset.id; });
  if (index !== -1) state.datasets[index] = profiledDataset;
  if (dataset.id !== DEMO_DATASET.id) await saveDataset(profiledDataset).catch(function () {});
  return profile;
}

async function cacheDatasetForWorker(dataset, clearFirst) {
  if (!dataset?.rows?.length) return;
  if (clearFirst) await runDataWorker('clearCache', {}).catch(function () {});
  await runDataWorker('cacheDataset', { datasetId: dataset.id, datasetVersion: dataset.version || 1, rows: dataset.rows, columns: dataset.columns, profile: dataset.profile });
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
    if (parsed.rows.length > 250000 || parsed.columns.length > 100 || parsed.rows.length * parsed.columns.length > 2500000) throw new Error('This release can import up to 250,000 rows, 100 columns and 2.5 million cells per import.');
    return { ...parsed, profile: profileDataset(parsed.rows, parsed.columns) };
  }
  if (type === 'tool') return executeAnalysisTool(payload.name, payload.args, { ...payload.context, rows: analysisRows(), columns: activeDataset().columns, profile: currentProfile(), datasetVersion: activeDataset().version || 1 });
  if (type === 'cacheDataset' || type === 'clearCache') return true;
  return profileDataset(payload.rows, payload.columns);
}

async function onAsk(event) {
  event.preventDefault();
  const question = byId('question-input').value.trim();
  if (!question) return;
  const rows = analysisRows();
  if (!rows.length) return toast(activeRows().length ? 'No rows match the current filters.' : 'Add a dataset before asking a question.');
  state.conversation.push({ role: 'user', content: question, at: new Date().toISOString() });
  state.conversationBranches[state.conversationBranchId] = state.conversation.slice(-32);
  byId('question-input').value = '';
  renderConversation();
  renderCompactHub();
  const button = byId('send-question');
  button.disabled = true;
  button.textContent = '…';
  byId('cancel-question').classList.remove('hidden');
  questionController = new AbortController();
  try {
    const profile = currentProfile();
    const localAnswer = answerLocally(question, rows, profile, state.selectedPoint, state.chart);
    if (localAnswer) {
      state.conversation.push({ role: 'assistant', content: localAnswer.text, provider: 'Local calculation', references: localAnswer.references, at: new Date().toISOString() });
    } else {
      const context = {
        ...summarizeForProvider(rows, profile, currentFindings(), state.includeSamples),
        chart: { ...state.chart },
        selectedPoint: state.selectedPoint,
        dataset: { id: activeDataset().id, name: activeDataset().name, version: activeDataset().version || 1 },
        activeFilters: state.activeFilters,
        conversationBranchId: state.conversationBranchId,
        priorCalculations: state.conversation.filter(function (message) { return message.analysisCalculations?.length; }).slice(-2).map(function (message) {
          return { question: message.question || '', calculations: message.analysisCalculations };
        })
      };
      const history = state.conversation.slice(-8, -1).filter(function (message) { return !message.internal && (message.role === 'user' || message.role === 'assistant'); }).map(function (message) { return { role: message.role, content: message.content.slice(0, 1400) }; });
      let providerForQuestion = state.provider;
      const toolTrace = [];
      const evidence = [];
      let totalCalls = 0;
      let finalPayload = null;
      await workerCacheReady;
      for (let round = 0; round <= 4; round += 1) {
        const response = await fetch('/api/assistant', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: questionController.signal,
          body: JSON.stringify({ question, provider: providerForQuestion, context, history, toolTrace, includeSamples: state.includeSamples, allowTools: round < 4 })
        });
        const payload = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(payload.error || 'The AI provider could not answer this question.');
        const providerCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
        if (providerCalls.some(function (call) { return !call || !isAnalysisTool(call.name); })) throw new Error('The provider requested an unsupported analysis operation. No code or query was executed.');
        if (providerCalls.length && ['openai', 'anthropic'].includes(payload.provider)) providerForQuestion = payload.provider;
        const calls = providerCalls.map(function (call) {
          const args = call.arguments;
          return { ...call, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
        });
        if (!calls.length) { finalPayload = payload; break; }
        if (round >= 4) throw new Error('The analysis reached its safe tool-call limit before a final explanation was returned.');
        if (calls.length > 3 || totalCalls + calls.length > 8) throw new Error('The model requested more analysis steps than this workspace allows.');
        const results = [];
        for (const call of calls) {
          if (!call.callId || typeof call.callId !== 'string' || call.callId.length > 160) throw new Error('The provider returned an invalid analysis call identifier.');
          let output;
          let errorMessage = null;
          const invalid = validateAnalysisToolCall(call.name, call.arguments);
          if (invalid) {
            errorMessage = invalid;
            output = { error: invalid };
          } else {
            try {
              output = await runDataWorker('tool', {
                name: call.name,
                args: call.arguments,
                datasetId: activeDataset().id,
                context: { chart: state.chart, selectedPoint: state.selectedPoint, activeFilters: state.activeFilters, includeSamples: state.includeSamples }
              });
              output = compactToolOutput(output);
              evidence.push({ name: call.name, method: output.provenance?.method || call.name, rowsUsed: output.provenance?.rowsUsed || 0, columns: output.provenance?.columns || [] });
            } catch (error) {
              errorMessage = error.message || 'The requested calculation failed.';
              output = { error: errorMessage };
            }
          }
          results.push({ callId: call.callId, output, error: errorMessage });
          totalCalls += 1;
        }
        toolTrace.push({ calls, results, providerState: payload.providerState || null });
        state.conversation.push({ role: 'assistant', content: 'Checked the dataset with ' + calls.map(function (call) { return call.name.replaceAll('_', ' '); }).join(', ') + '.', provider: payload.provider, internal: true, at: new Date().toISOString() });
        renderConversation();
      }
      if (!finalPayload) throw new Error('The model did not return a final explanation. Please ask again with a narrower question.');
      state.conversation.push({ role: 'assistant', content: finalPayload.text, question, provider: finalPayload.provider, model: finalPayload.model, usage: finalPayload.usage, analysisEvidence: evidence, analysisCalculations: compactCalculationHistory(toolTrace), at: new Date().toISOString() });
    }
    state.conversation = state.conversation.slice(-32);
  } catch (error) {
    if (error.name === 'AbortError') state.conversation.push({ role: 'assistant', content: 'Analysis stopped. Your project and local data remain saved.', provider: 'Notice', at: new Date().toISOString() });
    else state.conversation.push({ role: 'assistant', content: error.message, provider: 'Notice', at: new Date().toISOString() });
  } finally {
    questionController = null;
    button.disabled = false;
    button.textContent = '↑';
    byId('cancel-question').classList.add('hidden');
    state.conversationBranches[state.conversationBranchId] = state.conversation.slice(-32);
    renderConversation();
    renderCompactHub();
    scheduleSave();
  }
}

function setView(view, save) {
  if (!['overview', 'data', 'notebook', 'findings', 'reports'].includes(view)) return;
  state.activeView = view;
  document.body.dataset.view = view;
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
  if (state.scrollPositions[view] !== undefined) byId('workspace-scroll').scrollTop = state.scrollPositions[view];
  if (view === 'data') byId('data-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (view === 'findings') document.querySelector('.analyst-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (save !== false) scheduleSave();
}

function setLayout(layout, options) {
  if (layout === 'auto') {
    state.layoutPreference = 'auto';
    const automatic = options?.layout || (window.innerWidth < 700 ? 'compact' : window.innerWidth < 1160 ? 'focus' : 'studio');
    state.layout = automatic;
  } else {
    state.layout = layout;
    if (options?.manual) state.layoutPreference = layout;
  }
  document.body.dataset.layout = state.layout;
  document.querySelectorAll('[data-layout]').forEach(function (button) { button.classList.toggle('active', button.dataset.layout === (state.layoutPreference === 'auto' ? 'auto' : state.layout)); });
  if (options?.manual || options?.syncUrl || options?.preference) {
    const url = new URL(location.href);
    if (state.layoutPreference === 'auto') url.searchParams.delete('layout');
    else url.searchParams.set('layout', state.layoutPreference);
    history.replaceState(null, '', url);
  }
  updatePanelArrangement();
  renderCompactHub();
  if (options?.save !== false) scheduleSave();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = state.theme;
  window.dispatchEvent(new Event('themechange'));
  scheduleSave();
}

async function persistNow() {
  clearTimeout(persistTimer);
  state.conversationBranches[state.conversationBranchId] = state.conversation.slice(-32);
  savingWorkspace = savingWorkspace.catch(function () {}).then(function () { return saveWorkspace(workspaceSnapshot(state)); });
  try {
    const saved = await savingWorkspace;
    state.revision = saved.revision;
    byId('save-label').textContent = 'Saved · revision ' + saved.revision;
  } catch (error) {
    const quota = error?.name === 'QuotaExceededError' || /quota|storage full/i.test(error?.message || '');
    byId('save-label').textContent = quota ? 'Storage full · export a backup' : 'Save needs attention';
    toast(quota ? 'This browser is low on storage. Export a project snapshot to keep a backup.' : 'This change could not be saved locally. It will remain open for this session.');
    console.error('Workspace save failed:', error);
  }
}

function scheduleSave() {
  byId('save-label').textContent = 'Saving changes…';
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 500);
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
    removeDataset(dataset.id).catch(function (error) { toast('Dataset could not be removed from storage: ' + error.message); });
    state.activeDatasetId = state.datasets[0]?.id || EMPTY_DATASET.id;
    state.activeFilters = [];
    state.selectedPoint = null;
    state.annotationContext = null;
    openDatasetConversation(state.activeDatasetId);
    renderAll();
    scheduleSave();
    if (activeDataset().rows?.length) workerCacheReady = cacheDatasetForWorker(activeDataset(), true).catch(function () {});
    else workerCacheReady = runDataWorker('clearCache', {}).catch(function () {});
  }
}

function createProject() {
  const name = prompt('Name this project');
  if (!name?.trim()) return;
  const project = { id: crypto.randomUUID(), name: name.trim().slice(0, 80), createdAt: new Date().toISOString() };
  state.projects.unshift(project);
  saveProject(project).then(function () { return switchProject(project.id); }).catch(function (error) {
    state.projects = state.projects.filter(function (item) { return item.id !== project.id; });
    renderProjectNav();
    toast('Project could not be saved: ' + error.message);
  });
}

function cycleProject() {
  if (!state.projects.length) return;
  const current = state.projects.findIndex(function (project) { return project.id === state.activeProjectId; });
  switchProject(state.projects[(current + 1) % state.projects.length].id);
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.activeProjectId) return;
  await persistNow();
  try {
    const [saved, datasets] = await Promise.all([readWorkspace(projectId), listDatasets(projectId)]);
    state.activeProjectId = projectId;
    if (saved) hydrateWorkspaceState(state, saved);
    else resetProjectWorkspace(projectId);
    setLayout(state.layoutPreference === 'auto' ? 'auto' : state.layout, {
      layout: state.layoutPreference === 'auto' ? detectAutomaticLayout() : state.layout,
      syncUrl: true,
      save: false
    });
    state.datasets = (projectId === 'default' ? [DEMO_DATASET] : []).concat(datasets || []);
    if (!state.datasets.some(function (dataset) { return dataset.id === state.activeDatasetId; })) state.activeDatasetId = state.datasets[0]?.id || EMPTY_DATASET.id;
    if (activeDataset().rows?.length) { await ensureDatasetProfile(activeDataset()); workerCacheReady = cacheDatasetForWorker(activeDataset(), true); await workerCacheReady; }
    else await runDataWorker('clearCache', {}).catch(function () {});
    byId('note-input').value = state.notes;
    byId('compact-note').value = state.notes;
    byId('provider-select').value = state.provider;
    byId('sample-consent').checked = state.includeSamples;
    drawing.load(state.strokes, state.canvasView);
    syncNotebookControls();
    renderAll();
    await persistNow();
    toast('Opened ' + (state.projects.find(function (project) { return project.id === projectId; })?.name || 'project') + '.');
  } catch (error) {
    toast('This project could not be opened from local storage.');
    console.error('Project restore failed:', error);
  }
}

function resetProjectWorkspace(projectId) {
  const defaults = createWorkspaceState(DEMO_DATASET);
  state.revision = 0;
  state.activeProjectId = projectId;
  state.activeView = 'overview';
  state.activeDatasetId = projectId === 'default' ? DEMO_DATASET.id : EMPTY_DATASET.id;
  state.chart = defaults.chart;
  state.selectedPoint = null;
  state.activeFilters = [];
  state.conversation = [];
  state.conversationBranchId = 'main';
  state.conversationBranches = { main: [] };
  state.notes = '';
  state.strokes = [];
  state.canvasView = { zoom: 1, panX: 0, panY: 0 };
  state.annotationContext = null;
  state.scrollPositions = {};
  state.tableSearch = '';
  state.tableSort = null;
  state.layout = defaults.layout;
  state.layoutPreference = defaults.layoutPreference;
  state.panelArrangement = defaults.panelArrangement;
  state.panelSizes = { ...defaults.panelSizes };
  state.openPanels = { ...defaults.openPanels };
}

function openDatasetConversation(datasetId) {
  state.conversationBranches[state.conversationBranchId] = state.conversation.slice(-32);
  const branchId = 'dataset-' + datasetId;
  if (!state.conversationBranches[branchId]) state.conversationBranches[branchId] = [];
  state.conversationBranchId = branchId;
  state.conversation = state.conversationBranches[branchId].slice();
}

function switchConversationBranch(branchId) {
  if (!branchId || branchId === state.conversationBranchId) return;
  state.conversationBranches[state.conversationBranchId] = state.conversation.slice(-32);
  state.conversationBranchId = branchId;
  state.conversation = (state.conversationBranches[branchId] || []).slice();
  renderConversation();
  renderCompactHub();
  scheduleSave();
}

function createConversationBranch() {
  state.conversationBranches[state.conversationBranchId] = state.conversation.slice(-32);
  const branchId = 'branch-' + crypto.randomUUID().slice(0, 8);
  state.conversationBranches[branchId] = [];
  state.conversationBranchId = branchId;
  state.conversation = [];
  renderConversationBranches();
  renderConversation();
  scheduleSave();
  byId('question-input').focus();
  toast('New investigation branch opened. Previous branches are still available.');
}

function switchDataset(datasetId) {
  if (!datasetId || datasetId === state.activeDatasetId) return;
  if (!state.datasets.some(function (dataset) { return dataset.id === datasetId; })) return;
  state.activeDatasetId = datasetId;
  state.selectedPoint = null;
  state.activeFilters = [];
  state.annotationContext = null;
  openDatasetConversation(datasetId);
  renderAll();
  scheduleSave();
  if (activeDataset().rows?.length) workerCacheReady = cacheDatasetForWorker(activeDataset(), true).catch(function (error) { console.error('Analysis worker cache failed:', error); });
  else workerCacheReady = runDataWorker('clearCache', {}).catch(function () {});
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
    ? (state.provider === 'auto' ? 'AI available · local calculations' : state.provider + ' · local calculations')
    : 'Local analysis · private by default';
  byId('privacy-hint').textContent = state.includeSamples ? 'Includes up to 5 sample rows' : 'Dataset stays on this device; calculation results are sent for explanation';
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
      byId('search-dialog').close();
      switchDataset(dataset.id);
      setView('data');
    });
    results.append(item);
  });
  state.projects.filter(function (project) { return !query || project.name.toLowerCase().includes(query); }).slice(0, 5).forEach(function (project) {
    const item = document.createElement('div');
    item.className = 'search-result';
    const icon = document.createElement('span');
    icon.textContent = '◫';
    const name = document.createElement('b');
    name.textContent = project.name;
    const label = document.createElement('small');
    label.textContent = 'Project';
    item.append(icon, name, label);
    item.addEventListener('click', function () { byId('search-dialog').close(); switchProject(project.id); });
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

function closeChartMenu() {
  byId('chart-options-menu').classList.add('hidden');
  byId('chart-menu').setAttribute('aria-expanded', 'false');
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
    findings: currentFindings(), chart: state.chart, selectedPoint: state.selectedPoint,
    activeFilters: state.activeFilters, conversation: state.conversation,
    conversationBranches: state.conversationBranches, notes: state.notes,
    strokes: state.strokes, canvasView: state.canvasView, annotationContext: state.annotationContext,
    layout: state.layout, layoutPreference: state.layoutPreference, savedRevision: state.revision
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

async function recoverPreviousRevision() {
  try {
    const revisions = await listWorkspaceRevisions(state.activeProjectId);
    if (revisions.length < 2) return toast('There is no earlier saved revision for this project yet.');
    const previous = revisions[1];
    if (!confirm('Restore the saved workspace from ' + new Date(previous.updatedAt).toLocaleString() + '? Current changes will be kept as a new revision.')) return;
    const latestRevision = revisions[0].revision;
    hydrateWorkspaceState(state, previous);
    state.activeProjectId = previous.projectId || state.activeProjectId;
    setLayout(state.layoutPreference === 'auto' ? 'auto' : state.layout, {
      layout: state.layoutPreference === 'auto' ? detectAutomaticLayout() : state.layout,
      syncUrl: true,
      save: false
    });
    state.revision = latestRevision;
    if (!state.datasets.some(function (dataset) { return dataset.id === state.activeDatasetId; })) state.activeDatasetId = state.datasets[0]?.id || EMPTY_DATASET.id;
    byId('note-input').value = state.notes;
    byId('compact-note').value = state.notes;
    byId('provider-select').value = state.provider;
    byId('sample-consent').checked = state.includeSamples;
    document.body.dataset.theme = state.theme;
    drawing.load(state.strokes, state.canvasView);
    syncNotebookControls();
    renderAll();
    if (activeDataset().rows?.length) workerCacheReady = cacheDatasetForWorker(activeDataset(), true);
    await persistNow();
    toast('Previous workspace revision restored.');
  } catch (error) {
    toast('The previous revision could not be restored: ' + error.message);
  }
}

async function clearWorkspace() {
  if (!confirm('Delete all datasets, notes and analysis history saved by Tessera in this browser?')) return;
  try {
    await clearLocalData();
    Object.assign(state, createWorkspaceState(DEMO_DATASET));
    setLayout('auto', { layout: detectAutomaticLayout(), syncUrl: true, save: false });
    await Promise.all(state.projects.map(saveProject));
    drawing.load(state.strokes, state.canvasView);
    syncNotebookControls();
    byId('note-input').value = '';
    byId('compact-note').value = '';
    document.body.dataset.theme = state.theme;
    byId('provider-select').value = state.provider;
    byId('sample-consent').checked = state.includeSamples;
    byId('settings-dialog').close();
    workerCacheReady = cacheDatasetForWorker(DEMO_DATASET, true);
    renderAll();
    await persistNow();
    toast('Local workspace cleared.');
  } catch (error) {
    toast('The local workspace could not be cleared: ' + error.message);
  }
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
