import {
  createScoreboardTable,
  type CompetitionMode,
  type ScoreboardTableCellStyle,
  type ScoreboardTableEntry,
  type ScoreboardTableModel
} from "@ballance/contracts";
import { createStoredZip } from "./zip.js";

export interface ScoreboardExportInput {
  competitionName: string;
  mode: CompetitionMode;
  version: number;
  generatedAt: string;
  entries: readonly ScoreboardTableEntry[];
  stages: readonly { id: string; label: string }[];
}

export interface ScoreboardExportBundle {
  basename: string;
  table: ScoreboardTableModel;
  csv: string;
  xlsx: Buffer;
}

const xml = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const csvCell = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
const safeName = (value: string): string => [...value.normalize("NFKC")]
  .map((character) => character.charCodeAt(0) < 32 ? "_" : character)
  .join("").replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "competition";

const columnName = (index: number): string => {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
};

const cellStyleIndex: Record<ScoreboardTableCellStyle, number> = {
  plain: 0,
  gold: 2,
  silver: 3,
  bronze: 4,
  dnf: 5,
  excluded: 6,
  "rank-up": 7,
  "rank-down": 8
};

const inlineCell = (reference: string, value: string, style: number): string =>
  `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;

const workbookFiles = (input: ScoreboardExportInput, table: ScoreboardTableModel): Array<{ name: string; data: string }> => {
  const resultRows = table.rows.map((row, index) => `<row r="${index + 2}">${row.cells.map((cell, column) =>
    inlineCell(`${columnName(column)}${index + 2}`, cell.text, cellStyleIndex[cell.style])).join("")}</row>`).join("");
  const columns = table.headers.map((_header, index) => {
    const width = index === 0 ? 10 : index === 1 ? 8 : index === 2 ? 10 : index === 3 ? 22 : 18;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData><row r="1">${table.headers.map((value, index) => inlineCell(`${columnName(index)}1`, value, 1)).join("")}</row>${resultRows}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><strike/><color rgb="FF727A84"/><sz val="11"/><name val="Calibri"/></font><font><strike/><color rgb="FF8A2935"/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFB51F2C"/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF1D7A43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F4"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFB700"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE1B2"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF0F1"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  return [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${input.mode === "test" ? "测试成绩" : "工作成绩"}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet }
  ];
};

export const createScoreboardExports = (input: ScoreboardExportInput): ScoreboardExportBundle => {
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("INVALID_SCOREBOARD_VERSION");
  const table = createScoreboardTable(input.stages, input.entries);
  const values = [table.headers, ...table.rows.map((row) => row.cells.map((cell) => cell.text))];
  const csv = `\ufeff${values.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const xlsx = createStoredZip(workbookFiles(input, table), new Date(input.generatedAt));
  const stamp = input.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { basename: `${safeName(input.competitionName)}_${input.mode}_v${input.version}_${stamp}`, table, csv, xlsx };
};
