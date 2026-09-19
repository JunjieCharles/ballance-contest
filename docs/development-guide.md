# 开发与验证指南

本文件保存工具链、测试隔离、Windows 进程和便携验证的具体操作约束。比赛行为以[后端需求](contest-console-backend-requirements.md)和[前端需求](contest-console-frontend-requirements.md)为原文；实现及现场证据见[开发进展](development-progress.md)。按当前任务读取相关章节，不要求每次执行全部门禁。

## 工具链与测试隔离

- Windows PowerShell 向 Node 等进程通过管道传递含中文脚本时，先把本次命令的 `$OutputEncoding` 设为 UTF-8；读文件显式使用 UTF-8，写后核对中文差异。调用 npm 使用 `npm.cmd`，避免误触 `npm.ps1` 的脚本执行策略。
- npm 默认用户缓存目录不可写时，仅为当前命令设置 `npm_config_cache` 到工作区 `.runtime/npm-cache` 后重试；不要修改全局 npm 配置或为缓存写入扩大用户目录权限。
- E2E 使用独立 `BALLANCE_DATA_ROOT`，不得写入 `%LOCALAPPDATA%\BallanceContestConsole` 的用户数据。
- Playwright 临时产物写入 `.runtime/playwright-results`；不要在根目录保留 `test-results/`。
- ESLint 必须显式忽略整个 `.runtime/`；Flat Config 不会自动采用 `.gitignore`，否则 release staging、Playwright 或归档分析中的压缩 bundle 会制造大量假 lint 错误。不得为通过 lint 删除用户的忽略产物。
- 自动化测试不得复用正在供用户操作的控制台实例，也不得删除未经确认的用户数据。
- 浏览器 E2E 必须启动独立测试实例；正式 `38623` 已被用户实例占用时，使用显式受信任的测试专用端口和独立数据根，不得停止、复用或覆盖该实例。测试专用端口不得改变正式启动固定 `38623` 的约束。
- Windows 下 Playwright 测试服务由 `globalSetup` 在主 runner 内启动，并由返回的 teardown 直接 `await app.close()`；不得改回 `webServer` 的 shell 子进程模式。当前 Playwright 在 Windows 会退化为无界同步 `taskkill /T /F`，既不能触发服务的 graceful signal handler，也可能让门禁永久停在清理阶段。
- 删除测试数据前，必须解析绝对路径并确认它位于预期工作区或专用临时目录。
- 拆分运行时或命令服务时必须逐项对照原构造参数和定时语义，尤其是命令超时选择器、状态变更回调位置、驱动周期、运行实例身份校验以及零人 `list` 的立即收口；不能只凭类型检查判断行为等价。
- 测试中启用工作或测试自动化会启动实时驱动定时器；关闭临时 SQLite 或删除测试数据前必须先关闭 `CompetitionService`，并把 Vitest 报告的测试结束后未处理异常视为门禁失败，不能因断言全部通过而忽略。
- 白盒测试不得继续穿透已经移出的旧私有 Map；应直接通过新模块的窄公开端口构造运行时、注入日志和驱动时钟，并保留 API、恢复和浏览器旅程作为跨模块回归。
- Vitest 并行 worker 数必须受控，避免 Windows/原生 SQLite 组合下因提交内存峰值导致 worker OOM；出现 `ERR_IPC_CHANNEL_CLOSED`、worker OOM 或未处理拒绝时整轮门禁按失败处理，不能只根据已打印的绿色断言判定通过。
- Vitest 覆盖率使用与当前 Vitest 完全匹配的 `@vitest/coverage-v8` provider，并启用 `all` 纳入未被导入的生产源码；升级 Vitest 时必须同步 provider 版本。覆盖率只代表 Vitest 单元、集成和非功能测试，不得把 Playwright、真实 MockClient、实服探针或 portable smoke 宣称为已计入，除非另行完成并验证跨进程插桩合并。
- 当前环境 `PATH` 找不到 `node`/`npm` 时，先从仓库 `.tools/node-v*-win-x64` 定位本地工具链并只为当前门禁命令补充 `PATH`；不得据此跳过门禁、修改全局环境或误用便携产物中的运行时。
- 修改 `packages/contracts` 或 `packages/core` 后定向运行下游服务测试前，必须先重建对应 workspace；下游测试可能按包导出加载 `dist`，不能把旧构建造成的假失败或假通过当作当前源码结论。
- 通过 `CompetitionService` 验证已发布工作模式日志摄入时必须使用独立临时 SQLite（或显式提供等价的已发布配置端口），并断言目标事件确实进入状态机；无数据库实例不会持久化发布配置，不能用“阶段恰好没变化”冒充日志链路回归。

## 浏览器回归

- 验证纯手动比赛旅程时，从未启用自动化的运行开始，逐步断言 `automationEnabled`，至少跨越两关并检查等待计划边界后仍可继续；不能先调用 Ready 自动流程或强制切关再将其作为纯手动证据。待发送的自动通知也需纳入手动发令可用性检查。

