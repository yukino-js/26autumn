---
title: "Sandbox"
---

OS 级沙箱: 把 Bash 命令放进操作系统提供的隔离环境执行, 文件系统写入被限制在允许的目录内, 网络可以整体关闭

权限系统 (见 permission) 回答「这个工具调用要不要用户确认」, 沙箱回答「这条命令允许碰什么」; 两者独立又协同: 沙箱开启后, Bash 命令的破坏半径被 OS 收敛, 权限层就可以免人工确认 (auto_allow)

## 配置

`~/.yukino/config.yaml` 的 `sandbox` 段

```yaml
sandbox:
  enabled: false # 主开关
  auto_allow: false # 沙箱生效时, Bash 命令免人工确认 (显式 deny/ask 规则仍然生效)
  network_enabled: true # 沙箱内的命令是否可以访问网络
```

运行时可以用 `/sandbox` 命令在三种模式间切换

- `/sandbox auto`: 开启沙箱 + auto_allow 自动放行
- `/sandbox manual`: 开启沙箱 + 手动确认
- `/sandbox off`: 关闭沙箱

默认的沙箱策略 (configureBashSandbox 组装, src/bootstrap/sandbox.ts):

```js
sandboxConfig = {
  allowWrite: [cwd, os.tmpdir()], // 项目目录 + 临时目录
  denyWrite: [], // 默认没有写保护的洞
};
```

> tmpdir 必须在 allowWrite 里: mktemp、编译器、git、python tempfile 都依赖临时目录; macOS 的 tmpdir 是 /var/folders/... 而不是 /tmp; profile 生成时还会为每个路径补发 realpath 变体 (覆盖 /tmp → /private/tmp 这类符号链接)

## 沙箱接口

```ts
interface Sandbox {
  implementation: string; // "seatbelt" | "bwrap"
  availabilityError?: string;
  available(): boolean;
  // 将用户命令包装为沙箱内执行的命令
  prepare(command: string, config: SandboxConfig): PreparedCommand;
  dispose?(): void;
}
```

`createSandbox()` 按平台选择实现: darwin → SeatbeltSandbox, linux → BwrapSandbox, 其他平台返回 null

## macOS: seatbelt

seatbelt 是 macOS 内核级的沙箱机制, 通过一个 SBPL (Sandbox Profile Language) 策略文件定义进程的行为边界; 可执行文件硬编码为 `/usr/bin/sandbox-exec` (不走 PATH, 防止 PATH 注入), 存在性检查即可用性检查

包装后的命令: `sandbox-exec -p <profile> bash -c <command>`

生成的 profile

```txt
(version 1)
(deny default)                          ;; 默认拒绝一切
(allow process-exec)                    ;; 允许执行程序
(allow process-fork)                    ;; 允许 fork 子进程
(allow sysctl-read)                     ;; 允许读 sysctl
(allow file-read* (subpath "/"))        ;; 允许读整个文件系统
(allow file-write* (subpath "/project"))    ;; allowWrite: 项目目录可写
(allow file-write* (subpath "/private/tmp")) ;; allowWrite 的 realpath 变体也各发一条
(allow file-write* (subpath "/tmp"))
(deny file-write* (literal "/project/.yukino/config.yaml"))  ;; denyWrite: 先 literal
(deny file-write* (subpath "/project/.yukino/config.yaml"))  ;; 再 subpath, 在 allow 之后发出所以生效
(allow network*)                        ;; network_enabled: true; false 时是 (deny network*)
```

要点

- `(deny default)` 起步: 写保护不是「列出禁止的路径」, 而是「默认禁止一切写, 只放行 allowWrite 子树」, denyWrite 再从放行的子树里挖洞
- 读是整个文件系统放行的: coding agent 需要读工具链、系统库、头文件
- allowWrite 的每个路径同时发 realpath 变体 (/tmp → /private/tmp 这类 macOS 符号链接)

## Linux: bubblewrap

bubblewrap (bwrap) 是一个轻量级的用户空间容器工具, 通过 Linux 的 namespace 机制创建隔离环境; 可用性检查是 `which bwrap` (结果缓存)

包装后的命令

```bash
bwrap \
  --unshare-user \        # 独立的用户 namespace
  --unshare-pid \         # 独立的进程 namespace
  --die-with-parent \     # 宿主进程崩溃时沙箱进程组一起退出, 防止孤儿进程
  --ro-bind / / \         # 整个文件系统挂载为只读
  --bind /project /project \  # allowWrite: 项目目录可写 (bind mount 覆盖只读)
  --ro-bind /project/.yukino/config.yaml /project/.yukino/config.yaml \ # denyWrite: 后挂载, 重叠时优先
  --unshare-net \         # network_enabled: false 时: 独立的网络 namespace, 断网
  --proc /proc \          # 独立的 proc
  bash -c "用户命令"
```

和 seatbelt 的区别: seatbelt 是内核按策略文件过滤系统调用, bwrap 是用 namespace 重建一个受限的文件系统视图; denyWrite 在 bwrap 里靠挂载顺序实现 (只读 bind 后挂载, 覆盖先前的可写 bind)

## 与 Bash 工具的集成

只有 Bash 工具消费 Sandbox 接口; PowerShell 明确不包裹 (seatbelt 和 bwrap 包装的都是 bash, Windows 也没有 OS 沙箱实现)

执行路径

1. 沙箱未启用: `bash -c <command>` 直接执行
2. 沙箱启用但实现不可用 (sandbox 为 null 或 available() 为 false): 返回错误工具结果 `sandbox is enabled but unavailable; command was not executed`, 命令不执行
3. prepare 时把输出文件所在目录追加进 allowWrite (后台任务的输出文件、重定向需要可写)
4. prepare 抛错: 返回 `Error preparing sandbox: ...`

Windows 上配置 `sandbox.enabled: true` 的后果: createSandbox 返回 null 且 sandboxRequired 为 true, 每条 Bash 命令都直接报错不执行; 没有 Windows 专用的沙箱实现

## auto_allow: 沙箱换确认

沙箱生效后, Bash 命令的写破坏半径已经被 OS 限制, 权限层增加一道沙箱自动放行 (permission check 的 Layer 3.5):

- 仅对 `toolName === "Bash"` 且沙箱可用时生效
- 复合命令按 `&&`、`||`、`&`、`;`、`|`、换行拆分为子命令, 每个子命令单独跑一遍权限规则
  - 任一子命令命中 deny 规则 → 整体 deny
  - 任一子命令命中 ask 规则 → 整体 ask (沙箱不能覆盖显式规则)
  - 都没有命中 → allow, reason: "Sandbox auto-allow: OS sandbox active"
- 安全只读命令本来就在更前面的层放行, auto_allow 免确认的是「非只读但没有规则命中」的命令

设计取舍: 沙箱负责限制「能碰什么」, 规则负责表达「不许做什么」, auto_allow 把两者组合起来, 用 OS 隔离换掉大部分人工确认, 同时保留显式规则的最后否决权
