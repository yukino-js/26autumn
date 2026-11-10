---
title: "高频手撕题解法骨架"
description: "LRU / LFU / 分布式 LRU、滑动窗口限流、双指针与 TopK、链表与二叉树、回溯与 DP、等待图环检测，以及手撕通用检查单"
---

本章定位：手撕题的区分度不在背模板，而在**先澄清题意、再给复杂度、最后主动交代边界与工程对接**。下面每题按「题意陷阱 → 解法骨架 → 复杂度 → 边界」展开，代码尽量可直接运行。完整限流实现见 [JS 手写限流器](/interview/code/rate-limiter)，等待图与死锁见 [Web 安全、云防护与可观测性](/interview/fundamentals/security-observability)，题目索引见 [题目索引](/interview/question-bank)。

## 一、LRU Cache

**题意陷阱**：`get` 也是访问，命中后必须把节点移到最新；`put` 已存在的 key 要更新值并移动，不能当新节点；容量满淘汰最久未用。

**解法骨架**：哈希表 `O(1)` 定位 + 双向链表 `O(1)` 调整顺序；JS `Map` 的插入序可省掉手写链表（删除后重新 `set` 即移到最新）。

```mermaid
flowchart LR
  M["哈希表 key→节点"] -.-> H["双向链表"]
  H --> N1["MRU 头部"] --> N2["..."] --> N3["LRU 尾部"]
  N3 -.容量满淘汰.-> X["删除"]
```

```ts
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0)
      throw new RangeError("capacity");
  }
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, v); // 重新插入 => 移到最新
    return v;
  }
  put(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity)
      this.map.delete(this.map.keys().next().value!);
  }
}
const c = new LRUCache<number, number>(2);
c.put(1, 1);
c.put(2, 2);
c.get(1);
c.put(3, 3);
console.log(c.get(2)); // undefined（2 被淘汰）
```

**复杂度**：`get` / `put` 均 `O(1)` 时间、`O(capacity)` 空间。

**边界与延伸**：`capacity=0` 直接不存；**并发安全版**用锁或按 key 分片，别让「查 + 删 + 插」被穿插；**TTL 版**给节点加 `expiresAt`，读取时惰性删除并清理冷 key；**分布式 LRU** 用一致性哈希分片 + 本地 LRU + 热点 key 兜底，并给冷数据批量扫描加准入（频次达标才入缓存），否则一次全表扫描把热数据全挤走。

## 二、LFU Cache

**题意陷阱**：频次相同的 key 还要按 LRU 淘汰，只留一个计数器会错；`minFreq` 在桶空后要及时上移。

**解法骨架**：`values`（key→value）、`freq`（key→次数）、`buckets`（次数→同频 LRU 链）三张表 + `minFreq`；访问把节点从旧桶移到 `f+1` 桶尾，淘汰 `minFreq` 桶头。

```ts
class LFUCache<K, V> {
  private val = new Map<K, V>(), fr = new Map<K, number>(), bk = new Map<number, Map<K, V>>();
  private min = 0;
  constructor(private cap: number) {}
  private touch(k: K) {
    const f = this.fr.get(k)!;
    this.bk.get(f)!.delete(k);
    if (f === this.min && this.bk.get(f)!.size === 0) this.min = f + 1;
    this.fr.set(k, f + 1);
    if (!this.bk.has(f + 1)) this.bk.set(f + 1, new Map());
    this.bk.get(f + 1)!.set(k, this.val.get(k)!);
  }
  get(k: K): V | undefined { if (!this.val.has(k)) return undefined; this.touch(k); return this.val.get(k); }
  put(k: K, v: V): void {
    if (this.cap === 0) return;
    if (this.val.has(k)) { this.val.set(k, v); this.touch(k); return; }
    if (this.val.size === this.cap) {
      const b = this.bk.get(this.min)!, victim = b.keys().next().value!;
      b.delete(victim); this.val.delete(victim); this.fr.delete(victim);
    }
    this.val.set(k, v); this.fr.set(k, 1);
    if (!this.bk.has(1)) this.bk.set(1, new Map());
    this.bk.get(1)!.set(k, v); this.min = 1;
  }
}
```

