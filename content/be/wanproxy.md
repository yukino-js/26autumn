---
title: "WANProxy 技术笔记"
description: "WANProxy Go 移植工作区: XCodec 2048 字节段去重编解码与滚动哈希、HELLO/FRAME/ASK/LEARN/ADVANCE/EOS 管道协议会话、XCDFS 磁盘缓存、SSH-2 传输、TCP/SOCKS/SSH-SSH 代理中继与字节计数器, 以及 srv.go 演示服务端、A/B 实验编排与 React 仪表盘的实现机制"
local_path: "$HOME/github/wanproxy"
local_commit: "07f7fb83bdd044276fa3b4c7b7f1494b69bede06"
---

WANProxy 是一个 TCP WAN 优化代理的 Go 移植工作区, 移植对象是同名的 C++ 原版 (仓库根目录保留一份 gitignore 的 C++ 上游克隆 `wanproxy/` 作为参照)。核心能力是 XCodec 去重编解码: 把数据流拆成 2048 字节的段, 用滚动哈希识别重复段, 在 WAN 链路上只传输引用与增量声明, 再叠加 zlib 压缩, 使重复数据 (虚拟机镜像、日志流、增量备份) 的跨链路传输量收敛到引用级别。围绕这个内核, 工作区包含三个可构建部分: `wanproxy.go/` 是零第三方依赖的 Go 库与五个命令行程序 (守护进程、tack、xcdump、fwdproxy、diskdup), `srv.go/` 是基于 [yukino_http](./yukino-http) 的演示服务端, 负责拉起一支 10 个代理的演示舰队并提供文件/基准/A/B 实验 API, `web/` 是 React + TailwindCSS 仪表盘。本文面向想理解 WAN 优化代理内部机制、或需要一个可验证正确性的 Go 代理库的工程师, 依次讲解工作区布局、XCodec 编解码、管道协议会话、缓存体系、SSH 传输、代理中继、配置与监控、命令行工具、与 C++ 原版的一致性证据, 最后是演示栈的编排与 API。

## 工作区布局与构建

仓库是一个 Go workspace, `go.work` 声明 `go 1.26.0` 并 `use` 两个模块 (`./srv.go` 与 `./wanproxy.go`)。根 Makefile 的所有目标都转发给跨平台编排器 `go run ./srv.go/cmd/stack`, 端口用变量注入 (`SRV_PORT=3101`、`WEB_PORT=5173`、`MONITOR_PORT=9901`、`SSH_ECHO_PORT=8349`):

| 目标                                                  | 作用                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| `make dev` (默认)                                     | 后端 + web 前台运行, Ctrl-C 同时停止       |
| `make srv` / `make web`                               | 只跑后端 / 只跑前端                        |
| `make start` / `stop` / `restart` / `status` / `logs` | 后台运行 (pidfile 与日志在 `srv.go/data/`) |
| `make install`                                        | 安装 web 依赖并构建 Go 后端                |
| `make build` / `build-go` / `build-web`               | 构建                                       |
| `make test` / `test-go` / `test-web`                  | Go 测试/vet + web 构建/lint                |
| `make open` / `clean`                                 | 打开浏览器 / 清理构建产物 (保留运行时数据) |

