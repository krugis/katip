// SPDX-License-Identifier: AGPL-3.0-only
// The user import file (LLD-04 §2): RFC 4180, as Excel writes it. Excel on a Turkish system
// separates with semicolons and may add a byte order mark, so both are accepted.

export interface CsvRow {
  /** Line in the file, counting the header as 1, for error messages. */
  row: number;
  values: Record<string, string>;
}

function parseRecords(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === separator) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error('a quoted value is not closed');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Rows as maps of lower-case column names. Blank lines are skipped. */
export function parseCsv(input: string): { columns: string[]; rows: CsvRow[] } {
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const records = parseRecords(text, separator);
  const header = records[0];
  if (!header) return { columns: [], rows: [] };
  const columns = header.map((c) => c.trim().toLowerCase());
  const rows: CsvRow[] = [];
  records.slice(1).forEach((record, i) => {
    if (record.every((v) => v.trim() === '')) return;
    const values: Record<string, string> = {};
    columns.forEach((c, j) => {
      values[c] = (record[j] ?? '').trim();
    });
    rows.push({ row: i + 2, values });
  });
  return { columns, rows };
}