**复杂度**：`get` / `put` 均 `O(1)` 均摊、空间 `O(cap)`。**边界**：`put` 已存在 key 时先更新值再升频；`min` 只在淘汰与旧桶空时更新；老的高频 key 长期占坑、突发热点进不来，生产用 LFU + 老化或 W-TinyLFU 近似。

## 三、滑动窗口限流器

**题意陷阱**：先澄清「一定时间范围」是**固定窗口**还是**任意滑动窗口**；固定窗口在边界可放行 `2×limit`，直接写它当答案就是错的。

:::note 语义先问清
「同 key 在时间窗内不超过 limit 次」有两种解释：固定窗口 `O(1)` 但有边界效应；任意滑动窗口精确符合字面语义，是主解。
:::

**解法骨架**：每 key 一个时间戳队列，`head` 指针跳过 `≤ now-window` 的过期戳（别用 `shift()`，那是 `O(n)`），判窗口内条数 `< limit`；`now` 可注入做确定性单测并加单调保护；定期 `sweep()` 清长期不活跃 key，否则 Map 无限增长。完整实现、固定窗口缺陷与自测见 [JS 手写限流器](/interview/code/rate-limiter)（此处不复制全文）。

```ts
// 骨架示意，完整实现见上方站内链接
const cutoff = now() - windowMs;
while (head < ts.length && ts[head] <= cutoff) head++; // 裁过期
if (ts.length - head >= limit)
  return { allowed: false, retryAfterMs: ts[head] + windowMs - now() };
ts.push(now());
return { allowed: true };
```

**复杂度**：均摊 `O(1)` 时间、`O(limit)` 空间 / key。**边界**：多实例进程内计数失效 → Redis zset + Lua 把「裁剪 + 计数 + 写入」原子化；`Date.now()` 回拨用单调时钟；拒绝回 `429` + `Retry-After`；attacker 造大量 key 打爆 Map，需容量上限 / LRU / 网关按 IP 粗限流。

## 四、最长不含重复字符的子串

**题意陷阱**：遇重复时左指针**只能右移不回退**，用 `max(left, last[c]+1)`；直接回退会吞进窗口外的重复字符。

```ts
function lengthOfLongestSubstring(s: string): number {
  const last = new Map<string, number>();
  let left = 0,
    best = 0;
  for (let right = 0; right < s.length; right++) {
    const prev = last.get(s[right]);
    if (prev !== undefined && prev >= left) left = prev + 1; // 只右移
    last.set(s[right], right);
    best = Math.max(best, right - left + 1);
  }
  return best;
}
console.log(lengthOfLongestSubstring("abcabcbb")); // 3
```

**复杂度**：`O(n)` 时间、`O(min(n, 字符集))` 空间。**边界**：空串、全相同字符；含 emoji / 代理对要澄清按码点还是码元（用 `Array.from(s)` 按码点遍历）。

## 五、第 K 大与矩阵第 K 小

**题意陷阱**：第 K 大是「降序第 K 个」，别写成第 K 小；K 可能等于 1 或 n；矩阵整体无序但每行 / 每列有序。

| 题                  | 解法骨架                                        | 复杂度                             |
| ------------------- | ----------------------------------------------- | ---------------------------------- |
| 数组第 K 大         | 小顶堆保持 k 个最大元素，堆顶即答案             | `O(n log k)` / `O(k)`              |
| 数组第 K 大（更优） | 快速选择：随机 pivot 三路分区，只递归命中的一侧 | 均摊 `O(n)`、最坏 `O(n²)` / `O(1)` |
| 矩阵第 K 小         | 对**值域**二分 `mid`，统计 `≤ mid` 的元素数     | `O((m+n) log range)`               |

```ts
function quickSelect(a: number[], k: number): number {
  // 1-based 第 k 小
  let lo = 0,
    hi = a.length - 1;
  const target = k - 1;
  while (lo < hi) {
    const p = a[lo + ((Math.random() * (hi - lo + 1)) | 0)];
    let i = lo,
      j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) {
        [a[i], a[j]] = [a[j], a[i]];
        i++;
        j--;
      }
    }
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else return p;
  }
  return a[lo];
}
console.log(quickSelect([3, 2, 1, 5, 6, 4], 2)); // 2
```