| 目录           | 内容                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wanproxy.go/` | Go 移植本体: xcodec、ssh、pipeline、proxy、config、monitor、validation、common 包与 `cmd/{wanproxy,tack,xcdump,fwdproxy,diskdup}` 五个程序, 外加 `e2e/`、`examples/`、`wanproxy.conf.example` 与自己的 Makefile (`build` 产出 `bin/` 下五个二进制, 另有 `test`/`race`/`vet`/`fmt`/`e2e`/`clean`) |
| `srv.go/`      | 演示服务端模块: `cmd/{server,wanbench,stack}` 与 `internal/{daemon,files,monitor,bench,benchsvc,payload,tools,server,paths}`, 运行时状态落在 `data/`                                                                                                                                             |
| `web/`         | React 仪表盘 (页面、shadcn 组件、主题)                                                                                                                                                                                                                                                           |

`wanproxy.go` 的模块路径是 `github.com/hangtiancheng/wanproxy/wanproxy.go`, `go.mod` 没有任何 `require`, 全部实现基于标准库 (`net`、`compress/zlib`、`net/http`、`crypto/*`、`encoding/binary`、`math/big`、`log/slog`)。`srv.go` 模块 `github.com/hangtiancheng/wanproxy/srv.go` 用 `replace` 指向相邻的 `../wanproxy.go`, 并依赖 `github.com/hangtiancheng/yukino.go/libs/yukino_http v0.0.1`。

## wanproxy.go 模块结构

包与 C++ 原版的对应关系:

```text
xcodec/       滚动哈希、编码器/解码器、回引用窗口、内存/配对/空缓存、
              XCDFS 磁盘缓存、流帧编解码、管道协议会话、流式读写器
ssh/          SSH-2 传输层: 版本交换、KEXINIT 协商、DH 组交换、
              RFC 4253 密钥派生、二进制包、ssh-rsa 主机密钥、应用帧
pipeline/     编解码规格 (CodecSpec)、模式/角色/方向步骤解析、zlib 封装、字节计数器
proxy/        TCP-TCP 监听器、SOCKS4/5 代理、双向中继与半关闭、flowQueue、fleet
config/       经典 wanproxy.conf 指令解析器与 JSON 配置格式, 共用同一运行时模型
monitor/      HTTP 监控: HTML /、逐对象 /object/<name>、文本 /:text、JSON /status
validation/   大文件 XCodec 往返校验 (SHA-256)
common/       C++ 风格组件路径的分级日志掩码 (slog 之上)
cmd/wanproxy  守护进程: wanproxy [-q | -v] -c configfile
cmd/xcdump    XCodec 流解码与美化打印: xcdump [-v] [file ...]
cmd/tack      面向文件的字典压缩: tack [-p cache | -F fifo-cache | -N] [-svQ] [-T [-ES]] {-c|-d|-h} [file ...]
cmd/fwdproxy  文件驱动的纯端口转发: fwdproxy [-q | -v] -c configfile
cmd/diskdup   块级最小写入卷复制: diskdup [-s block_size] source target
```

## XCodec 去重编解码

XCodec 把数据流变成三类元素的混合: 对已见段的哈希引用、对新段的带内声明、以及转义后的字面数据。转义字节 (Magic) 为 `0xf1`, 段长固定 2048 字节, 四种流帧:

| 帧          | 线上格式                  | 语义                                       |
| ----------- | ------------------------- | ------------------------------------------ |
| `<ESCAPE>`  | `f1 00`                   | 输出一个字面 `0xf1` 字节                   |
| `<EXTRACT>` | `f1 01` + 2048 字节       | 带内声明新段: 哈希后进入输出流与回引用窗口 |
| `<REF>`     | `f1 02` + uint64 大端哈希 | 按哈希引用已声明的段                       |
| `<BACKREF>` | `f1 03` + uint8 下标      | 按回引用窗口位置引用段                     |

### 滚动哈希

`Hash` 对恰好 2048 字节的窗口做内容哈希, 由两个 32 位回绕累加器组成: `bytes` 累加每字节的 word 值 (`ch + 1`), `bits` 累加 `ffs(ch)` (最低置位位的 1 起始下标, 零字节为 0), 两张 256 项查找表在 init 时预计算。窗口满后可用 `Roll` 逐字节前滚: 从 `sum1` 减去被淘汰字节的 word、从 `sum2` 减去 `dead * SegmentLength`, 再加入新字节。`Mix()` 把内部状态压缩成 64 位摘要: `bitsHash = uint32((bits.sum1 << 16) + bits.sum2)`, `bytesHash = uint32((bytes.sum1 << 20) + bytes.sum2)`, 结果为 `(bitsHash << 36) + bytesHash`。`Add`/`Roll`/`Mix` 在窗口状态不对时 panic (镜像 C++ 断言), `HashSegment` 要求输入恰好 2048 字节。摘要与 C++ `XCodecHash` 逐字节一致 —— `hash_test.go` 运行 C++ `xcodec-hash1` 的已知答案向量 (256 个单字节填充段的摘要) 以及 roll 与重算的一致性检查。

### 编码器

`Encoder` 除缓存与回引用窗口外不保留跨调用状态, 因此可以任意分块喂入流。`EncodeWithReferences` 的主循环: 用滚动哈希覆盖每个 2048 字节窗口, 若缓存命中且内容逐字节相等 (哈希冲突时跳过且不记候选), 先转义输出引用之前的间隙, 再输出引用, 然后在引用段之后重启哈希; 未命中则记为候选, 候选与后续窗口不重叠时被声明。声明行为取决于缓存是否带外: 带内缓存 (内存/磁盘) 输出 `<EXTRACT>` 并进入窗口, 带外缓存 (如 tack 的 `-N`/`-p`) 直接输出 `<REF>`。字面数据经 `appendEscaped` 复制, 每个 `0xf1` 后补一个 `0x00`。最坏情况下编码把数据翻倍, 这正是管道协议把帧上限设为载荷上限两倍的依据。

`WithBackrefs()` 选项允许编码器对仍在回引用窗口中的段输出 `<BACKREF>` (3 字节代替 10 字节); C++ 编码器从不发出 backref, 因此默认关闭。编码同时返回 refmap (哈希 → 段), 管道协议靠它在对端 `<ADVANCE>` 之前应答 `<ASK>`。

### 解码器

`Decoder.Decode(chunk)` 追加缓冲并尽可能消费: 魔法字节之前都是字面数据; `<ESCAPE>` 还原一个 `0xf1`; `<EXTRACT>` 计算段哈希, 缓存已有不同内容时 `Replace` (带内缓存的名字复用), 否则 `Enter`, 并声明进窗口; `<REF>` 查缓存, 命中即输出并声明进窗口, 未命中则**停下**, 用 `skim` 不消费地扫描缓冲余部, 收集所有既不在缓存也不被余下 `<EXTRACT>` 定义的哈希 (排序后随 `DecodeResult.Unknown` 返回), 调用方把段喂进缓存 (通常经由 `<LEARN>`) 后再次 `Decode` 即可从断点恢复。`skim` 会把最初阻塞的那个哈希强制保留在未知集合里, 防止共享缓存的并发插入让解码器在没发出 `<ASK>` 的情况下停摆。`<BACKREF>` 窗口缺失、未知操作码返回错误; `outputLimit` 非零时限制单次接收的展开量 (会话置为 16 MiB), 超限返回 `ErrSessionLimit`。`Finish()` 在仍有缓冲时返回 `ErrIncompleteStream`。

### 回引用窗口与缓存体系

`Window` 是 256 槽循环表, `Declare` 在游标处插入并驱逐旧槽、清除同哈希的旧条目, `Present` 可校验段内容, `Dereference` 按下标取段。

`Cache` 接口是编码/解码器的段存储抽象 (`Lookup`/`Enter`/`Replace`/`Touch`/`Has`/`Size`/`OutOfBand`/`Connect`/`ID`), 要求并发安全, 段视为不可变:

| 实现          | 行为                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryCache` | 内存 LRU (`container/list`), 限额以**段数**计 (`WithSegmentLimit`); `NewMemoryCacheWithBytes` 按 `字节数 / 2048` 折算, 非零小额至少 1 段; 未指定 `WithCacheID` 时用 `crypto/rand` 生成 16 字节身份; `Connect(id)` 为每个对端派生同限额的兄弟缓存 (children map) |
| `PairCache`   | 主缓存叠次缓存: 写双层, 查先主后次, 次级命中提升到主级, 主级命中时 `Touch` 次级刷新淘汰状态; 身份继承次级 (更持久的一方), `OutOfBand` 取主级                                                                                                                    |
| `NullCache`   | 什么都不存, 带外语义, 供 tack `-N` 使用 (解码端被假定与编码端共享先验知识)                                                                                                                                                                                      |

`CacheID` 是 16 字节身份, 在管道协议 `<HELLO>` 中交换, 对应 C++ 的 UUID。

## 管道协议会话

会话帧格式 (对应 C++ `xcodec_pipe_protocol.h`):

| 帧                    | 操作码          | 载荷                                               |
| --------------------- | --------------- | -------------------------------------------------- |
| `<HELLO>`             | `0xff`          | uint8 长度 + 16 字节缓存身份, 必须出现在编码流开头 |
| `<FRAME>`             | `0x02`          | uint32 长度 + 编码块                               |
| `<ASK>`               | `0xf0`          | uint16 数量 + 哈希列表, 请求段数据                 |
| `<LEARN>`             | `0xf1`          | uint16 数量 + 整段数据, 应答 `<ASK>`               |
| `<ADVANCE>`           | `0x01`          | uint32 帧数, 对端已消费、无需再保留这些帧的引用    |
| `<EOS>` / `<EOS_ACK>` | `0xfc` / `0xfb` | 无更多数据 / 全部数据已处理                        |

协议常数: 最大帧 `PipeMaxFrame = 1 MiB`, 单帧最大明文 `PipeMaxPayloadFrame = 512 KiB` (编码至多翻倍, 帧自包含), 每个 `<ASK>`/`<LEARN>` 至多 `PipeAskMax = 512` 个哈希, HELLO 身份固定 16 字节。`ReadPipeFrame` 对长度为零/超限、计数为零/超限、未知操作码一律返回 Invalid。

`Session` 是会话的一端 (对应 C++ `XCodecPipePair`), 双向: `EncodeData`/`CloseWrite` 产生本端发送的线上字节, `Receive` 消费对端字节并返回解码明文、要回写的协议响应与流结束信号。一个编码 goroutine 与一个解码 goroutine 可并发使用。

**编码半边**: 首次使用时先发 `<HELLO>`。`<HELLO>` 里通告的身份是**缓存的 UUID**, 跨连接稳定 —— 重连的对端复用之前连接的解码缓存, 引用无需重新 `<ASK>`/`<LEARN>`。明文按 512 KiB 切块, 每块编码成一个 `<FRAME>`; 每帧的 refmap 与明文大小记入 `refFrames` 并累计 `inFlightBytes`。窗口默认 8 MiB (字节限额可由 `WithInFlightLimit` 调整), 未确认帧数上限固定为 256; 单次调用超出窗口直接 `ErrSessionLimit`, 窗口满返回 `ErrBackpressure` 且输入不被消费; `EncodeDataContext` 在不持锁的情况下等待 `<ADVANCE>` (每次 ADVANCE 关闭 `advanced` channel 并重建) 或 ctx 取消。`CloseWrite` 产生 `<EOS>`。

**解码半边**: `Receive` 先把字节追加进 `decBuffer` (上限 16 MiB), 循环解析控制帧, 再解码已帧化的数据。`<HELLO>` 用对端身份 `Connect` 出专属解码缓存视图, 外包一层 `learnedCache` 把 ASK 应答**钉住**, 与共享缓存的淘汰解耦, 保证解码前进。`<ASK>` 从保留的 refFrames 里逐哈希找段 (找不到即协议错误), 组装 `<LEARN>` 回写; `<LEARN>` 要求每个段都对应一个未决 ASK (拒绝 C++ 所称的 gratuitous LEARN), 冗余 LEARN (缓存已有相同数据) 保持原样, 名字复用则 `Replace`; 全部未知哈希解决且解码缓冲排空后清空钉住的段。`<ADVANCE>` 按计数释放 refFrames、归还 in-flight 窗口, 计数超过保留帧数是错误。解码产生的 `<ASK>` 按 512 个一组排序发出。

**结束语义**: 收到 `<EOS>` 且对端所发全部处理完毕后回 `<EOS_ACK>` 并置 `OutputEOF` (调用方应半关闭下游写向); 双向都确认后 `Done` 一次性置位, 此后再收到数据是错误。`HasPending`/`FinishReceive` 用同一组条件判断传输 EOF 时是否丢了数据 (未解析控制字节、未解码帧、被未知哈希阻塞的解码器)。协议违例全部拒绝: 二次 `<HELLO>`、解码器初始化前收到帧、`<EOS>` 后收到帧、`<HELLO>` 前收到 `<ASK>`/`<LEARN>`/`<ADVANCE>`/`<EOS>`、未发 `<EOS>` 或重复收到 `<EOS_ACK>`、`<EOS_ACK>` 时仍有未确认帧等。

`stream.go` 提供 `EncodeReader`/`DecodeReader` 两个 `io.Reader` 适配器: 以 512 KiB 的段对齐块编码 (块边界不会强迫转义), 源 EOF 时把尾部不足一块的数据编码掉; 解码端遇到未知引用或流尾残缺帧直接报错; 连续 100 次零字节且无错误的底层读触发 `io.ErrNoProgress`。

## XCDFS 磁盘缓存

`xcodec/xcdfs.go` 实现共享磁盘后端 (C++ `XCodecDisk`/`XCodecDiskCache`)。卷是 2048 字节块的文件或设备, 布局为 `[registry: 8 块][index: N 块][data: N*204 块]`, 多字节字段小端:

- **registry**: 1024 个 16 字节 UUID 槽 (每块 128 个), 把 XUID 映射到对端缓存命名空间; XUID 0 是本地身份, 卷上没有任何命名空间时生成随机 UUID 写入。
- **index**: 每块一个 uint64 单调计数器加 204 条 `(uint16 xuid, uint64 hash)` 条目, 描述其后按 FIFO 排列的数据块; 计数器为零表示空闲块。
- **data**: 每块存一个 2048 字节段。

`OpenDisk(path, size, log)` 按绝对路径 (符号链接先解析) 在全局 `diskMap` 中共享同一个 `Disk` 并计数引用; size 非零时普通文件被 truncate 到该值, 已存在且大小不符或打开中的卷**不能**resize; size 为零则取现有文件大小 (tack `-F` 的用法)。最小卷容量要能放下 registry + 1 个索引块 + 204 个数据块。加载序列与 C++ 构造一致: 读 registry (重复 XUID 记错误日志), 扫描索引块计数器确定 FIFO 顺序并定位写头 (第一个空闲块, 卷满时取最小计数器), 按计数器升序加载条目使每个哈希的最新版本获胜, 其中**前 80 块与后 80 块**逐条读数据块做哈希校验, 写头窗口内发现损坏就把写头重置回该块使其被重写; 最后回收没有条目的对端命名空间 (本地 XUID 除外)。

写入路径: `enter` 先写数据块, 把条目追加进内存中的在途索引块; 索引块写满 204 条才整块落盘, 然后写头前移 (回绕), 失效新写头将要重写的条目, 计数器递增 (跳过 0)。这与 C++ 一致 —— 在途索引块只在写满时落盘, 退出时最多丢 203 条, 是文档化的 "little consistency" 取舍。`lookup` 读块并复核哈希, 读失败或哈希不符即删除内存索引项。任何一次写失败都会置 `writeErr`, 之后的变更全部禁用。

`Connect(uuid)` 为对端分配 XUID 并写 registry; XUID 耗尽返回错误 (空的命名空间可能仍被活跃会话持有, 复用会串写), 而 `DiskCache.Connect` 在磁盘端失败时退回一个隔离的内存缓存, 让流以 ASK/LEARN 方式继续而不是失败。与 C++ 的两处重要差异: C++ `registry_write` 读第 N 块却写回第 0 块, 会损坏超过 128 个 XUID 的 registry, Go 版写到正确的块; 共享打开在发布前完成初始化并引用计数, 空命名空间在加载时回收, 而不是在 registry 满时复用活缓存句柄。

## SSH-2 传输层

`ssh/` 是 C++ SSH-2 传输层的移植, 供 SSH-SSH 代理与演示的 echo 端点使用。`Transport` 包装一条 `net.Conn`, `Handshake()` 后呈现解密后的应用字节流; 允许一个读 goroutine 与任意多个写 goroutine 并发 (写由 `wmu` 串行化)。

**握手四步**: (1) 版本交换 —— 写出识别串 (默认 `SSH-2.0-WANProxy Go`) 再逐字节读对端, 要求 `SSH-2.0` 前缀, 允许前面最多 255 行前导, 单行不超过 8192 字节; (2) KEXINIT 交换与协商 —— 16 字节随机 cookie 加各类算法 name-list, 协商规则是**客户端偏好顺序决定**, 且选中的算法必须存在于本地注册表, 压缩只接受 `none`; (3) diffie-hellman-group-exchange —— 客户端请求 `[min=1024, n=1024, max=8192]`, 服务端像 C++ `USE_TEST_GROUP` 一样恒定回复硬编码的 1024 位测试素数 (生成元 2); 客户端校验收到的素数位宽在 1024..8192、生成元在 `(1, p-1)`; 私指数随机取 `[1, p-2]`, 双方都校验对端公钥在 `(1, p-1)` 且共享密钥不得退化 (`K <= 1` 拒绝); (4) NEWKEYS —— 发送自己的 NEWKEYS 并立即切换发送方向密钥, 然后持续读包直到对端 NEWKEYS, 期间对端提前发来的应用数据照常投递。

**算法表** (顺序即本地偏好): 密钥交换 `diffie-hellman-group-exchange-sha256` 优于 `-sha1`; 主机密钥仅 `ssh-rsa` (SHA-1 + PKCS#1 v1.5 签名交换哈希); 加密 `aes128-ctr`、`aes128-cbc`、`aes192-ctr`、`aes192-cbc`、`aes256-ctr`、`aes256-cbc`、`3des-ctr`、`3des-cbc`、`arcfour`; MAC `hmac-sha1`、`hmac-sha2-256`、`hmac-sha2-512`、`hmac-md5`、`hmac-sha1-96`、`hmac-md5-96`。C++ 表里 Go 标准库没有的条目 (blowfish/cast128/idea、hmac-ripemd160) 被省略, 协商默认值 (aes128-ctr、hmac-sha1、dh-group-exchange-sha256) 与现代 OpenSSL 构建的 C++ 版一致。

**密钥派生**: 交换哈希 `H = hash(V_C || V_S || I_C || I_S || K_S || kexAccum || mpint(K))`, 其中 kexAccum 是组交换消息体 (`[min,n,max] || p || g || e || f`) 的线上编码拼接; 首个 H 即会话 ID; 共享密钥 K 以 mpint 线上编码参与派生; `KEY = HASH(K || H || letter || session_id)`, 不够长时用 `HASH(K || H || KEY_so_far)` 扩展; 字母 A/B、C/D、E/F 分别是客户端/服务端方向的 IV、加密密钥、MAC 密钥。

**二进制包**: `uint32 长度 + uint8 填充长 + payload + 随机填充`, 填充长为 `4 + (blockSize - ((4 + 1 + len(payload) + 4) % blockSize))`, 块大小取密码块长且至少 8; MAC 按 `seq(4 字节大端) || 明文包` 计算并截断到 MAC 尺寸, 然后加密包体、把 MAC 附在密文后; 接收端先解密首块读出长度, 校验 `packetLen >= 12` 且 `(packetLen+4)` 整除块长、不超过 `maxPacketSize = 4 MiB`, 用 `hmac.Equal` 验 MAC, 填充长必须在 `[4, len-5]`。C++ 原版没有包长上限, 这个上限防恶意对端耗尽内存。

**应用帧**: `Config.Tagged` 决定成帧方式, 与 C++ `SSHStream` 一致 —— 该跳有激活编解码时用 0xff 前缀包 (写方向按 32768 字节切块), 读方向剥掉前缀; 否则内部用 `[uint32 长度][数据]` 帧, 写方向跨调用缓冲不完整帧, 帧长必须在 `1..maxPacketSize-256`。握手完成后, 除 `DISCONNECT` (读端返回 EOF) 与 `IGNORE` 外的所有消息都按应用数据处理 —— 不做 C++ 那种按首字节分发, 避免未加标签流的首字节恰好是协议号时被破坏。`CloseWrite` 委托底层连接的半关闭。主机密钥 PEM 由 `LoadRSAPrivateKeyPEM` 加载, 接受 PKCS#1 `RSA PRIVATE KEY` 与 PKCS#8 `PRIVATE KEY` (仅限 RSA)。

与 C++ 的关键差异: C++ 代码从不发送第一个 NEWKEYS (源码里有两处 XXX 注释承认), 导致数据阶段不加密; Go 版按 RFC 在密钥交换后发送 NEWKEYS, C++ 的 NEWKEYS 处理器会回应并激活密钥, 因此双向互通。随机填充、畸形包对齐/超大应用帧/退化 DH 公值的拒绝都是移植中加入的。

## 管线组合与代理中继

### CodecSpec 与步骤解析

`pipeline.CodecSpec` 是一个激活的编解码实例: `Mode` (`none`/`zlib`/`xcodec`/`zlib+xcodec`, `ParseMode` 还接受 `zlib-xcodec`/`zlibxcodec` 等别名)、`CompressorLevel` (-1 默认, 越界时 zlib 封装退回默认压缩)、`Cache` (含 XCodec 的模式必填)、`TrackStatistics`/`Stats`。`Role` 把编解码挂到代理的某一侧: `incoming` 是 peer 编解码 (WAN 侧在上游), `outgoing` 是 interface 编解码 (WAN 侧在监听端); `Direction` 中 `Send` 是监听→上游, `Receive` 是上游→监听。`ResolveSteps` 给出单向步骤序列, 规则是**流向 WAN 的数据先编码后 deflate, 从 WAN 流入的先 inflate 后解码**, 与 C++ `WANProxyCodecPipePair` 的接线一致。`CodecStats` 是四个 `atomic.Int64` 计数器 (`IncomingToCodec`/`CodecToOutgoing`/`OutgoingToCodec`/`CodecToIncoming`), 快照 JSON 键为 `incomingToCodecBytes` 等, 对应 C++ `track_statistics`。

### Relay 的并发结构

`Relay` 在客户端 (interface 侧) 与上游 (peer 侧) 两条 `StreamConn` (`net.Conn` 或 SSH transport) 之间搬数据。两侧编解码都未配置时走纯转发: 两个 goroutine 各跑一个 `io.Copy`, EOF 后 `CloseWrite`, 让 `net.TCPConn` 使用平台优化拷贝路径。

有编解码时每方向三阶段、共六个 goroutine, 由四条有界 `flowQueue` (各 16 MiB) 连接:

```text
readSource(client)  --toUpstream-->  forward(encode=sessionP) --upstreamWire--> upstream
readSource(upstream) --toClient-->  forward(encode=sessionI) --clientWire----> client
                 即时响应(ASK/LEARN) -> controlsI/controlsP -> writeControls -> 同一 wireWriter
```

- `readSource` 独占一个 socket 的读侧, 每次读 32 KiB 喂给本侧会话的 `Receive`, **从不等待 socket 写**。`splitResponses` 把响应拆开: `<ASK>`/`<LEARN>` 立即进控制队列, `<ADVANCE>`/`<EOS_ACK>` 挂在投递消息上、等明文转发之后再发 —— 这样被阻塞的 socket 写不会卡住必须处理控制帧才能解阻塞的读端。纯源 (无会话) 用 `pushContext`, 队列满时施加普通读背压而非失败连接。
- `forward` 独占一个应用方向: 计数明文字节, 需要编码时 `EncodeDataContext` (等待 ADVANCE 可被 ctx 取消唤醒), 写 `wireWriter`; EOF 时发 `<EOS>` (有会话) 或 `Close` (无), 最后把延迟响应推进控制队列。
- `writeControls` 消费控制队列写同一 `wireWriter`, `done` 时关闭写侧。

`flowQueue` 的数据队列把小读合并成 32 KiB 块 (防止碎片化把有界字节窗口变成百万级排队对象), 控制队列则保证一条控制帧永远是原子的单次线上写 —— 编码数据不能插进一条 `<LEARN>` 中间。

`wireWriter` 是朝一个对端的同步写侧, 承载编码数据帧与交叉回来的协议响应: 有压缩时每次写后 `Flush` (对应 C++ `DeflatePipe` 每次 consume 以 `Z_SYNC_FLUSH` 收尾, 数据立即上线), `Close` 收尾 deflate 并半关闭 socket; 关闭后的写返回 `errWireClosed`。`countingReader`/`countingWriter` 在最靠近 socket 的位置计原始字节, 镜像 C++ `PipeByteCount`。

**四个字节计数器的落点**: 客户端读计 interface 编解码的 `IncomingToCodec`, 上游读计 peer 编解码的 `OutgoingToCodec`; 客户端 wire 写计 interface 编解码的 `CodecToIncoming`, 上游 wire 写计 peer 编解码的 `CodecToOutgoing`; 两条 `forward` 在应用边界上分别计 interface 的 `CodecToOutgoing` + peer 的 `IncomingToCodec` (发送向) 与 peer 的 `CodecToIncoming` + interface 的 `OutgoingToCodec` (接收向)。演示服务就是用这套计数器算出每次传输的 wire/app 字节数。

**半关闭与排空**: 每方向先泵数据到源流逻辑结束, 再完成对侧写 (`<EOS>` 或 flush + `CloseWrite`), 最后把源 socket 读到 TCP EOF —— 交叉的控制帧因此总被处理, 正常关闭时最终帧不会变成 reset 丢数据。`RunContext` 用 `context.WithCancelCause` 管理: 取消会关闭两条 socket 中断阻塞的网络 I/O 并唤醒等待 ADVANCE 的编码器, 返回值是首个失败原因。

### 监听器、SOCKS 与 Fleet

`listenerState` 拥有 accept 循环、出站 dial 上下文与全部 socket: 注册与关停共享一把锁, `Stop` 取消 dial 上下文、关闭监听器与所有在册 socket、等待 handler 退出, 可重复并发调用; 还暴露 `Listening`/`Address`/`AcceptedConnections`/`ActiveSockets`。默认拨号是 `net.Dialer{Timeout: 30s, KeepAlive: 30s}`, 可用 `DialContext` 覆盖 (`Stop` 会取消其 ctx)。`Fleet` 统一管理 TCP 与 SOCKS 监听器: `Start` 失败时按注册逆序回滚已启动项, `Stop` 收集第一个错误, `Status` 产出 `FleetStatus` (每个代理的 listening/accepted/active/编解码快照)。

`Listener` 是 TCP-TCP 代理 (C++ `ProxyListener` + `ProxyConnector`): accept 后 dial peer, 可选 SSH 握手, 然后 `NewRelay(...).Run()`。**SSH-SSH 代理类型**由 `SSHSettings{HostKey, HandshakeTimeout}` 启用: interface 跳跑 SSH 服务端传输、peer 跳跑 SSH 客户端传输, 两个握手在同一个 deadline (默认 15s) 下并发进行, 任一侧失败就关闭两条连接并等另一侧结束; 成帧规则与 C++ 相同 —— **某跳的编解码激活时该跳才用 0xff 加标签**。

`SocksListener` 服务 SOCKS4/SOCKS5 CONNECT: 协商有 15s 默认时限; SOCKS5 方法协商要求包含 no-auth (0x00), 否则回 `05 ff`; SOCKS4 只接受命令 0x01, user id 以 NUL 结尾且不超过 1024 字节; SOCKS5 支持 IPv4/域名/IPv6 三种地址类型。**成功响应只在目标拨号成功之后发送**, SOCKS5 应答携带出站 socket 的真实绑定地址 (含正确的 IPv6 类型), 拨号失败按错误类型映射 SOCKS5 失败码 (ECONNREFUSED→5、ENETUNREACH→3、EHOSTUNREACH/DNS→4、超时→6、其余→1); `bufio` 可能多读的应用字节 (管道化数据) 对两种协议都保留并在建链后补发给上游。SOCKS4A 不支持, 与 C++ 一致。

## 配置系统

`config.Load` 读文件后探测格式: 首个非空非 `#` 行以 `{` 开头按 JSON 解析, 否则走经典指令格式。两种格式产出同一个运行时模型 (`Config`: Proxies/SocksProxies/Monitor/LogMasks/Objects/Caches), `Config.Close` 用 `sync.Once` 按注册逆序释放资源 (磁盘卷), 嵌入方应在 fleet 停止后再调用。

**经典格式** (`create <class> <name>` / `set <name>.<member> <value>` / `activate <name>`, `#` 注释、空白分词): 类有 `log-mask`、`cache`、`codec`、`interface`、`peer`、`proxy`、`proxy-socks`、`monitor`; 重名 create 被拒绝; `$object.member` 引用经 `fieldStrings` 解析 (引用未创建对象或未设置成员都是错误); 双引号字符串去引号。激活规则:

- `log-mask`: `mask` 是 C++ 级别名 (空为 INFO), `regex` 编译后安装到共享日志器, 编译失败则激活失败 (对应 C++ `regcomp` 失败); 最详细的级别成为单级视图 `LogLevel`。
- `cache`: 类型 Memory (默认, `size` 如 `128MB` 经 `ParseSize` 按 1024 进制解析, 数字部分 base 0 接受 `0x` 前缀)、Disk (必须给 `path`, 不许给 `uuid` —— 持久 UUID 由卷分配, `size` 缺省时按文件大小探测)、Pair (primary/secondary 都必须已激活, 不许 uuid/size)、None。`uuid` 成员是 16 字符字符串。
- `codec`: `codec` 取 None/XCodec, `compressor` 取 None/zlib, 组合出四种模式; XCodec 类模式必须引用已激活缓存; `track_statistics` 接受 true/yes/false/no。
- `interface`/`peer`: family (IP/IPv4/IPv6/Unix) + host/port 或 path; IP 族带 path、Unix 族带 host/port 都报错。
- `proxy`: type 默认 TCP-TCP, 支持 TCP/TCP-TCP 与 SSH/SSH-SSH; SSH 型从 `server_host_key` 读 PEM RSA 私钥, 未设置时按 C++ 的历史行为默认找 `ssh-server1.pem`; interface/peer 必须已激活且完整, interface_codec/peer_codec 可选。
- 解析结束没有任何代理则整体失败。所有创建的对象 (含字段) 保留给 monitor 导出。

**JSON 格式**: 顶层 `proxies[]` (name/listen/upstream/codec)、`socksProxies[]`、`monitor`; 解码用 `DisallowUnknownFields` 并拒绝尾随内容; `codec.mode` 用 `ParseMode`, `role` 为 `incoming` 时挂到 PeerCodec、`outgoing` 挂到 InterfaceCodec; 含 XCodec 的模式自动获得一个新的 `MemoryCache` 并登记到 `Caches`; `compressorLevel` 限 -2..9, 端口限 0..65535, 至少要有一个代理。`examples/` 下有三份示例 (单代理 xcodec echo、双代理 zlib+xcodec 链、SOCKS + monitor), 由 `examples_test.go` 逐一加载验证。`wanproxy.conf.example` 则是完整的经典格式示例: log-mask、128MB 内存 + 1GB 磁盘 Pair 缓存、两个 zlib 级 6 的 XCodec 编解码、三跳代理链加 SOCKS 与 9900 端口的 monitor。

## 监控与日志

`monitor.Server` 绑定一个 interface 端点, 从 `Source` 接口取配置对象与舰队状态 (`Objects()` + `Status()`), `http.Server` 设 10s `ReadHeaderTimeout`, 只接受 GET:

| 路径                             | 输出                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `/status`                        | JSON 状态 (两空格缩进), 演示服务与仪表盘消费它                   |
| `/`                              | HTML: 配置对象表 (指针字段渲染成 `/object/<name>` 链接) + 状态表 |
| `/object/<name>`                 | 单对象 HTML                                                      |
| `/:text`、`/:text/object/<name>` | 上述内容的 text/plain 渲染 (CRLF 行)                             |

`common` 包实现 C++ `Log::mask` 语义的分级日志: slog TextHandler (stderr) 外包一层 `maskHandler`, 掩码是 (组件正则, 级别) 的有序列表, **第一个匹配的掩码决定结果** —— 消息级别不低于掩码级别才输出; 组件不匹配任何掩码时输出; 一条掩码都没有时全部输出。级别名映射保留每个掩码的准入集: `EMERG`–`ERR` → Error, `WARNING`/`NOTICE` → Warn, `INFO` → Info, `DEBUG` → Debug。`SetLevel` 用单一 catch-all 替换全部掩码, `ResetMasks` 清空, `Component(path)` 派生带 C++ 风格组件路径 (如 `/wanproxy/proxy/proxy0`) 的 logger。守护进程的安装顺序与 C++ `main()` 一致: `-v`/`-q` 时命令行 catch-all (Debug/Error) 先装, 配置文件里的 log-mask 无法覆盖命令行; 不带 `-q`/`-v` 时配置掩码按原样生效, 之后再追加一条配置级别 (`LogLevel`) 的 catch-all 兜底未匹配组件 (C++ 则把它们罩在默认 catch-all 之后)。

## 命令行工具

**wanproxy 守护进程** (`wanproxy [-q | -v] -c configfile`, 两标志互斥): 打印横幅, 按上述顺序装日志掩码, `config.Load`, 为每个 TCP 代理与 SOCKS 代理建 fleet 成员 (SSH 代理带上主机密钥), `fleet.Start`, 配置了 monitor 则启动, 逐行打印 `proxy listening on host:port` 与 `monitor listening on host:port`, 然后等 SIGINT/SIGTERM, 依次停 monitor、fleet (defer)、`cfg.Close` (defer)。

**tack** 是文件级字典压缩器: `-c` 压缩、`-d` 解压、`-h` 逐完整段输出 8 字节大端 XCodec 哈希 (尾部不足一段忽略); 缓存选择 `-p` (持久缓存文件 = 原始 2048 字节段的拼接, 启动时预热进内存缓存, 新段追加、`Close` 时冲刷, 解压时只读)、`-F` (XCDFS 卷, 大小从文件探测)、`-N` (空缓存), 缺省是全新内存缓存; `-s` 向 stderr 打印未压缩/压缩字节与压缩比, `-Q` 丢弃输出, `-T/-E/-S` 以微秒采样统计编解码调用 (输出到 stderr 的纯文本行)。与 C++ 的差异: 解码失败、缓冲输出失败、字典冲刷失败都会以非零码退出 (C++ 记日志后 exit 0), 哈希计算与源读边界无关。

**xcdump** 把 XCodec 流美化成 XML 风格行: `<data/>`、`<escape />`、`<hash-declare/>`、`<hash-reference/>`、`<back-reference/>`; `-v` 加 hash/offset 属性, `-vv` 再加十六进制数据; 尾部无法解析的残缺帧按 data 输出 (与 C++ 一致)。

**fwdproxy** 读每行四个词 `interface-host interface-port remote-host remote-port`, 为每行建一个无编解码的 TCP 代理。

**diskdup** 以最小写入量把源卷复制成目标卷: 逐块 (默认 65536 字节, `-s` 可调) 双读比较, 只写不同的块, 在较短卷的末尾停止; 卷在块中间结束报 "received non-empty end-of-stream" 并提示块大小可能不对; 源只读、目标以 O_RDWR 打开且必须已存在; 读写失败非零退出 (C++ 记日志后 exit 0)。

## 与 C++ 原版的一致性

移植以正确性、有界流式处理与地道 Go 为先, 不追求复现 C++ 的实现细节或 bug, 一致性由测试证据支撑:

- **哈希与帧**: `hash_test.go` 跑 C++ `xcodec-hash1` 的 256 个已知答案向量与 roll-vs-重算检查; `TestEncodeDecodeCharKAT` 移植 C++ `xcodec-encode-decode1` 对每个字节值的往返; `golden_test.go` 钉死 ESCAPE/EXTRACT/REF/BACKREF 与 HELLO/FRAME/ASK/LEARN/ADVANCE/EOS/EOS_ACK 的精确线上字节, 含一次最小会话交换。
- **会话**: `session_test.go` 覆盖完整状态机、独立对端缓存、协议违例拒绝与 gratuitous LEARN 规则; `session_limits_test.go` 覆盖背压、取消、微小帧上限与截断传输。
- **部署**: `relay_test.go` 在真实 TCP 上跑双代理链 (客户端侧 peer 编解码 + 服务端侧 interface 编解码、独立缓存), 验证数据完整性、每编解码四个 C++ 字节计数器与跨连接去重; 三代理测试以 18 MiB 传输与极小缓存同时驱动两个编解码槽; `flow_test.go` 用无缓冲 `net.Pipe` 验证写阻塞时控制流量仍能推进。
- **端到端**: `e2e/` 构建并以经典配置拓扑运行守护进程 (SOCKS 客户端 → proxy0 → xcodec+zlib WAN → proxy1 → proxy-socks0 → 服务器) 并断言线上字节缩减; `ssh_e2e_test.go` 用两个 SSH-SSH 代理夹一段 XCodec+zlib WAN 跳。
- **配置与 SSH**: `config_test.go` 解析 C++ 随附的原始 `wanproxy.conf` (含带 PEM 主机密钥的 SSH-SSH 代理); `transport_test.go` 覆盖握手、DH 组交换、密钥派生、NEWKEYS 切换、加标签/不加标签成帧与 100KB 加密往返。
- **XCDFS/日志/diskdup**: registry、FIFO 回绕与索引失效、边界损坏检查、跨重开的 XUID 命名空间隔离、Memory+Disk 配对; C++ `Log::mask` 语义 (有序正则、首匹配生效、未匹配输出、空表全输出) 与 `log-mask` 激活 (含非法正则拒绝); diskdup 的最小写入、短卷停止、尾部残块与 CLI。
- **基准**: `bench_test.go` 把 C++ 的 `xcodec-hash-speed1`/`xcodec-hash-roll1`/`xcodec-encode-decode1` 速度示例移植为 Go 基准。

已知差异 (不含上文 SSH NEWKEYS 与 XCDFS registry 修复): 算法子集过时 (以现代标准衡量); XCDFS 在途索引块写满才落盘 (与 C++ 相同的取舍); SOCKS 成功响应在 dial 之后、应答携带绑定地址、缓冲数据保留; 会话生命周期更严格 (EOS 后数据、过早 EOS_ACK、截断传输都是错误, LEARN 应答独立于共享缓存淘汰被钉住); tack/diskdup 失败非零退出; 未移植 IRC 与 HTTP 协议库、`uinet` 用户态 TCP/IP 栈、event/callback 子系统、`Buffer`/引用计数/线程基础设施 (由 Go 切片、goroutine 与 GC 取代) 以及 `websplat` 演示 Web 服务器; `XCodecCache::connect` 的进程级 UUID 表换成内存缓存的 per-cache children map 与磁盘缓存的 XCDFS registry。

## srv.go 演示服务端

`srv.go` 用一个进程完成四件事: 拉起 wanproxy.go 演示舰队与进程内 SSH echo、在 `127.0.0.1:3101` 提供 HTTP API、通过代理链跑服务端基准、在 SIGINT/SIGTERM 时完整拆除 (不留孤儿子进程)。

### 舰队生命周期

`internal/daemon` 的 `Start` 顺序: `prepare` (建目录; 缺 `wanproxy.go/bin/{wanproxy,tack,xcdump}` 时在该目录跑 `make build`; 缺主机密钥时生成演示用 RSA-2048 PKCS#1 PEM, 权限 0600; 把 `demo/wanproxy.conf.template` 中的 `{{SRV_PORT}}`/`{{MONITOR_PORT}}`/`{{SSH_ECHO_PORT}}`/`{{XCACHE_PATH}}`/`{{HOSTKEY_PATH}}` 替换成绝对路径后渲染到 `data/wanproxy.conf`) → 以 `-c data/wanproxy.conf` 启动 wanproxy 子进程 (stdout/stderr 按行加 `[wanproxy]` 前缀转进 Go 日志) → 轮询 monitor `/status` 至多 15s (2xx 或 404 均视为就绪) → 启动进程内 SSH echo (`ServeSSHEcho` 加载同一主机密钥, 每连接握手后 `io.Copy(tr, tr)`) → 等 echo 端口可连至多 10s。任何一步失败都先拆除已启动的部分。`Restart(clearCache)` 由 `restartMu` 串行化: 停止、可选删除 `data/wanproxy.xcache` (XCDFS 卷, 内存缓存重启后总是冷的) 得到真正的冷启动基线、再 `Start`。`Stop` 幂等: 先关 echo, 再给子进程 SIGTERM (Windows 直接 Kill), 3s 宽限后 SIGKILL。

`internal/paths` 负责仓库/端口解析: `SRV_ROOT` 依次尝试环境变量 `SRV_ROOT`、`runtime.Caller` 的源码相对路径、可执行文件与 cwd 向上查找 (判据是存在 `demo/wanproxy.conf.template`); 端口取 `PORT`/`SRV_PORT` (默认 3101)、`MONITOR_PORT` (9901)、`SSH_ECHO_PORT` (8349)。

### HTTP API

`internal/server` 在 `yukino.New()` 上挂 `httpLog`、`cors` (反射 Origin、OPTIONS 直接 204、前后各应用一次以扛住 Recovery 清头) 与 `yukino.Recovery()`, 路由:

| 方法与路径                                                 | 用途                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/files`                                           | 列出已存文件                                                                          |
| `POST /api/files/generate`                                 | 确定性 LCG 测试文件 `{name,size,pattern,seed}` (默认 mixed/16MiB/seed 42, 上限 4 GiB) |
| `POST /api/files/upload?name=`                             | 流式 octet-stream 上传 (SHA-256 随写计算)                                             |
| `GET /api/files/:id/content`                               | 下载, 支持 HTTP Range: 206 + Content-Range, 非法区间经 `TakeOver` 返回 416            |
| `DELETE /api/files/:id`                                    | 删除                                                                                  |
| `GET /api/monitor/status`                                  | 原样透传守护进程 `/status` (失败 502)                                                 |
| `GET /api/monitor/scenarios` (别名 `/api/bench/scenarios`) | 场景目录                                                                              |
| `POST /api/bench/run`                                      | 单场景基准 `{scenario,direction,pattern,size,seed}`                                   |
| `POST /api/bench/experiment`                               | 多臂 A/B 实验                                                                         |
| `POST /api/bench/sink` / `GET /api/bench/source`           | 基准跑者用的原始上传/下载端点                                                         |
| `POST /api/daemon/restart`                                 | `{clearCache}` 重启舰队 (基准进行中 409)                                              |
| `POST /api/tools/analyze`                                  | 对已存文件跑 `tack -c`、`tack -p`、`xcdump -v` 并汇总帧构成                           |

文件存于 `data/files/<uuidv4>`, 元数据在 `data/files.json`。bench 与 experiment 共享一把单飞锁, 并发请求得 409。

### 基准与 A/B 实验

`internal/bench` 是跑者库 (SRV 进程内调用, `wanbench` CLI 是同一库的调试壳): `http` 场景对给定 base 直连或经 TCP 代理 (上传 POST `/api/bench/sink` 并核对字节数与 SHA-256, 下载 GET `/api/bench/source` 流式哈希); `socks` 场景自己实现 no-auth SOCKS5 握手 + CONNECT; `ssh` 场景用移植的 SSH 客户端传输 (未加标签成帧), 以 1 MiB `[u32 长度][数据]` 帧边发边并发读回 echo、只对载荷哈希。每次运行后与本地生成器的 SHA-256 对账, 结果带 `durationMs`/`throughputMBps`/`ok`/`error`。

`internal/benchsvc` 在传输前后各取一次 monitor 计数器, 按方向折算 app/wire 字节: 上传取 `incomingToCodec`/`codecToOutgoing`, 下载取 `codecToIncoming`/`outgoingToCodec`, roundtrip 双向求和, `ratio = wire/app`。实验上限: 8 臂、20 次迭代 (默认 3)、1 GiB、seed 0..2^31-1, direction 默认 download, baseline 默认第一臂且必须是臂之一。`isolateArms` 默认 true: 第 i 臂的 seed 为 `seed + i*7919`, 使舰队级共享去重缓存不会在臂间泄漏热状态 (置 false 可观察共享缓存的跨链效应)。无编解码计数的臂 (direct/passthrough/socks) 按定义 `wire = app = size × 倍数` (roundtrip 倍数 2)。报告聚合每臂 mean/median 时长、平均吞吐、wire/app 总量, 并给出相对基线的裁决: 线上字节节省与缩减百分比、吞吐加速比、耗时节省。

`internal/payload` 是确定性负载生成器: LCG `x = (x*1103515245 + 12345) mod 2^31`, 字节取 `(x >> 16) & 0xff`, 同一 (pattern, size, seed) 在文件生成器、source 端点与基准跑者之间逐字节一致, 完整性因此无需交换载荷即可用 SHA-256 验证。四种模式: `random` 纯伪随机 (不可压缩诚实性检查); `repeat` 一个 4096 字节块重复 (最大去重); `mixed` 三个 4 KiB 块按块序轮换、每 10 块中第 3/7/9 块换成新随机块 (70% 重复 + 30% 伪随机, 模拟 VM 镜像); `text` 每 40 行一个周期, 前 30 行是从 12 条词表行循环取出的固定日志行 (约 2.5 KB 的字节级重复段, 比一个 XCodec 段还长), 后 10 行携带序号/trace token/延迟的唯一行 (任何优化器都消不掉), 模拟可压缩日志流。

`internal/tools` 对已存文件跑三步分析: 带内压缩 (`tack -c -s`)、字典两遍 (先 `-c -Q -p dict` 建字典, 再压缩两遍得到 first/second pass 尺寸)、`xcdump -v` 帧转储, 然后汇总 EXTRACT/REF/ESCAPE/data 计数、data 字节数、按出现次数排序的前 8 个哈希与前 24 帧。

`cmd/stack` 是根 Makefile 背后的跨平台编排器: `dev` 同时起后端二进制与 `pnpm --dir web dev` (任一方退出或 Ctrl-C 时杀整棵进程树); `start` 后台化并写 `srv.go/data/pids/{srv,web}.pid` 与 `server.log`/`web.log`; `logs` 先输出各日志尾部 4096 字节再每 500ms 增量跟随; `build-go` 编译 wanproxy.go 全部包与五个二进制再编 `srv.go/bin/wanproxy-srv`; `test-go` 跑 wanproxy.go 测试加 srv.go 的 vet + 测试; `clean` 只删构建产物。

## web 仪表盘

React 19 + react-router 7 + Vite 8 + TailwindCSS 4 (`@tailwindcss/vite`), UI 用 shadcn 组件 (cva 变体) 与 recharts 图表。`src/lib/api.ts` 用原生 `fetch` 请求 `http://127.0.0.1:3101`, 类型定义与 SRV 的 JSON 逐字段对齐; Files 页的文件传输改用 axios, 以便经 `UPLOAD_ROUTES` 里可选的入口 (SRV 直连、passthrough :8310、zlib 链 :8311、xcodec 链 :8312、WAN 链 :8320) 上传/下载, 让浏览器流量真实穿过代理链。`vite.config.ts` 设 `@` 别名并用 `advancedChunks` 把 react 系与 UI 系依赖拆成独立 vendor 块; `pnpm build` 是 `tsc -b && vite build`, `pnpm lint` 用 flat config (ui/ 组件豁免 fast-refresh 规则)。主题色是 `src/index.css` 里的语义 token (`primary` 蓝、`success`/`warning`/`info`、`chart-1..5`), 支持暗色。

| 路由          | 页面                    | 内容                                                                   |
| ------------- | ----------------------- | ---------------------------------------------------------------------- |
| `/`           | Overview                | 实时舰队拓扑与逐代理统计 (来自 monitor `/status`)、编解码压缩比        |
| `/experiment` | A/B Experiment          | 多臂实验: 预设、逐迭代热身曲线、wire 字节裁决                          |
| `/files`      | File Transfers          | 生成测试负载、经可选代理链上传/下载 (Range 支持视频拖动)、浏览器内预览 |
| `/scenarios`  | Protocol Benchmarks     | 按场景跑服务端 wanbench, 对比 wire 字节                                |
| `/inspector`  | XCodec Stream Inspector | 用移植的 tack/xcdump 做帧级分析                                        |

## 演示拓扑与端口

首次启动时 SRV 渲染的 `demo/wanproxy.conf.template` 定义了一支 10 个代理的舰队: 256MB 内存缓存叠 1GB XCDFS 卷的 Pair 缓存, 所有编解码都开 `track_statistics`; 除 SSH 链终结于 SSH echo 外, 所有场景最终转发到 SRV 源站:

| 端口               | 角色                                      |
| ------------------ | ----------------------------------------- |
| 5173               | Vite dev server (web)                     |
| 3101               | SRV HTTP API + 基准源站                   |
| 9901               | wanproxy 守护进程 HTTP monitor            |
| 8310               | passthrough 代理 (无编解码, 对照基线)     |
| 8311 → 8351        | zlib 压缩链 (zlib-a → zlib-b)             |
| 8312 → 8352        | XCodec 去重链 (xcodec-a → xcodec-b)       |
| 8320 → 8321        | WAN 优化链 (wan-a → wan-b, XCodec + zlib) |
| 8330               | SOCKS5 CONNECT 代理                       |
| 8340 → 8341 → 8349 | SSH 链 (ssh-a → ssh-b → 进程内 SSH echo)  |

七个基准场景 (`direct`、`passthrough`、`zlib-chain`、`xcodec-chain`、`wan-chain`、`socks`、`ssh-chain`) 由 `internal/monitor.Scenarios()` 统一定义, 跑者与 web 消费同一份目录。repeat 模式负载过 WAN 链时, xcodec 去重能把兆级应用字节收敛到千级线上字节, 这正是仪表盘上 A/B 实验展示的裁决。

## 快速上手

```sh
make install     # 安装 web 依赖并构建 Go 后端
make dev         # SRV (:3101) + web (:5173), 前台; 打开 http://localhost:5173
```

直接使用库与工具:

```sh
cd wanproxy.go
go build ./... && go test ./...
go run ./cmd/wanproxy -c wanproxy.conf.example   # 经典配置
go run ./cmd/wanproxy -c examples/tcp-xcodec-echo.json  # 或 JSON 配置 (examples/ 下另有两份)
go run ./cmd/tack -c -s input.file > input.tack  # 压缩并打印比率
go run ./cmd/tack -d input.tack > input.restored # 解压
go run ./cmd/xcdump -v input.tack | head         # 检查帧流
go run ./cmd/diskdup -s 65536 source.img target.img
```

monitor 端点: `GET /status` (JSON)、`GET /` (HTML)、`GET /:text`、`GET /object/<name>`。

## 适用场景与已知边界

适合: 需要在 Go 中嵌入 TCP 代理与 WAN 优化能力、且要求线上格式与 C++ WANProxy 兼容 (帧级 golden 测试背书) 的场景; 需要可验证去重收益 (四计数器 + SHA-256 对账) 的实验与基准; 学习滚动哈希去重、管道协议会话与 SSH 传输层实现。

边界与代价: 会话/队列限额 (8 MiB in-flight、16 MiB 接收与队列) 是每缓冲/每队列的上限而非进程内存预算, 共享缓存另有自己的尺寸规则; SSH 算法集沿袭 C++ 原版、以现代标准衡量已过时 (1024 位测试 DH 组、SHA-1 签名、无重密钥), 适合演示与受控环境而非公网对抗; Go↔Go 加密交换有测试覆盖, 与 C++ 的互操作仍是独立的验证目标; XCDFS 在途索引写满才落盘, 退出最多丢 203 条 (与 C++ 相同的取舍); SOCKS 不支持 SOCKS4A 与认证; 未移植 IRC/HTTP 协议库、uinet 栈与 event 子系统。

相关主题: 演示服务端 `srv.go` 的 HTTP 层直接构建在 [yukino_http](./yukino-http) 上 —— 路由分组、CORS 中间件、`Recovery`、文件下载的 `TakeOver` 接管与 Range 流式写出都是该框架机制的直接应用; 移植中用到的并发原语 (`sync.WaitGroup`、channel、`sync.Once`、`context` 级联取消) 与标准库约定见 [Go 语言核心](./go)。
