# AGENTS.md

- 技术文档 MUST 必须基于项目事实
- 结合 local_path 本机器路径以及代码事实, subagents/teammates (推荐你使用 agent team, 可以创建 3 个 team, 一个 team 负责 content/be, 一个 team 负责 content/docs, 一个 team 负责 content/fe) 并发更新/重写 content 目录下所有的文档, 要求 100% 尊重代码事实 (markdown metadata local_path), 专业、全面；你主 agent (leader) 负责验收 subagents/teammates 更新/重写的所有文档，然后提交（专业英文 commit message）并推送；你不是视觉模型，不要读图片
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