**边界**：随机 pivot 防有序输入退化到 `O(n²)`；重复元素用三路分区避免死循环；K 越界要校验；海量数据内存受限时不能全量入堆，见第九节。

## 六、单链表逆序与二叉树 LCA

**题意陷阱**：迭代逆序先存 `next` 再改指针，否则断链；递归逆序「原尾节点才是新头」；LCA 要处理「节点不在树中」与「p 是 q 的祖先」。

```ts
class ListNode {
  constructor(
    public val: number,
    public next: ListNode | null = null,
  ) {}
}
function reverseIter(head: ListNode | null): ListNode | null {
  let prev: ListNode | null = null;
  while (head) {
    const next = head.next;
    head.next = prev;
    prev = head;
    head = next;
  }
  return prev;
}
function reverseRec(head: ListNode | null): ListNode | null {
  if (!head || !head.next) return head;
  const nh = reverseRec(head.next);
  head.next!.next = head;
  head.next = null; // 反接并断开原向
  return nh;
}
```

| 题             | 解法骨架                                                 | 复杂度          |
| -------------- | -------------------------------------------------------- | --------------- |
| LCA 递归       | 左右都命中则当前为 LCA；只一侧命中则上抛该结果           | `O(n)` / `O(h)` |
| LCA 父指针法   | p 向上记祖先集合，q 向上第一个相交即 LCA（等价链表相交） | `O(h)` / `O(h)` |
| LCA 二叉搜索树 | 利用有序性，第一个落在两值之间的节点即 LCA               | `O(h)` / `O(1)` |

**边界**：空树、单节点、p/q 同节点、节点不在树中（递归返回的非空结果要复核是否真含两点）；退化链上 `h=n` 有爆栈风险。

## 七、打家劫舍、组合总和与消消乐

**题意陷阱**：打家劫舍是「不能选相邻」，状态滚两变量；组合总和要**排序 + start** 去重组合而非排列，分清「可重复选自身」与「不可重复」；消消乐相邻消除会连锁，栈天然处理。

```ts
function rob(nums: number[]): number {
  let prev2 = 0,
    prev1 = 0; // dp[i-2], dp[i-1]
  for (const x of nums) {
    const cur = Math.max(prev1, prev2 + x);
    prev2 = prev1;
    prev1 = cur;
  }
  return prev1; // dp[i] = max(dp[i-1], dp[i-2]+nums[i])
}
function combinationSum(c: number[], target: number): number[][] {
  c.sort((a, b) => a - b);
  const res: number[][] = [],
    path: number[] = [];
  const dfs = (start: number, rest: number) => {
    if (rest === 0) {
      res.push([...path]);
      return;
    }
    for (let i = start; i < c.length; i++) {
      if (c[i] > rest) break; // 排序后剪枝
      path.push(c[i]);
      dfs(i, rest - c[i]);
      path.pop(); // i 不去重 => 可重复选
    }
  };
  dfs(0, target);
  return res;
}
function eliminate(s: string): string {
  const st: string[] = [];
  for (const ch of s) st[st.length - 1] === ch ? st.pop() : st.push(ch);
  return st.join("");
}
console.log(rob([2, 7, 9, 3, 1]), eliminate("abbaca")); // 12, 'ca'
```

**复杂度**：打家劫舍 `O(n)` / `O(1)`；组合总和 `O(2^n)` 级但剪枝显著，空间 `O(target/min)`；消消乐 `O(n)` / `O(n)`。**边界**：全 0 / 负数（rob 用 `max(0, x)`）、`target` 小于最小候选、候选含 0 会死循环、消消乐空串与全消为空。

## 八、等待图环检测

**题意陷阱**：等待图 `T1 → T2` 是**有向**等待关系。

:::warning 并查集不适用
并查集判环的前提是**无向图**（加边时两端已连通即成环）；等待图丢掉方向会把「互相等」和「单向等」混为一谈。要环路径用 DFS 三色、要节点集合用 Kahn、批量环用 Tarjan SCC。
:::

