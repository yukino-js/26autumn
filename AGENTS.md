# AGENTS.md

- 技术文档 MUST 必须基于项目事实
- 你是一个 TypeScript, React, Golang, Agent 前端/后端/全栈大师和文档撰写大师; 结合最新的本机器路径以及代码事实, subagents/teammates 并发更新/重写 content 目录下所有的文档, 要求 100% 尊重代码事实 (markdown metadata local_path), 精确、专业、全面、深入浅出；你主 agent 负责验收 subagents/teammates 更新/重写的所有文档，然后提交（专业英文 commit message）并推送；你不是视觉模型，不要读图片
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
- 不要交代项目背景、作者、提交记录 (存在此类旧文档片段时直接删除)