- 可排序关卡必须用完整卡片拖拽浮层和等高目标占位提供中态反馈；拖拽几何计算要扣除已脱离文档流的源卡高度，并在浏览器测试中于 mouseup 前断言浮层与占位，而不只验证最终顺序。工作比赛不得渲染测试标签或测试运行按钮。
- E2E 在新建或切换比赛后必须等待比赛 ID 对应的唯一内容（如比赛名称或快照版本）完成切换；不能只等待“测试模式”等可能被旧页面同时满足的弱条件。
- E2E 通过页面内 `fetch` 直接执行批量快进等后端动作时，必须先断言响应中的权威最终阶段，再等待页面展示同一唯一阶段；动作响应完成不代表 WebSocket 触发的大快照已经解析和落地，不能立即读取旧 DOM 判定失败。
- 修改前端源码后直接用 `npx playwright test -g ...` 定向复跑前，必须先执行 Web 前端生产构建；`typecheck` 不会更新 E2E 服务读取的 `apps/web/dist`，不得用旧 bundle 的结果判断当前代码。
- E2E 只要触发裁判动作（含启用自动化、Ready、手动 Go、改期、结束比赛等），必须先显式发布比赛；未发布阶段只能断言按钮禁用与就地原因，不得直接点击。
- 测试把流程推进到 `review` 后，比赛会在同一状态迁移中立即成为 `finished`；若同一用例还要覆盖手动与自动两条独立流程，必须分别新建比赛，不得重置已结束运行后继续发送 Ready/Go。
- 成绩页 E2E 操作行内编辑器时，选择器必须锚定到目标行（如先定位该行按钮再取同一行编辑器），避免页面同时存在多个 `.score-cell-editor` 时误点或误断言。
- 页面成绩表、剪贴板 HTML/TSV、CSV 和 XLSX 必须复用同一表格模型；浏览器主流程至少逐格比较一次四种呈现，避免单独实现格式化后出现列顺序或状态文本分叉。XLSX 列引用必须覆盖 Z 之后的列。
- TSV 可使用 CRLF 作为文件/剪贴板换行，但 HTML `textarea` 的 DOM value 会规范化为 LF；手工复制回退测试应先规范化换行再比较，不得因此改变实际 TSV 输出。

## Windows 与便携包

- 发布版本应同步根目录和各 workspace 的 package.json、package-lock.json、APPLICATION_VERSION 与 README；浏览器版本断言引用应用版本常量，不能固定旧版本字符串。发布前核对包内 manifest 与健康接口的版本一致。
- 正式服务固定绑定 `127.0.0.1:38623`，不要静默切换随机端口。
- `Start-ContestConsole.cmd` 应自动替换已确认属于本项目的旧实例，并结束其进程树，避免遗留 MockClient 或旧窗口。
- 未知程序占用端口时不得误杀；必须显示 PID、命令信息和可理解的失败原因。
- 启动失败不能只留下“请按任意键继续”，真实错误必须在 `pause` 前可见。
- 修改服务源码后，验证便携包前必须重新执行服务构建；不要用旧的 `apps/server/dist` 打包。
- 重建便携包前确认没有进程正在执行目标包内的 `runtime/node.exe`；遇到 `EBUSY` 时先按可执行路径和命令行确认占用属于该包，再结束其进程树并重试，不直接删除被占用目录。
- `package:portable` 不要与 `test:portable` 并行运行；便携 smoke test 会占用打包目录中的启动器和 bundled Node，重建前必须等待冒烟结束或先结束这些进程树。
- 便携验证必须使用包内 Node、生产依赖和实际 `Start-ContestConsole.cmd`，不能只验证源码启动。
- `test:portable` 输出通过后仍要等待短暂退出窗口，再复查 `38623` 和包内 `runtime/node.exe`；“冒烟通过”不等于子进程已经完全回收，确认清理完成后才可提交。
- 便携 smoke 清理必须容忍启动器在状态检查与停止调用之间自行退出；按 PID 停止应为幂等操作，随后仍以端口和包内 `runtime/node.exe` 复查作为最终判据。
- 便携 smoke 的健康响应只有在监听 PID 与包内 `runtime/node.exe` 路径同时核验成功后才算通过；端口或进程查询失败必须失败关闭，不能当作“无监听/无残留”。包内 Node 版本、原生 SQLite、系统查询和进程终止都必须有硬时限。
- 便携 smoke 清理时先使用本轮随机关闭令牌有界调用 `/api/v1/dev/shutdown` 并等待服务退出，超时后才可对已核验的包内 Node 和已知启动器进程树强制结束。旧 smoke artifact 必须在本轮验证前失效，新的通过 artifact 和通过消息只能在端口与包内 Node 清理确认后原子写入。
- 便携冒烟为了证明“不依赖系统 Node”而收缩 `PATH` 时，仍须保留启动器实际依赖的 Windows PowerShell/System32 路径，并单独断言 `node` 不可解析；不能因测试环境删掉启动器依赖而把失败误判为服务启动超时。
- 便携冒烟启动批处理时使用 `Start-ContestConsole.cmd` 的绝对路径；不要假定 `Start-Process cmd /c` 的 `WorkingDirectory` 一定参与批处理查找。启动失败必须捕获 stdout/stderr，冒烟结束后轮询确认正式端口和包内 Node 进程都已退出。
- 启动或停止进程前确认 PID、可执行路径和命令行属于当前工作区或便携包。
- Release 发布流程只在用户显式调用项目级 `release-publish` skill 或明确要求创建 release/tag/artifact 时执行；普通开发收尾、门禁、portable 冒烟或提交不得自动打 tag、推送 tag、生成 release 压缩包或发布文档。显式 release 流程在本地门禁、打包、压缩包校验和中文 release 文档生成后，应推送 release tag 到 `origin` 并复查远端可见；仍不得自动上传压缩包或发布 GitHub release。Release 文档默认写中文，并生成在已忽略的 `docs/releases/` 本地工作区，除非用户明确要求纳入版本控制。

