# Ballance 比赛控制台

Ballance 比赛控制台是一个本地运行的裁判工具，用于托管 BallanceMMO MockClient、控制比赛流程、播放测试场景、验证计分与导出比赛数据。

当前版本：`0.1.0-dev`

## 核心概念

系统只保留两种模式：

- `work` 工作模式：面向正式比赛。由本服务托管真实 MockClient，使用真实进程、真实命令队列和本机单调时钟。
- `test` 测试模式：面向演练、回归和故障注入。使用假 MockClient、虚拟时钟、人工维护场景和只读日志输入，不联网、不启动真实 MockClient、不发送真实命令。

日志播放是测试模式能力之一，不是独立运行模式。`2025-grandprix-sr1-13` 只作为历史参考资料，不作为默认 CI 或发布门禁。

## 快速使用：Windows 便携包

便携包适合正式使用或无 Node.js 环境的干净 Windows 机器。

1. 解压或复制 `dist/portable/BallanceContestConsole`。
2. 双击 `Start-ContestConsole.cmd`。
3. 浏览器会打开本机控制台地址，形如：

   ```text
   http://127.0.0.1:32113/#token=...
   ```

4. 数据默认写入：

   ```text
   %LOCALAPPDATA%\BallanceContestConsole
   ```

服务只监听 `127.0.0.1:32113`。如果端口被未知进程占用，程序会失败退出，不会自动终止未知进程。

## 从源码运行

### 环境要求

- Node.js `>=24.18.0 <25`
- npm
- Windows 环境用于工作模式、MockClient 管道和便携包验证
- Edge 或 Chrome 用于端到端测试

安装依赖：

```powershell
npm ci
```

构建全部包：

```powershell
npm run build
```

启动本地服务：

```powershell
npm run start -w @ballance/server
```

终端会输出带 token 的控制台地址。复制该地址到浏览器打开即可。

开发模式会同时启动后端和前端开发服务，并保护性替换同一个工作区启动的旧开发实例：

```powershell
npm run dev
```

如果 `node` 不在系统 `PATH`，可以使用本地便携 Node，例如：

```powershell
$env:PATH = "$PWD\.tools\node-v24.18.0-win-x64;$env:PATH"
npm run build
```

## 基本操作流程

### 测试模式

1. 打开控制台。
2. 新建比赛，模式选择“测试模式”。
3. 粘贴人工维护的 `ScenarioDefinition`。示例：

   ```text
   test/fixtures/scenarios/three-stage-main/scenario.json
   ```

4. 点击“创建测试运行”。
5. 使用“逐事件”“播放到底”“重置”验证日志事件、尝试、榜单版本和异常。
6. 导出或归档时，产物会标注测试数据。

测试模式适合验证：

- 权威 Go 与练习成绩排除
- SR/HS 计分与同分
- Ready 掉线和稳定在线窗口
- cheat DNF
- 重赛确认
- 命令不确定
- 恢复、观察缺口和只读日志输入

### 工作模式

1. 确认 `server-windows/` 下存在 BallanceMMO 运行文件，尤其是 `BallanceMMOMockClient.exe` 及其 DLL。
2. 新建比赛，模式选择“工作模式”。
3. 由控制台托管真实 MockClient，并通过串行命令队列等待服务器回显。
4. 关键命令如果没有确认回显，会进入不确定状态，不会自动重试。

工作模式不提供正式外部日志观察入口，也没有独立回放模式。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 contracts、core、testkit、server 和 web |
| `npm run dev` | 启动开发服务 |
| `npm run lint` | 运行 ESLint |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm test` | 运行全部 Vitest 测试 |
| `npx vitest run test` | 只运行 `test/` 下的集中回归 |
| `npm run test:e2e` | 构建后运行 Playwright 端到端测试 |
| `npm run test:mock-client` | 验证真实 MockClient 管道 |
| `npm run test:portable` | 验证便携包 |
| `npm run package:portable` | 生成 Windows 便携包 |

## 打包便携版

打包前需要：

- 已完成 `npm run build`
- `server-windows/` 下有 MockClient 及依赖 DLL
- 有 Node 24 运行时目录，默认位置为 `.tools/node-v24.18.0-win-x64`

生成便携包：

```powershell
npm run package:portable
```

输出目录：

```text
dist/portable/BallanceContestConsole
```

包内包含：

- `runtime/node.exe`
- 后端和前端构建产物
- `server-windows/` MockClient 文件
- `Start-ContestConsole.cmd`
- 第三方许可证和关键文件 SHA-256 清单

## 项目结构

```text
apps/
  server/       Fastify 本机 API、会话、归档、MockClient 适配
  web/          React 控制台界面
packages/
  contracts/   前后端共享类型、能力模型、场景契约
  core/        领域模型、计分、身份、状态机、修订
  testkit/     虚拟时钟和场景运行器
test/
  fixtures/    人工维护夹具和历史参考资料
  unit/        集中单元回归
  integration/ 集中集成回归
  e2e/         Playwright 浏览器旅程
  nonfunctional/ 长时、确定性和发布相关测试
docs/          需求、规则、进展跟踪
scripts/       开发、打包和验证脚本
server-windows/ BallanceMMO Windows 文件
```

## 重要文档

- [后端需求](docs/contest-console-backend-requirements.md)
- [前端需求](docs/contest-console-frontend-requirements.md)
- [测试用例设计](test/docs/test-case-design.md)
- [开发进展](docs/development-progress.md)
- [比赛规则](docs/rule.md)
- [MockClient 本地说明](server-windows/README.md)

## 安全与边界

- 服务只绑定本机 `127.0.0.1:32113`。
- 控制台通过启动 token 建立本机会话。
- 同一时间只有一个标签页拥有控制权，其他标签页默认只读。
- 测试模式必须无真实副作用：不联网、不启动真实进程、不发送真实命令、不写回输入日志目录。
- 工作与测试数据在归档和导出中明确区分，测试数据不得混入正式产物。
