---
title: "LSP"
---

LSP (Language Server Protocol) 集成: 给 agent 语义级的代码导航能力

Grep/Glob 是文本级发现 (正则和文件名), LSP 是语义级查询: 定义、引用、类型定义、实现、调用链、诊断 —— 精确到符号, 不被字符串巧合欺骗

## 配置

`~/.yukino/config.yaml` 的 `lsp_servers` 数组 (src/lsp/config.ts, zod 校验):

```yaml
lsp_servers:
  - name: typescript
    command: typescript-language-server
    args: ["--stdio"]
    languages:
      .ts: typescript
      .tsx: typescriptreact
      .js: javascript
    env: {} # 可选, 传给 server 进程的环境变量
    initialization_options: {} # 可选, initialize 请求的 initializationOptions
    settings: {} # 可选, workspace/didChangeConfiguration
    timeout_ms: 15000 # 可选, 单次请求超时, 100-60000, 缺省 15000
```

- `languages` 是文件扩展名到语言 id 的映射 (扩展名必须以 `.` 开头), 决定哪些文件走这个 server, 至少配置一个
- **显式配置, 不自动安装**: Yukino 不探测、不下载任何 language server; 没有配置的扩展名或没配 lsp_servers 时, LSP 工具直接返回配置提示, 不会静默降级

## LspClient

src/lsp/client.ts 是标准的 stdio JSON-RPC 客户端:

- 生命周期: 首次查询时 spawn server 子进程, `initialize` 握手 (传 initialization_options) → `initialized` 通知; 会话结束时 dispose 关闭进程, 挂起中的请求统一失败
- 文件同步: 查询前对目标文件发 `textDocument/didOpen`, server 拿到的是磁盘最新内容
- 请求超时: 默认 15s (config 可覆盖), 超时抛 `LSP <method> timed out`

## LSP 工具

LSP 工具 (src/tools/lsp.ts) 注册在基础工具集里, 参数:

- `operation` (必填): 11 种
  - definition / references / implementation / typeDefinition: 跳转和查找
  - hover: 悬停文档和类型
  - documentSymbol / workspaceSymbol: 文件符号大纲 / 全库符号搜索 (workspaceSymbol 需要 `query`)
  - prepareCallHierarchy / incomingCalls / outgoingCalls: 调用链 (谁调用它 / 它调用谁)
  - diagnostics: 文件的编译/静态诊断
- `file_path` (必填): 相对工作目录或绝对路径
- `line` / `character`: 位置类操作必填, **1-based UTF-16** 偏移 (与 ReadFile 显示行号一致)
- `query`: 仅 workspaceSymbol 使用

返回约定:

- 结果范围用 LSP 标准 (0-based UTF-16) 和文件 URI 表示, 与输入的 1-based 约定不同, 文档和工具描述中显式声明
- 无法编辑文件、无法执行任意 server 命令: LSP 工具只做查询
- diagnostics 里出现 pending=true 不代表文件健康 (server 可能还没算完); diagnostics 为空也不等于编译通过 (取决于 server)

## 与其他工具的关系

- 文本发现用 Grep/Glob, 语义导航用 LSP: 先 Grep 找到入口, 再 LSP 追定义和调用链
- 运行时工具指南 (见 system-prompt) 在配置了 LSP 时提示 agent 优先语义查询
- subagent 的后台异步白名单包含 LSP (见 subagent), explore 角色可以完整使用