```ts
type Graph = Map<string, string[]>;
// A. DFS 三色：白/灰/黑，遇灰即回边，直接输出具体环路径
function cyclePath(g: Graph): string[] | null {
  const color = new Map<string, 0 | 1 | 2>(),
    stack: string[] = [];
  const dfs = (u: string): string[] | null => {
    color.set(u, 1);
    stack.push(u);
    for (const v of g.get(u) ?? []) {
      if (color.get(v) === 1) return stack.slice(stack.indexOf(v));
      if (color.get(v) !== 2) {
        const c = dfs(v);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  };
  for (const u of g.keys())
    if (!color.get(u)) {
      const c = dfs(u);
      if (c) return c;
    }
  return null;
}
// B. Kahn：剥入度 0 的点，剩下未出队节点 = 环所在子图（不给环路径）
function cycleNodes(g: Graph): Set<string> {
  const indeg = new Map<string, number>();
  for (const u of g.keys()) indeg.set(u, 0);
  for (const vs of g.values())
    for (const v of vs) indeg.set(v, (indeg.get(v) ?? 0) + 1);
  const q = [...indeg.keys()].filter((k) => indeg.get(k) === 0),
    seen = new Set<string>();
  while (q.length) {
    const u = q.shift()!;
    seen.add(u);
    for (const v of g.get(u) ?? []) {
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) q.push(v);
    }
  }
  return new Set([...g.keys()].filter((k) => !seen.has(k)));
}
const g: Graph = new Map([
  ["T1", ["T2"]],
  ["T2", ["T3"]],
  ["T3", ["T1"]],
  ["T4", []],
]);
console.log(cyclePath(g), [...cycleNodes(g)]); // ['T1','T2','T3']  ['T1','T2','T3']
```

| 算法                  | 复杂度   | 输出                                  | 适用             |
| --------------------- | -------- | ------------------------------------- | ---------------- |
| DFS 三色              | `O(V+E)` | 具体环路径                            | 告警要带证据链   |
| Kahn 拓扑             | `O(V+E)` | 环涉及节点集合                        | 实现简单、易并行 |
| Tarjan / Kosaraju SCC | `O(V+E)` | 所有强连通分量（`size>1` 或自环即环） | 批量分析多个环   |

**边界**：DFS 递归深链有爆栈风险，生产改显式栈；Kahn 要拿环路径需在剩余子图上再跑 DFS；多实例资源下「有环」只是充分条件。监控侧按滑动窗口构图、剔除过期边、持续 N 周期才告警，见 [Web 安全、云防护与可观测性](/interview/fundamentals/security-observability)。

## 九、海量数据 TopK 与内存受限的第 K 大

**题意陷阱**：内存放不下全部数据时，全量排序、全量入堆都不成立；先问清规模、是否可分割、重复值占比、是否允许近似。

| 方案           | 骨架                                                    | 适用与代价                                |
| -------------- | ------------------------------------------------------- | ----------------------------------------- |
| 小顶堆         | 流式扫一遍，只留 k 个最大元素                           | `O(n log k)` / `O(k)`；内存可控，最通用   |
| 分治 + 堆归并  | 按哈希 / 范围切成可入内存的小文件，各取局部 TopK 再归并 | 可并行、可落盘；多一轮 I/O                |
| 快速选择外存版 | 按值域 / 分桶定位第 K 大所在桶，桶内精排                | 均摊近 `O(n)`；偏斜数据要二次分桶         |
| 位图 / 计数    | 值域有界且小，从高到低累计计数到 K                      | `O(n + range)` / `O(range)`；仅整数小值域 |
| 近似           | Count-Min Sketch / Lossy Counting 找重频                | 允许误差、省内存；要给误差口径            |

**边界**：K 接近 n 时堆方案退化，改按「第 `n-K` 小」取补集；重复值极多位图最省；分布式各分片 TopK 归并前要处理相同值的全局计数。二分与前缀和的同类骨架见 [浏览器、React 与流式前端](/interview/fundamentals/frontend-browser)，同组取舍见 [上传、滚动、告警与死锁](/interview/answers/upload-scroll-alerting-deadlock)。

