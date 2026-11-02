export const WORKSPACE_SCHEMA_VERSION = 2;

export function createWorkspaceState(demoDataset) {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: 0,
    activeView: 'overview',
    activeDatasetId: demoDataset.id,
    datasets: [demoDataset],
    projects: [
      { id: 'default', name: 'Q3 revenue review', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'retention', name: 'Customer retention', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'research', name: 'Product research', createdAt: '2026-01-01T00:00:00.000Z' }
    ],
    activeProjectId: 'default',
    chart: { type: 'line', x: 'Month', y: 'Revenue', zoom: 1, offset: 0 },
    selectedPoint: null,
    activeFilters: [],
    conversation: [],
    conversationBranchId: 'main',
    conversationBranches: { main: [] },
    notes: '',
    strokes: [],
    canvasView: { zoom: 1, panX: 0, panY: 0 },
    notebookTool: 'pen',
    notebookColor: '#5146e5',
    notebookWidth: 3,
    annotationContext: null,
    provider: 'auto',
    includeSamples: false,
    theme: 'light',
    layout: 'studio',
    layoutPreference: 'auto',
    panelArrangement: 'chart-assistant',
    panelSizes: { navigation: 228, inspector: 360 },
    openPanels: { navigation: true, inspector: true },
    scrollPositions: {},
    tableSearch: '',
    tableSort: null,
    aiStatus: null
  };
}

export function hydrateWorkspaceState(state, saved) {
  if (!saved || typeof saved !== 'object') return state;
  const chart = saved.chart && typeof saved.chart === 'object' ? saved.chart : {};
  const filterList = Array.isArray(saved.activeFilters) ? saved.activeFilters.filter(function (filter) {
    return filter && typeof filter.column === 'string' && filter.column.length <= 120 && filter.operator === 'equals' && typeof filter.value === 'string' && filter.value.length <= 200;
  }).slice(0, 20) : [];
  const panelSizes = saved.panelSizes && typeof saved.panelSizes === 'object' ? saved.panelSizes : {};
  const safeSize = function (value, fallback, min, max) { return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback; };
  const chartType = ['line', 'bar', 'area', 'scatter', 'histogram', 'donut'].includes(chart.type) ? chart.type : state.chart.type;
  Object.assign(state, {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    revision: Number.isInteger(saved.revision) ? saved.revision : 0,
    activeView: saved.activeView || 'overview',
    activeDatasetId: saved.activeDatasetId || state.activeDatasetId,
    activeProjectId: saved.projectId || saved.activeProjectId || state.activeProjectId,
    chart: {
      ...state.chart,
      type: chartType,
      x: typeof chart.x === 'string' ? chart.x.slice(0, 120) : state.chart.x,
      y: typeof chart.y === 'string' ? chart.y.slice(0, 120) : state.chart.y,
      zoom: safeSize(chart.zoom, 1, 1, 8),
      offset: safeSize(chart.offset, 0, 0, 1)
    },
    selectedPoint: saved.selectedPoint || null,
    activeFilters: filterList,
    conversation: Array.isArray(saved.conversation) ? saved.conversation.slice(-32) : [],
    conversationBranchId: saved.conversationBranchId || 'main',
    conversationBranches: saved.conversationBranches && typeof saved.conversationBranches === 'object' ? saved.conversationBranches : { main: [] },
    notes: typeof saved.notes === 'string' ? saved.notes : '',
    strokes: Array.isArray(saved.strokes) ? saved.strokes : [],
    canvasView: { ...state.canvasView, ...(saved.canvasView || {}) },
    notebookTool: ['pen', 'highlighter', 'eraser', 'lasso', 'pan', 'line', 'arrow', 'rectangle', 'ellipse'].includes(saved.notebookTool) ? saved.notebookTool : 'pen',
    notebookColor: /^#[0-9a-f]{6}$/i.test(saved.notebookColor || '') ? saved.notebookColor : '#5146e5',
    notebookWidth: Number.isFinite(Number(saved.notebookWidth)) ? Math.max(1, Math.min(12, Number(saved.notebookWidth))) : 3,
    annotationContext: saved.annotationContext || null,
    provider: ['auto', 'openai', 'anthropic'].includes(saved.provider) ? saved.provider : 'auto',
    includeSamples: Boolean(saved.includeSamples),
    theme: saved.theme === 'dark' ? 'dark' : 'light',
    layout: ['compact', 'focus', 'studio'].includes(saved.layout) ? saved.layout : state.layout,
    layoutPreference: ['auto', 'compact', 'focus', 'studio'].includes(saved.layoutPreference) ? saved.layoutPreference : (saved.layout || 'auto'),
    panelArrangement: saved.panelArrangement === 'assistant-chart' ? 'assistant-chart' : 'chart-assistant',
    panelSizes: {
      navigation: safeSize(panelSizes.navigation, 238, 180, 300),
      inspector: safeSize(panelSizes.inspector, 360, 280, 520)
    },
    openPanels: { ...state.openPanels, ...(saved.openPanels || {}) },
    scrollPositions: saved.scrollPositions && typeof saved.scrollPositions === 'object' ? saved.scrollPositions : {},
    tableSearch: typeof saved.tableSearch === 'string' ? saved.tableSearch.slice(0, 200) : '',
    tableSort: saved.tableSort && typeof saved.tableSort.key === 'string' && ['asc', 'desc'].includes(saved.tableSort.direction)
      ? { key: saved.tableSort.key.slice(0, 120), direction: saved.tableSort.direction }
      : null
  });
  return state;
}

export function workspaceSnapshot(state) {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    projectId: state.activeProjectId,
    activeView: state.activeView,
    activeDatasetId: state.activeDatasetId,
    chart: { ...state.chart },
    selectedPoint: state.selectedPoint,
    activeFilters: state.activeFilters.slice(0, 20),
    conversation: state.conversation.slice(-32),
    conversationBranchId: state.conversationBranchId,
    conversationBranches: state.conversationBranches,
    notes: state.notes,
    strokes: state.strokes,
    canvasView: { ...state.canvasView },
    notebookTool: state.notebookTool,
    notebookColor: state.notebookColor,
    notebookWidth: state.notebookWidth,
    annotationContext: state.annotationContext,
    provider: state.provider,
    includeSamples: state.includeSamples,
    theme: state.theme,
    layout: state.layout,
    layoutPreference: state.layoutPreference,
    panelArrangement: state.panelArrangement,
    panelSizes: { ...state.panelSizes },
    openPanels: { ...state.openPanels },
    scrollPositions: { ...state.scrollPositions },
    tableSearch: state.tableSearch,
    tableSort: state.tableSort ? { ...state.tableSort } : null,
    revision: state.revision
  };
}
