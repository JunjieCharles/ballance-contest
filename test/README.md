# 测试目录

本目录按测试层级而不是按技术框架组织。当前仓库尚无前后端实现，目录先承载用例设计、稳定夹具和未来自动化测试的落点。

```text
test/
├─ docs/                 # 测试策略、用例和需求追踪
├─ fixtures/             # 只读输入及人工维护的期望清单
├─ unit/backend/         # 解析器、领域模型、计分、状态机单元测试
├─ component/backend/    # 进程适配器、存储、HTTP/WebSocket 组件测试
├─ component/frontend/   # 页面、状态容器、表格和交互组件测试
├─ integration/          # 前后端、SQLite、假 MockClient 的集成测试
├─ e2e/                  # 裁判关键业务旅程
├─ non-functional/       # 性能、长时、恢复、安全和兼容性测试
└─ artifacts/            # 本地运行产物；除说明文件外不提交
```

## 入口

- [测试用例设计](./docs/test-case-design.md)
- [夹具约定](./fixtures/README.md)
- [2025 SR1–SR13 非门禁参考日志](./fixtures/replay/2025-grandprix-sr1-13/README.md)

## 命名约定

- 后端：`BE-<领域>-NNN`
- 前端：`FE-<领域>-NNN`
- 跨端旅程：`E2E-<领域>-NNN`
- 非功能：`NF-<领域>-NNN`
- 规则人工验收：`RULE-<领域>-NNN`

测试代码落地后，文件名使用对应的用例前缀；一条自动化测试可以覆盖同一业务场景的多个数据变体，但报告必须能回溯到用例 ID。
