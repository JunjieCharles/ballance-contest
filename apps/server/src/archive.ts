import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CompetitionMode } from "@ballance/contracts";
import type { ScoreboardExportBundle } from "./scoreboard-export.js";
import { createStoredZip, type ZipEntry } from "./zip.js";

export interface ArchiveSourceFile {
  sourcePath: string;
  archivePath?: string;
  kind: "log" | "record" | "evidence";
}

export interface ArchiveRequest {
  dataRoot: string;
  sourceRoot: string;
  competition: { id: string; name: string; mode: CompetitionMode; timezone: string };
  version: number;
  generatedAt: string;
  applicationVersion: string;
  parserVersion: string;
  mockClientVersion: string;
  sourceFiles: readonly ArchiveSourceFile[];
  records: Readonly<Record<string, unknown>>;
  exports: ScoreboardExportBundle;
}

export interface ArchiveManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  kind: string;
}

export interface ArchiveManifest {
  schemaVersion: 1;
  archiveId: string;
  archiveVersion: number;
  competitionId: string;
  competitionName: string;
  mode: CompetitionMode;
  testData: boolean;
  timezone: string;
  generatedAt: string;
  applicationVersion: string;
  parserVersion: string;
  mockClientVersion: string;
  files: readonly ArchiveManifestFile[];
}

export interface CreatedArchive {
  directory: string;
  packagePath: string;
  manifest: ArchiveManifest;
  manifestHash: string;
}

const hash = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const safeSegment = (value: string): string => [...value.normalize("NFKC")]
  .map((character) => character.charCodeAt(0) < 32 ? "_" : character)
  .join("").replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "unnamed";
const normalized = (path: string): string => resolve(path).toLocaleLowerCase("en-US");
const inside = (root: string, candidate: string): boolean => {
  const normalizedRoot = normalized(root);
  const normalizedCandidate = normalized(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep.toLocaleLowerCase("en-US")}`);
};
const safeArchivePath = (path: string): string => {
  const replaced = path.replaceAll("\\", "/");
  if (!replaced || replaced.startsWith("/") || replaced.split("/").some((segment) => segment === ".." || !segment)) throw new Error("INVALID_ARCHIVE_PATH");
  return replaced.split("/").map(safeSegment).join("/");
};

export const createCompetitionArchive = (request: ArchiveRequest): CreatedArchive => {
  if (!Number.isInteger(request.version) || request.version < 1) throw new Error("INVALID_ARCHIVE_VERSION");
  const sourceRoot = realpathSync(request.sourceRoot);
  const modeRoot = join(resolve(request.dataRoot), request.competition.mode);
  const competitionRoot = join(modeRoot, safeSegment(request.competition.id));
  const archiveRoot = join(competitionRoot, "archive");
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = request.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const folderName = `v${request.version}-${stamp}`;
  const finalDirectory = join(archiveRoot, folderName);
  const packagePath = `${finalDirectory}.zip`;
  if (existsSync(finalDirectory) || existsSync(packagePath)) throw new Error("ARCHIVE_VERSION_EXISTS");
  const temporaryDirectory = join(archiveRoot, `.building-${randomUUID()}`);
  const temporaryPackage = `${temporaryDirectory}.zip`;
  mkdirSync(temporaryDirectory, { recursive: true });
  const kinds = new Map<string, string>();
  try {
    for (const file of request.sourceFiles) {
      const source = realpathSync(file.sourcePath);
      if (!inside(sourceRoot, source) || !statSync(source).isFile()) throw new Error("ARCHIVE_SOURCE_OUTSIDE_ROOT");
      const defaultFolder = file.kind === "log" ? "logs" : file.kind === "record" ? "records" : "evidence";
      const archivePath = safeArchivePath(file.archivePath ?? `${defaultFolder}/${basename(source)}`);
      const destination = join(temporaryDirectory, ...archivePath.split("/"));
      if (!inside(temporaryDirectory, destination)) throw new Error("INVALID_ARCHIVE_PATH");
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      kinds.set(archivePath, file.kind);
    }
    for (const [recordPath, value] of Object.entries(request.records)) {
      const archivePath = safeArchivePath(recordPath);
      const destination = join(temporaryDirectory, ...archivePath.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      kinds.set(archivePath, "metadata");
    }
    const exportFiles: Array<[string, Buffer | string]> = [
      [`exports/${request.exports.basename}.csv`, request.exports.csv],
      [`exports/${request.exports.basename}.xlsx`, request.exports.xlsx]
    ];
    for (const [archivePath, data] of exportFiles) {
      const destination = join(temporaryDirectory, ...archivePath.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, data);
      kinds.set(archivePath, "export");
    }
    const files = [...kinds].map(([path, kind]) => {
      const data = readFileSync(join(temporaryDirectory, ...path.split("/")));
      return { path, bytes: data.length, sha256: hash(data), kind };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const manifest: ArchiveManifest = {
      schemaVersion: 1, archiveId: randomUUID(), archiveVersion: request.version,
      competitionId: request.competition.id, competitionName: request.competition.name,
      mode: request.competition.mode, testData: request.competition.mode === "test", timezone: request.competition.timezone,
      generatedAt: request.generatedAt, applicationVersion: request.applicationVersion,
      parserVersion: request.parserVersion, mockClientVersion: request.mockClientVersion, files
    };
    const manifestData = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestHash = hash(manifestData);
    writeFileSync(join(temporaryDirectory, "manifest.json"), manifestData, "utf8");
    writeFileSync(join(temporaryDirectory, "manifest.sha256"), `${manifestHash}  manifest.json\n`, "utf8");
    const zipEntries: ZipEntry[] = [
      ...files.map((file) => ({ name: file.path, data: readFileSync(join(temporaryDirectory, ...file.path.split("/"))) })),
      { name: "manifest.json", data: manifestData },
      { name: "manifest.sha256", data: `${manifestHash}  manifest.json\n` }
    ];
    writeFileSync(temporaryPackage, createStoredZip(zipEntries, new Date(request.generatedAt)));
    renameSync(temporaryDirectory, finalDirectory);
    renameSync(temporaryPackage, packagePath);
    for (const file of files) chmodSync(join(finalDirectory, ...file.path.split("/")), 0o444);
    chmodSync(join(finalDirectory, "manifest.json"), 0o444);
    chmodSync(join(finalDirectory, "manifest.sha256"), 0o444);
    chmodSync(packagePath, 0o444);
    return { directory: finalDirectory, packagePath, manifest, manifestHash };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    rmSync(temporaryPackage, { force: true });
    throw error;
  }
};

export const copyArchiveVersion = (source: string, destination: string): void => {
  if (existsSync(destination)) throw new Error("ARCHIVE_VERSION_EXISTS");
  cpSync(source, destination, { recursive: true, errorOnExist: true });
};

export const relativeArchivePath = (dataRoot: string, archivePath: string): string => relative(resolve(dataRoot), resolve(archivePath)).replaceAll("\\", "/");
