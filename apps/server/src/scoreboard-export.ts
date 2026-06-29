import type { CompetitionMode } from "@ballance/contracts";
import type { ScoreboardEntry } from "@ballance/core";
import { createStoredZip } from "./zip.js";

export interface ScoreboardExportInput {
  competitionName: string;
  mode: CompetitionMode;
  version: number;
  generatedAt: string;
  entries: readonly ScoreboardEntry[];
  scoringRules?: readonly { stage: string; rule: string }[];
}

export interface ScoreboardExportBundle {
  basename: string;
  html: string;
  tsv: string;
  csv: string;
  xlsx: Buffer;
}

const xml = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const html = xml;
const csvCell = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
const tsvCell = (value: unknown): string => String(value ?? "").replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ");
const safeName = (value: string): string => [...value.normalize("NFKC")]
  .map((character) => character.charCodeAt(0) < 32 ? "_" : character)
  .join("").replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "competition";

const rowValues = (input: ScoreboardExportInput, entry: ScoreboardEntry): readonly (string | number)[] => {
  const stages = Object.entries(entry.stages).sort(([left], [right]) => left.localeCompare(right)).map(([stageId, result]) =>
    `${stageId}:${result.status === "dnf" ? `DNF(${result.reason ?? ""})` : `#${result.place}/${result.points}`}`).join("; ");
  const status = Object.values(entry.stages).some((result) => result.status === "dnf") ? "DNF" : "有效";
  return [input.mode === "test" ? "测试数据" : "工作数据", entry.rank, entry.displayName, entry.points, entry.change ?? "", status, stages];
};

const headers = ["数据标记", "排名", "选手", "积分", "排名变化", "状态", "轮次结果"] as const;

const inlineCell = (reference: string, value: string | number, style: number): string => typeof value === "number"
  ? `<c r="${reference}" s="${style}"><v>${value}</v></c>`
  : `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;

const columnName = (index: number): string => String.fromCharCode(65 + index);

const workbookFiles = (input: ScoreboardExportInput): Array<{ name: string; data: string }> => {
  const resultRows = input.entries.map((entry, index) => {
    const values = rowValues(input, entry);
    const dnf = values[5] === "DNF";
    const style = dnf ? 5 : index === 0 ? 2 : index === 1 ? 3 : index === 2 ? 4 : 0;
    return `<row r="${index + 2}">${values.map((value, column) => inlineCell(`${columnName(column)}${index + 2}`, value, style)).join("")}</row>`;
  }).join("");
  const ruleRows = (input.scoringRules ?? []).map((rule, index) => `<row r="${index + 2}">${inlineCell(`A${index + 2}`, rule.stage, 0)}${inlineCell(`B${index + 2}`, rule.rule, 0)}</row>`).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="8" customWidth="1"/><col min="3" max="3" width="22" customWidth="1"/><col min="4" max="6" width="12" customWidth="1"/><col min="7" max="7" width="60" customWidth="1"/></cols><sheetData><row r="1">${headers.map((value, index) => inlineCell(`${columnName(index)}1`, value, 1)).join("")}</row>${resultRows}</sheetData></worksheet>`;
  const rules = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData><row r="1">${inlineCell("A1", "轮次", 1)}${inlineCell("B1", "积分规则", 1)}</row>${ruleRows}</sheetData></worksheet>`;
  return [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${input.mode === "test" ? "测试成绩" : "比赛成绩"}" sheetId="1" r:id="rId1"/><sheet name="积分规则" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><strike/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFD700"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC0C0C0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFCD7F32"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
    { name: "xl/worksheets/sheet2.xml", data: rules }
  ];
};

export const createScoreboardExports = (input: ScoreboardExportInput): ScoreboardExportBundle => {
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("INVALID_SCOREBOARD_VERSION");
  const rows = input.entries.map((entry) => rowValues(input, entry));
  const title = `${input.competitionName} — 榜单版本 ${input.version}`;
  const banner = input.mode === "test" ? '<p class="test-watermark">测试数据 · 不得作为正式成绩</p>' : "";
  const tableRows = rows.map((row) => `<tr class="${row[5] === "DNF" ? "dnf" : ""}">${row.map((cell) => `<td>${html(cell)}</td>`).join("")}</tr>`).join("");
  const exportedHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${html(title)}</title><style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.45rem;text-align:left}thead{background:#eee}.test-watermark{color:#a00;font-weight:700}.dnf{text-decoration:line-through}tbody tr:nth-child(1){background:#ffd700}tbody tr:nth-child(2){background:#c0c0c0}tbody tr:nth-child(3){background:#cd7f32}</style></head><body>${banner}<h1>${html(title)}</h1><p>导出时间：${html(input.generatedAt)}</p><table><thead><tr>${headers.map((header) => `<th>${html(header)}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
  const tsv = [headers, ...rows].map((row) => row.map(tsvCell).join("\t")).join("\r\n");
  const csv = `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const xlsx = createStoredZip(workbookFiles(input), new Date(input.generatedAt));
  const stamp = input.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { basename: `${safeName(input.competitionName)}_v${input.version}_${stamp}`, html: exportedHtml, tsv, csv, xlsx };
};
