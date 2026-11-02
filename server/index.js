import { createServer } from 'node:http';
import { readFile, readFileSync, stat } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerWithProvider, configuredProviders } from './providers/index.js';
import { parseXlsxBuffer } from './xlsx.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvironment(path.join(root, '.env'));
const production = process.env.NODE_ENV === 'production';
const staticRoot = production ? path.join(root, 'dist') : root;
const MAX_ASSISTANT_BODY = 180 * 1024;
const MAX_XLSX_BYTES = 50 * 1024 * 1024;
const assistantRequests = new Map();
let successfulAssistantRequests = 0;

const server = createServer(async function (request, response) {
  setSecurityHeaders(response);
  const url = new URL(request.url || '/', 'http://localhost');
  try {
    if (url.pathname === '/api/health' && request.method === 'GET') {
      response.setHeader('Cache-Control', 'no-store');
      return sendJson(response, 200, {
        status: 'ok',
        providers: configuredProviders(),
        assistantRequestsSinceRestart: successfulAssistantRequests
      });
    }
    if (url.pathname === '/api/assistant' && request.method === 'POST') return await handleAssistant(request, response);
    if (url.pathname === '/api/import/xlsx' && request.method === 'POST') return await handleXlsxImport(request, response);
    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'API route not found.' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed.' });
    return serveStatic(url.pathname, request.method, response);
  } catch (error) {
    console.error('Request error:', error.message);
    return sendJson(response, Number.isInteger(error.status) ? error.status : 500, { error: safeMessage(error.message) });
  }
});

async function handleAssistant(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!checkRateLimit(request.socket.remoteAddress || 'unknown')) {
    return sendJson(response, 429, { error: 'Too many assistant requests. Try again in a minute.' });
  }
  const raw = await readBody(request, MAX_ASSISTANT_BODY);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(response, 400, { error: 'Request body must be valid JSON.' }); }
  if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1200) {
    return sendJson(response, 400, { error: 'A question of 1 to 1200 characters is required.' });
  }
  if (!['auto', 'openai', 'anthropic'].includes(body.provider)) {
    return sendJson(response, 400, { error: 'Choose auto, openai or anthropic as the provider.' });
  }
  const context = validateContext(body.context, body.includeSamples === true);
  if (!context) return sendJson(response, 400, { error: 'Analysis context is invalid or too large.' });
  const history = normalizeHistory(body.history);
  if (!history) return sendJson(response, 400, { error: 'Conversation history is invalid.' });
  try {
    const answer = await answerWithProvider({
      requestedProvider: body.provider,
      question: body.question.trim(),
      context,
      history,
      signal: AbortSignal.timeout(45_000)
    });
    successfulAssistantRequests += 1;
    return sendJson(response, 200, answer);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    return sendJson(response, status, { error: status >= 500 ? safeMessage(error.message) : error.message });
  }
}

async function handleXlsxImport(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const raw = await readBody(request, MAX_XLSX_BYTES);
  try {
    const parsed = parseXlsxBuffer(raw);
    return sendJson(response, 200, parsed);
  } catch (error) {
    error.status = 400;
    throw error;
  }
}

