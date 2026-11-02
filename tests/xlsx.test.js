import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseXlsxBuffer } from '../server/xlsx.js';

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(value);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    locals.push(local, fileName, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

test('XLSX reader uses the first sheet and resolves shared strings and typed cells', function () {
  const workbook = '<workbook xmlns:r="urn:r"><sheets><sheet name="Orders" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const shared = '<sst><si><t>Region</t></si><si><t>Revenue</t></si><si><t>West</t></si><si><t>East</t></si></sst>';
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>125.5</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>';
  const workbookZip = makeZip({
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': rels,
    'xl/sharedStrings.xml': shared,
    'xl/worksheets/sheet1.xml': sheet
  });
  const result = parseXlsxBuffer(workbookZip);
  assert.deepEqual(result.columns, ['Region', 'Revenue']);
  assert.deepEqual(result.rows, [{ Region: 'West', Revenue: 125.5 }, { Region: 'East', Revenue: true }]);
});

test('XLSX reader rejects files that are not workbooks', function () {
  assert.throws(function () { parseXlsxBuffer(Buffer.from('not a workbook')); }, /valid XLSX/);
});
