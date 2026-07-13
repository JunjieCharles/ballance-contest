---
name: release-publish
description: Prepare a Ballance Contest Console release only when the user explicitly invokes this skill or clearly asks to create a release/tag/artifact. Use for adding a release git tag, building and validating the Windows portable package, creating a zip archive that excludes .mock-client-uuid, drafting Chinese release notes, and stopping before the user manually uploads and publishes the GitHub release. Do not use for normal development, routine gates, ordinary portable smoke tests, or regular commits.
---

# Release Publish

## Guardrail

Use this skill only for an explicit release request. Do not run it automatically at the end of development, testing, packaging, or documentation work.

Before doing any release action, confirm the requested version/tag if it is not already explicit. Never push tags, upload artifacts, or publish a GitHub release unless the user separately asks for that exact remote action.

## Workflow

1. Inspect repository state:
   - Run `git status --short`.
   - Stop if there are uncommitted changes unrelated to the release, unless the user explicitly asks to include them.
   - Identify the version/tag, normally a `v...` tag supplied by the user.

2. Run release gates from the repo root with the repo-local Node toolchain when needed:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run test:e2e`
   - `npm run test:mock-client`
   - `npm run package:portable`
   - `npm run test:portable`

3. Create the tag locally after gates pass:
   - Prefer an annotated tag: `git tag -a <tag> -m "<tag>"`.
   - Do not overwrite an existing tag.
   - Do not push the tag unless the user explicitly asks.

4. Build the release zip from `dist/portable/BallanceContestConsole`:
   - Ensure `npm run package:portable` has just produced the package.
   - Exclude `.mock-client-uuid` from the archive.
   - Suggested output path: `dist/releases/BallanceContestConsole-<tag>-windows-portable.zip`.
   - Use a PowerShell archive command that filters the source tree before compression, for example:

```powershell
$tag = "<tag>"
if ($tag -notmatch '^[A-Za-z0-9._-]+$') { throw "Unsafe tag for artifact path: $tag" }
$package = Resolve-Path "dist/portable/BallanceContestConsole"
$releaseDir = "dist/releases"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$zip = Join-Path $releaseDir "BallanceContestConsole-$tag-windows-portable.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
$stageRoot = Join-Path ".runtime/release-staging" $tag
$stage = Join-Path $stageRoot "BallanceContestConsole"
if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -Path (Join-Path $package "*") -Destination $stage -Recurse -Force
Get-ChildItem -LiteralPath $stage -Recurse -Force -Filter ".mock-client-uuid" | Remove-Item -Force
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
```

5. Verify the zip:
   - Confirm `.mock-client-uuid` is absent from the archive.
   - Record the zip path, size, and SHA-256.
   - Prefer:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath $zip
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $zip))
try {
  if ($archive.Entries.FullName -match '(^|/)\.mock-client-uuid$') { throw ".mock-client-uuid leaked into release zip" }
} finally {
  $archive.Dispose()
}
```

6. Generate release documentation:
   - Create or update `docs/releases/<tag>.md`.
   - Write the document in Chinese.
   - Include: tag, commit SHA, date, gate results, portable zip path, SHA-256, notable changes, known limits, and manual publish checklist.
   - Do not claim formal tournament readiness unless target-server rehearsal is recorded.
   - Treat `docs/releases/` as an ignored local release-notes workspace unless the user explicitly asks to track a release document.

7. Stop for manual publication:
   - Tell the user to manually upload the zip and publish the release.
   - Provide the local tag name, Chinese release doc path, zip path, and SHA-256.
   - Mention that the tag has not been pushed and the release has not been published unless those actions were explicitly requested and completed.

## Release Document Template

```markdown
# <tag> 发布说明

- Tag：`<tag>`
- 提交：`<full-sha>`
- 日期：`<YYYY-MM-DD>`
- 便携包：`<zip-path>`
- SHA-256：`<hash>`

## 验证

- `npm run lint`：通过
- `npm run typecheck`：通过
- `npm test`：通过
- `npm run build`：通过
- `npm run test:e2e`：通过
- `npm run test:mock-client`：通过
- `npm run package:portable`：通过
- `npm run test:portable`：通过

## 主要变化

- ...

## 已知限制

- 除非另有现场验收记录，否则正式赛事可用性仍需要目标服务器彩排确认。

## 手动发布清单

- 将 `<zip-path>` 上传到 release 页面。
- 使用本文档内容发布 release notes。
- 仅在确认 release 可以公开时推送 `<tag>`。
- 手动发布 GitHub release。
```