## 真实管道与实服证据

- 实服写命令探针不能把 `Connected to server OK` 当作登录成功；先留出登录拒绝观察窗口并排除紧随的 `Login denied`/1002/2000，再清空此前观察到的身份、执行显式 `list`，只用该次完整响应窗口唯一建立本机 `*ContestConsole` 当前连接 ID。发现普通玩家在线时默认中止，只有裁判明确批准占用中的目标服才可覆盖保护。探针应覆盖实际协议分支并保存回显证据，不能用初始名单、旧连接 ID 或 stdin 本地回显代替本轮现场确认。
- 标记为 `targeted` 或 `recovery.status=not-requested` 的实服 artifact 只能证明本次实际请求的服务器和协议分支，不能写成双服恢复门禁、20 秒冷却复验或现场验收。稳定文件名可能被后续探针覆盖；历史结论必须引用不可覆盖的证据路径、提交内脱敏夹具或已记录的内容哈希，不能继续把当前同名文件当成旧轮次证据。
- 所有会修改 Bulletin 的实服探针均应先读取并在结束后恢复原 Bulletin（包括正常完成与异常清理路径）；空公告的 `getbulletin` 回显可能仅为 `[Bulletin]`，清空操作回显为 `*ContestConsole - Content cleared`，不能强行按非空的“发送者: 正文”解析。实验范围须区分本地合成触发、实际服务器回显和游戏画面验收，保留有时间戳的原始证据及探针源码哈希。
- 从现场归档提炼自动回归时，先校验外层归档与内层 manifest，再只提交脱敏最小夹具和来源哈希；原归档保持只读并留在忽略目录，完整名单、聊天和无关成绩不得进入仓库。

- 本地真实管道测试必须保持 BallanceMMOServer 的 stdin 打开；该程序把 stdin EOF 当作 stop，不能使用 `stdio: ["ignore", ...]` 启动长期测试服务器。实服自制图探针使用独立合成 MD5，不能复用文档中的官图示例哈希，否则旧官图名称可能覆盖预期的自制图名，造成不安全的归属判断或假失败。

实服探针的验收定义见[后端需求第 15.6 节](contest-console-backend-requirements.md#156-双服连接恢复探针)。用户已有授权适用于本轮相关操作；环境开关用于防止误调用，不能替代授权或空服检查。

## 选择验证范围

README 按使用者的阅读顺序组织：项目介绍、快速开始和操作说明。功能变化应合并进对应操作章节，不在项目介绍前追加更新摘要；接口字段和确认协议写入需求文档，验证结果和实现记录写入开发进展。

自动通知文案的长度回归必须检查最终组合正文，包括动态名称的正常示例、原因和保护状态后缀；逐段合规不代表合并后行数合规。协议测试应覆盖三行正文经过两个 LF 编码后仍只写入一条 MockClient 命令。通知间隔回归要覆盖延后写入和重启恢复，按前一条实际写入计时，不能只按事件时刻设置多个固定截止点，否则慢队列恢复时可能连续补发。限制口径见[后端需求第 4.7 节](contest-console-backend-requirements.md#47-自动通知文本长度与分行)。

按改动风险选择现有测试：纯文档检查链接、术语和差异；产品行为检查相关服务及浏览器旅程；持久化必须覆盖“写入、关闭、重新创建服务、读取并继续”。改动共享 contracts/core 后先构建再运行下游测试，前端 E2E 前先构建 Web。

发布候选版本的命令清单见 [README 验证命令](../README.md#验证命令)，应覆盖 lint、typecheck、Vitest/覆盖率、构建、E2E、真实 MockClient、双服探针和 portable 冒烟。打包与冒烟串行运行，完成验证不代表授权发布 release。报告实际执行结果、未执行原因与现场验收边界，worker 崩溃、未处理异常或清理失败不能算通过。
