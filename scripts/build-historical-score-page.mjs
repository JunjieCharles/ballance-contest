import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { renderPublicScorePage } from "../apps/server/dist/public-score-page.js";

const root = resolve(import.meta.dirname, "..");
const source = JSON.parse(await readFile(join(root, "examples/2025-national-day-sr.json"), "utf8"));
if (source.players.length !== 25 || source.players.some(row => row.length !== 5 || row[4].length !== 13 || row[4].some(value => value !== "dnf" && (!Number.isInteger(value) || value < 1 || value > 25)))) {
  throw new Error("历史成绩必须包含 25 位选手、每人 13 关有效名次或 DNF");
}
const cell = (text, style = "plain") => ({ text: String(text), style });
const data = {
  competitionId: source.id, name: source.name, mode: "work", status: "historical", version: 1, sequence: 1,
  generatedAt: new Date().toISOString(),
  headers: ["排名", "变化", "积分", "选手", ...Array.from({ length: 13 }, (_, index) => `SR${index + 1}`)],
  rows: source.players.map(([rank, change, points, name, stages]) => ({ cells: [
    cell(rank), cell(change, change.startsWith("▲") ? "rank-up" : change.startsWith("▼") ? "rank-down" : "plain"), cell(points), cell(name),
    ...stages.map(value => value === "dnf" ? cell("DNF", "dnf") : cell(value, value === 1 ? "gold" : value === 2 ? "silver" : value === 3 ? "bronze" : "plain"))
  ] }))
};
const output = join(root, ".runtime", "historical-score-page");
await mkdir(output, { recursive: true });
await writeFile(join(output, "index.html"), renderPublicScorePage(data), "utf8");
await writeFile(join(output, "data.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(`已生成历史成绩展示：${join(output, "index.html")}（25 位选手 × 13 关，原表积分与并列排名保留）`);
