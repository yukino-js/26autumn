---
title: "Terminal UI"
---

交互式 TUI: React 19 + Ink 7 渲染的单窗格终端界面 —— 流式回复、工具执行卡片、权限对话框、slash 命令都在这里发生

## 设计取舍: 原生滚动, 不抢终端

Yukino 使用终端的**主屏**, 移除了全屏/alternate-screen 渲染和鼠标捕获:

- 完成的消息追加进终端原生 scrollback: 选择、复制、粘贴、滚轮/触控板历史滚动全部由终端自己处理, Yukino 不翻译滚动事件
- 代价: 放弃自己的会话视口、滚动条、「点击回到底部」指示器和会话导航快捷键; 滚动和新输出是否跟随底部由终端控制; 阅读历史时输入区和 footer 会滚出视野
- 实时区 (live area) 保持响应, 展示运行中输出的尾部; assistant 完整回复在结束时打印; Ctrl+O 以展开/折叠细节重印当前 transcript
- 终端 resize 时只重绘实时区, 不清屏、不重放已完成消息: 历史输出保留原换行、走终端自己的 reflow, 已打印的卡片不为更宽的终端重建或拉伸
- 粘贴长文本 (超过 10 行或 1000 字符) 折叠为 `[paste #1 +124 lines]` 占位符; 剪贴板图片显示为 `[Image #1]`; 占位符按整体移动/删除, 提交时还原完整文本和图片附件
- 粘贴的图片存为 PNG (`~/.yukino/sessions/artifacts/<session-id>/file-history/`), 提交时展开为 cwd 相对的 `@` 引用并作为内联图片块发送; Linux 需要 wl-clipboard (Wayland) 或 xclip (X11)

滚动保留、选择行为、复制粘贴快捷键和实时重绘期间的选择稳定性取决于终端本身; 这是有意的设计取舍, 不是缺陷

## 用户 Bash: ! 和 !!

主输入以 `!` 或 `!!` 开头时直接执行 Bash, 不经过模型:

- `! git status`: 命令和结果**进入**下一次模型上下文
- `!! pnpm test`: 命令和结果**不进入**模型上下文 (`!!` 结果在重建上下文时也被排除)
- 命令是字面 shell 输入: `@` 引用、slash 命令、skill 都不展开; plan 反馈等其他对话框不解释这些前缀
- 使用 Yukino 的 Bash 超时和输出限制; 结果保留最后 2000 行 / 50 KiB, 更大的输出写文件并给出路径
- 两种模式都持久化卡片 (供 /resume 和 /rewind 回放); 模型流式期间也可以跑, 但同时只能有一条用户命令; 完成的结果等当前模型轮次或压缩结束后再进入历史, 保住 tool_use/tool_result 配对
- Esc / Ctrl+C 优先取消用户命令, 不影响模型和后台 agent; 用户命令不能 Ctrl+B 转后台, 也不产生模型可见的 task notification
- 用户显式输入的命令不受 agent 权限模式 (含 plan) 限制; 已开启的 OS 沙箱仍然生效, 沙箱不可用时失败关闭

## 快捷键

| 键        | 行为                                                                |
| --------- | ------------------------------------------------------------------- |
| Ctrl+C    | 清空输入或中断流式 (第一次按), 2 秒内再按退出应用                   |
| Ctrl+O    | 切换工具输出的完整/截断展示 (重印 transcript)                       |
| ↓         | 在输入最后一行: 打开 Agents 列表 (teammates + 后台 subagent)        |
| Ctrl+B    | 把运行中的前台 Bash/PowerShell 任务移到后台                         |
| Ctrl+V    | 粘贴剪贴板图片 (Windows 是 Alt+V)                                   |
| Shift+Tab | 循环 default → acceptEdits → bypassPermissions; plan 退出回 default |

Enter 在 Agents 列表里打开详情, Escape 返回/关闭; 未发送草稿和光标位置保留; 补全菜单和 prompt 历史导航优先于 Agents 列表

## Agents 列表

teammate spawn 卡片和后台 subagent 卡片随 transcript 滚动, 当前进度在 Agents 列表中查看 (src/ui/agents-dialog.tsx); 前台 agent 流式期间也可以打开

## Prompt 历史

输入历史保留上限 10,000 条 (src/history/index.ts, 滚动淘汰最旧); ↑/↓ 导航历史、补全菜单和输入可视行; 恢复草稿后再按 ↓ 打开 Agents 列表

## 退出摘要

退出时渲染 Markdown 主题的交互摘要 (### Interaction summary): 会话 id、工具调用统计 (总数 / ✓ / ✗ / 成功率)、时长 (wall / active)、token 用量和 prompt cache 命中率 (src/bootstrap/interaction-summary.ts)

## 版本检查与自更新

- TUI 异步检查 npm 上的新版本并在界面提示 `yukino update`, 检查失败 (网络错误等) 静默忽略、不打断 UI
- `yukino update` CLI 子命令 (src/update/): 查询 npm latest, 用当前安装所用的包管理器 (npm/yarn/pnpm) 升级到精确版本; 一键安装脚本装的全局包也支持
