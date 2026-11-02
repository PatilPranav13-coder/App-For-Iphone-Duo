import { inflateRawSync } from 'node:zlib';
import { normalize as normalizePath, join as joinPath } from 'node:path/posix';

const MAX_ROWS = 250000;
const MAX_UNCOMPRESSED = 180 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function parseXlsxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The workbook is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Excel uploads are limited to 50 MB.');
  const zip = readZipEntries(buffer);
  const workbook = getText(zip, 'xl/workbook.xml');
  const relations = getText(zip, 'xl/_rels/workbook.xml.rels');
  const sheet = workbook.match(/<(?:\w+:)?sheet\b([^>]*?)\/?>/i);
  if (!sheet) throw new Error('No worksheet was found in this workbook.');
  const relationId = getAttribute(sheet[1], 'r:id');
  const relation = relations.match(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/gi)?.find(function (entry) {
    return getAttribute(entry, 'Id') === relationId;
  });
  if (!relation) throw new Error('The first worksheet relationship could not be read.');
  const target = getAttribute(relation, 'Target');
  const sheetPath = normalizePath(target.startsWith('/') ? target.slice(1) : joinPath('xl', target));
  if (sheetPath.startsWith('../') || sheetPath.startsWith('/')) throw new Error('The workbook contains an unsafe sheet path.');
  const sheetXml = getText(zip, sheetPath);
  const sharedStrings = zip.has('xl/sharedStrings.xml') ? parseSharedStrings(getText(zip, 'xl/sharedStrings.xml')) : [];
  const matrix = [];
  const rowPattern = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(sheetXml))) {
    if (matrix.length > MAX_ROWS + 1) throw new Error('This workbook exceeds the 250,000 row limit.');
    const cells = [];
    const cellPattern = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const reference = getAttribute(cellMatch[1], 'r');
      const columnIndex = reference ? columnIndexFromReference(reference) : cells.length;
      if (columnIndex < 0 || columnIndex > 500) throw new Error('The workbook contains an unsupported column position.');
      cells[columnIndex] = readCell(cellMatch[1], cellMatch[2] || '', sharedStrings);
    }
    matrix.push(cells);
  }
  const firstNonempty = matrix.findIndex(function (row) { return row.some(function (value) { return value !== null && value !== undefined && value !== ''; }); });
  if (firstNonempty < 0 || firstNonempty === matrix.length - 1) throw new Error('The first worksheet does not contain both a header and data rows.');
  const headerRow = matrix[firstNonempty];
  const width = Math.max.apply(null, matrix.slice(firstNonempty).map(function (row) { return row.length; }));
  const columns = uniqueHeaders(Array.from({ length: width }, function (_, index) { return headerRow[index]; }));
  const rows = [];
  for (let i = firstNonempty + 1; i < matrix.length; i += 1) {
    const values = matrix[i];
    if (!values || !values.some(function (value) { return value !== null && value !== undefined && value !== ''; })) continue;
    const record = {};
    columns.forEach(function (column, index) { record[column] = values[index] ?? null; });
    rows.push(record);
  }
  if (rows.length > MAX_ROWS) throw new Error('This workbook exceeds the 250,000 row limit.');
  return { rows, columns };
}

function readZipEntries(buffer) {
  const start = Math.max(0, buffer.length - 65557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('This file is not a valid XLSX workbook.');
  const count = buffer.readUInt16LE(endOffset + 10);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (count > 5000 || directoryOffset >= buffer.length) throw new Error('This workbook has an unsupported ZIP directory.');
  const files = new Map();
  let offset = directoryOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The workbook ZIP directory is damaged.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > buffer.length) throw new Error('The workbook ZIP directory is truncated.');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (flags & 1) throw new Error('Encrypted Excel workbooks are not supported.');
    totalSize += uncompressedSize;
    if (totalSize > MAX_UNCOMPRESSED) throw new Error('This workbook expands beyond the 180 MB safety limit.');
    if (!name.endsWith('/')) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('A workbook file entry is damaged.');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length) throw new Error('A workbook file entry is truncated.');
      const compressed = buffer.subarray(dataStart, dataEnd);
      let data;
      if (method === 0) data = compressed;
      else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED });
      else throw new Error('This workbook uses a ZIP compression method that is not supported.');
      if (data.length !== uncompressedSize) throw new Error('A workbook file entry has an invalid uncompressed size.');
      files.set(normalizePath(name), data.toString('utf8'));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function parseSharedStrings(xml) {
  return Array.from(xml.matchAll(/<(?:\w+:)?si\b[\s\S]*?<\/(?:\w+:)?si>/gi), function (match) {
    return Array.from(match[0].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi), function (item) { return decodeXml(item[1]); }).join('');
  });
}

function readCell(attributes, content, sharedStrings) {
  const type = getAttribute(attributes, 't');
  if (type === 'inlineStr') {
    return Array.from(content.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi), function (match) { return decodeXml(match[1]); }).join('');
  }
  const valueMatch = content.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/i);
  if (!valueMatch) return null;
  const value = decodeXml(valueMatch[1]);
  if (type === 's') return sharedStrings[Number(value)] ?? null;
  if (type === 'b') return value === '1';
  if (type === 'str' || type === 'e') return value;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}

function uniqueHeaders(values) {
  const used = new Map();
  return values.map(function (raw, index) {
    const base = raw === null || raw === undefined || raw === '' ? 'Column ' + (index + 1) : String(raw);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : base + ' (' + count + ')';
  });
}

function columnIndexFromReference(reference) {
  const letters = reference.match(/^\$?([A-Z]+)/i)?.[1]?.toUpperCase();
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function getText(files, path) {
  const value = files.get(normalizePath(path));
  if (value === undefined) throw new Error('The workbook is missing ' + path + '.');
  return value;
}

function getAttribute(attributes, name) {
  const escaped = name.replace(':', '\\:');
  const match = attributes.match(new RegExp('(?:^|\\s)' + escaped + '="([^"]*)"', 'i'));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (_match, entity) {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