function validateContext(value, includeSamples) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profile = value.profile;
  if (!profile || !Array.isArray(profile.columns) || profile.columns.length > 100) return null;
  const columns = profile.columns.map(function (column) {
    if (!column || typeof column.name !== 'string' || column.name.length > 120) return null;
    return {
      name: column.name,
      type: ['number', 'date', 'category', 'boolean', 'empty'].includes(column.type) ? column.type : 'category',
      missing: finiteNonnegative(column.missing),
      distinct: finiteNonnegative(column.distinct),
      mean: finiteOrNull(column.mean),
      min: finiteOrNull(column.min),
      max: finiteOrNull(column.max),
      outliers: finiteNonnegative(column.outliers)
    };
  });
  if (columns.some(function (column) { return !column; })) return null;
  const findings = Array.isArray(value.findings) ? value.findings.slice(0, 8).map(function (finding) {
    if (!finding || typeof finding.title !== 'string' || typeof finding.detail !== 'string') return null;
    return { title: finding.title.slice(0, 180), detail: finding.detail.slice(0, 500), evidence: typeof finding.evidence === 'string' ? finding.evidence.slice(0, 350) : '' };
  }) : [];
  if (findings.some(function (finding) { return !finding; })) return null;
  const context = {
    profile: {
      rowCount: finiteNonnegative(profile.rowCount),
      columnCount: finiteNonnegative(profile.columnCount),
      qualityScore: Math.min(100, finiteNonnegative(profile.qualityScore)),
      columns
    },
    findings,
    chart: sanitizeChart(value.chart),
    selectedPoint: sanitizeSelectedPoint(value.selectedPoint)
  };
  if (includeSamples) {
    if (!Array.isArray(value.sampleRows) || value.sampleRows.length > 5) return null;
    const safeRows = value.sampleRows.map(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length > 40) return null;
      return Object.fromEntries(Object.entries(row).slice(0, 40).map(function (entry) {
        const cell = entry[1];
        return [String(entry[0]).slice(0, 120), typeof cell === 'string' ? cell.slice(0, 400) : (typeof cell === 'number' || typeof cell === 'boolean' || cell === null ? cell : String(cell).slice(0, 100))];
      }));
    });
    if (safeRows.some(function (row) { return !row; })) return null;
    context.sampleRows = safeRows;
  }
  if (JSON.stringify(context).length > 35_000) return null;
  return context;
}

function sanitizeChart(chart) {
  if (!chart || typeof chart !== 'object') return null;
  return { type: String(chart.type || '').slice(0, 30), xColumn: String(chart.x || chart.xColumn || '').slice(0, 120), yColumn: String(chart.y || chart.yColumn || '').slice(0, 120) };
}

function sanitizeSelectedPoint(point) {
  if (!point || typeof point !== 'object') return null;
  return { label: String(point.label || '').slice(0, 150), value: String(point.value || '').slice(0, 60), count: finiteNonnegative(point.count) };
}

function normalizeHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 8) return null;
  const normalized = [];
  for (const item of history) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 1400) return null;
    normalized.push({ role: item.role, content: item.content });
  }
  return normalized;
}

function finiteNonnegative(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }
function finiteOrNull(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null; }

function checkRateLimit(identity) {
  const now = Date.now();
  const requests = (assistantRequests.get(identity) || []).filter(function (time) { return now - time < 60_000; });
  if (requests.length >= 18) return false;
  requests.push(now);
  assistantRequests.set(identity, requests);
  return true;
}

function readBody(request, maxBytes) {
  return new Promise(function (resolve, reject) {
    const declared = Number(request.headers['content-length'] || 0);
    if (declared > maxBytes) return reject(Object.assign(new Error('Upload exceeds the request size limit.'), { status: 413 }));
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', function (chunk) {
      size += chunk.length;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', function () {
      if (tooLarge) reject(Object.assign(new Error('Upload exceeds the request size limit.'), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function serveStatic(urlPath, method, response) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return sendJson(response, 400, { error: 'Invalid URL path.' }); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  const filePath = path.resolve(staticRoot, relative);
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) return sendJson(response, 403, { error: 'Forbidden.' });
  stat(filePath, function (error, info) {
    if (error || !info.isFile()) return sendJson(response, 404, { error: 'File not found.' });
    readFile(filePath, function (readError, data) {
      if (readError) return sendJson(response, 500, { error: 'Could not read this file.' });
      response.statusCode = 200;
      response.setHeader('Content-Type', mimeType(filePath));
      response.setHeader('Cache-Control', path.basename(filePath) === 'service-worker.js' || path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600');
      response.setHeader('Content-Length', data.length);
      response.end(method === 'HEAD' ? undefined : data);
    });
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png',
    '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
  })[ext] || 'application/octet-stream';
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', body.length);
  response.end(body);
}

function safeMessage(message) {
  const safe = String(message || 'The request could not be completed.');
  if (/api[_ -]?key|authorization|bearer|token/i.test(safe)) return 'AI provider request failed. Check server configuration and provider status.';
  return safe.slice(0, 350);
}

function loadEnvironment(filePath) {
  let contents;
  try { contents = readFileSync(filePath, 'utf8'); } catch { return; }
  contents.split(/\r?\n/).forEach(function (line) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) return;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  });
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, function () {
  console.log('Tessera listening at http://' + host + ':' + port + (production ? ' (production mode)' : ''));
});