## 手撕通用检查单

1. **参数校验**：空输入、单元素、容量为 0、负数、`limit < 1`、K 越界。
2. **整数溢出**：`mid = lo + ((hi - lo) >> 1)`、`(lo + hi + 1) >> 1`；大数用 `BigInt`。
3. **复杂度口述**：时间 / 空间 / 均摊 / 最坏，说明为什么是这个量级。
4. **并发与原子性**：单进程天然原子 ≠ 多实例成立；「检查与写入」之间是否有竞态。
5. **内存与 key 洪泛**：Map 只增不删必泄漏，要 `sweep` / 容量上限 / LRU；attacker 造 key 要网关层先挡。
6. **时钟与顺序**：`Date.now()` 回拨用单调时钟；同一毫秒重复加唯一后缀；流式帧按序号去重。
7. **测试 case 设计**：happy path、边界、恢复（过期后重新可用）、重复 / 并发、参数非法五类，假时钟可注入。
8. **与 HTTP / 工程实现的对接**：拒绝回 `429` + `Retry-After`、幂等键、`AbortController` 取消、错误分类退避。

:::tip 先讲再写
开口先说清语义歧义（固定窗口 vs 滑动窗口、第 K 大 vs 第 K 小、允许重复选与否），再给复杂度，最后写代码；写完自己跑边界 case，比多背一个模板更能拉开区分度。
:::

## 事实依据

| 主题               | 事实依据                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| 限流三方案与原子化 | `content/be/redis.md`、`content/be/node-pool.md`                                      |
| 等待关系与死锁参数 | `content/be/mysql.md`、`content/docs/tiktok.md`、`performance_schema.data_lock_waits` |

## 面试怎么讲

| 维度       | 采分点                                                             | 扣分点                                       |
| ---------- | ------------------------------------------------------------------ | -------------------------------------------- |
| 题意澄清   | 先问清窗口语义、第 K 大方向、重复是否允许、数据规模                | 直接写固定窗口 / 全量排序                    |
| 复杂度     | 每题给时间、空间、均摊与最坏，并说明取舍                           | 只报一个 `O(n)` 不分最坏情况                 |
| 代码质量   | `head` 指针、`minFreq` 更新、`max(left, ...)`、随机 pivot 三路分区 | 用 `shift()`、`minFreq` 漏更新、有序输入退化 |
| 边界与并发 | 空输入、溢出、时钟回拨、key 洪泛、多实例 Redis + Lua               | 只测示例输入，默认单机单线程                 |
| 工程对接   | `429` / `Retry-After`、幂等键、背压与取消传播                      | 把算法题与线上系统割裂                       |
| 表达结构   | 陷阱 → 骨架 → 复杂度 → 边界，逐层推进                              | 埋头写不解释                                 |

## 速记卡

- **LRU**：哈希表 + 双向链表（或 `Map` 插入序），`get` / `put` 都移到最新，满淘汰最旧，均 `O(1)`。
- **LFU**：`values` + `freq` + `buckets` 三表 + `minFreq`，同频桶内 LRU，淘汰 `minFreq` 桶头。
- **限流**：固定窗口边界放行 `2×limit`；滑动窗口日志用 `head` 指针 + `sweep` + 可注入 `now`，多实例 Redis + Lua。
- **双指针**：最长不重复子串左指针只右移 `max(left, last[c]+1)`；第 K 大小顶堆 `O(n log k)`、快速选择均摊 `O(n)`。
- **矩阵第 K 小**：对**值域**二分 + 统计 `≤ mid` 的元素数，`O((m+n) log range)`。
- **链表 / 树**：逆序先存 `next` 再改指针；LCA 递归上抛命中侧，父指针法转链表相交。
- **DP / 栈**：打家劫舍滚动两变量 `O(1)`；组合总和排序 + `start` 剪枝；消消乐同栈顶则弹。
- **等待图**：有向图，DFS 三色给环路径、Kahn 给节点集合、Tarjan 给所有 SCC，**并查集不适用**。
