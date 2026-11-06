---
title: "高频手撕题解法骨架"
description: "LRU / LFU / 分布式 LRU、滑动窗口限流、滑动窗口与双指针、TopK 与值域二分、链表与二叉树、回溯与 DP、等待图环检测，以及手撕通用检查单"
---

手撕题的区分度不在背模板，而在**先澄清题意、再给复杂度、最后主动交代边界与工程对接**。完整可运行实现见[JS 手写限流器](/interview/code/rate-limiter)。

## 一、LRU Cache

**题意陷阱**：`get` 也是访问，命中后必须把节点移到头部；容量满淘汰尾部；`put` 已存在 key 要更新值并移动，不能当新节点。

```ts
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, v); // Map 保插入序, 重新插入即移到最新
    return v;
  }
  put(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      this.map.delete(this.map.keys().next().value!); // 淘汰最旧
    }
  }
}
```

`get`/`put` 均 `O(1)`。生产实现用哈希表 + 双向链表显式维护指针。延伸：**并发安全版**用锁或分片；**TTL 版**给每个节点加 `expiresAt`，读取时惰性删除；**分布式 LRU** 用一致性哈希分片 + 本地 LRU + 热点 key 本地兜底，并防冷数据批量扫描挤走热数据。

## 二、LFU Cache

**题意陷阱**：同频次内还要按 LRU 淘汰，不能只留一个计数器。

```ts
class LFUCache<K, V> {
  private values = new Map<K, V>();
  private freq = new Map<K, number>();
  private buckets = new Map<number, Map<K, V>>();
  private minFreq = 0;
  constructor(private capacity: number) {}
  private touch(k: K) {
    const f = this.freq.get(k)!;
    this.buckets.get(f)!.delete(k);
    if (f === this.minFreq && this.buckets.get(f)!.size === 0)
      this.minFreq = f + 1;
    this.freq.set(k, f + 1);
    if (!this.buckets.has(f + 1)) this.buckets.set(f + 1, new Map());
  }
  get(k: K): V | undefined {
    if (!this.values.has(k)) return undefined;
    const v = this.values.get(k)!;
    this.touch(k);
    this.buckets.get(this.freq.get(k)!).set(k, v);
    return v;
  }
  put(k: K, v: V): void {
    if (this.capacity === 0) return;
    if (this.values.has(k)) {
      this.values.set(k, v);
      this.get(k);
      return;
    }
    if (this.values.size === this.capacity) {
      const b = this.buckets.get(this.minFreq)!;
      const victim = b.keys().next().value!;
      b.delete(victim);
      this.values.delete(victim);
      this.freq.delete(victim);
    }
    this.values.set(k, v);
    this.freq.set(k, 1);
    if (!this.buckets.has(1)) this.buckets.set(1, new Map());
    this.buckets.get(1)!.set(k, v);
    this.minFreq = 1;
  }
}
```

## 三、滑动窗口限流

先澄清「一定时间范围」是固定窗口还是任意滑动窗口；固定窗口边界可放行 `2×limit`。主解是每 key 一个时间戳队列 + `head` 指针裁过期 + `sweep()` 清空闲 key + `now` 可注入做确定性单测；多实例必须 Redis zset + Lua 原子化「检查与写入」。完整实现与六组自测见[JS 手写限流器](/interview/code/rate-limiter)。

## 四、双指针、堆与值域二分

| 题                     | 解法骨架                                                | 复杂度                       |
| ---------------------- | ------------------------------------------------------- | ---------------------------- |
| 最长不含重复字符的子串 | 滑动窗口 + 哈希表记上次位置；左指针**只右移不回退**     | `O(n)` / `O(min(n, 字符集))` |
| 数组中第 K 大          | 小顶堆 `O(n log k)`，或快速选择均摊 `O(n)` 最坏 `O(n²)` | 见左                         |
| 矩阵第 K 小            | 对**值域**二分，统计 `≤ mid` 的元素数                   | `O((m+n) log range)`         |
| 海量数据 TopK          | 内存受限用分治 + 堆归并或位图；不要全量排序             | `O(n log k)`                 |

```ts
function lengthOfLongestSubstring(s: string): number {
  const last = new Map<string, number>();
  let left = 0,
    best = 0;
  for (let right = 0; right < s.length; right++) {
    const c = s[right];
    const prev = last.get(c);
    if (prev !== undefined && prev >= left) left = prev + 1;
    last.set(c, right);
    best = Math.max(best, right - left + 1);
  }
  return best;
}
```

## 五、链表、树、回溯与 DP

```ts
// 单链表逆序: 迭代 O(n)/O(1), 递归 O(n)/O(n) 调用栈
function reverseList(head: ListNode | null): ListNode | null {
  let prev: ListNode | null = null;
  while (head) {
    const next = head.next;
    head.next = prev;
    prev = head;
    head = next;
  }
  return prev;
}
```

| 题         | 关键                                                                |
| ---------- | ------------------------------------------------------------------- |
| 二叉树 LCA | 递归：左右子树都命中则当前节点为 LCA；或父指针法转成「链表相交」    |
| 打家劫舍   | `dp[i] = max(dp[i-1], dp[i-2] + nums[i])`，滚动变量压到 `O(1)` 空间 |
| 组合总和   | 排序 + 回溯 + `start` 控制不重复组合，提前剪枝                      |
| 消消乐     | 栈：与栈顶相同则弹出，否则压入                                      |

## 六、等待图环检测

**题意陷阱**：等待图是**有向图**，并查集只能判无向图环，不能用。

```ts
// DFS 三色: 直接输出具体环路径, 适合告警带证据链
function hasCycle(graph: Map<string, string[]>): string[] | null {
  const color = new Map<string, 0 | 1 | 2>(); // 白 / 灰(在栈) / 黑
  const stack: string[] = [];
  function dfs(u: string): string[] | null {
    color.set(u, 1);
    stack.push(u);
    for (const v of graph.get(u) ?? []) {
      if (color.get(v) === 1) return stack.slice(stack.indexOf(v));
      if (color.get(v) !== 2) {
        const c = dfs(v);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  }
  for (const u of graph.keys())
    if (!color.get(u)) {
      const c = dfs(u);
      if (c) return c;
    }
  return null;
}
```

| 算法                           | 输出             | 适用             |
| ------------------------------ | ---------------- | ---------------- |
| DFS 三色 `O(V+E)`              | 具体环路径       | 告警要带证据链   |
| Kahn 拓扑 `O(V+E)`             | 环涉及的节点集合 | 实现简单、易并行 |
| Tarjan / Kosaraju SCC `O(V+E)` | 所有强连通分量   | 批量分析多个环   |

生产监控要按滑动窗口构图并剔除过期边，持续 N 个周期仍存在同一环才告警，避免把瞬时锁竞争当死锁。详见[Web 安全与可观测性](/interview/fundamentals/security-observability)。

## 七、手撕通用检查单

1. **先澄清**：语义歧义（固定窗口 vs 滑动窗口）、输入规模、是否允许重复、有序还是无序。
2. **参数校验**：空输入、单元素、容量为 0、负数、`limit < 1`。
3. **复杂度口述**：时间 / 空间 / 均摊，说明为什么。
4. **边界**：整数溢出、时钟回拨、同一毫秒重复、key 洪泛、Map 泄漏。
5. **并发与原子性**：单进程天然原子不等于多实例成立；检查与写入之间是否有竞态。
6. **工程对接**：`429` + `Retry-After`、幂等键、可注入时钟便于单测。
7. **测试**：至少覆盖 happy path、边界、恢复、并发/重复、参数非法五类。

## 八、面试怎么讲

| 加分                                           | 扣分                   |
| ---------------------------------------------- | ---------------------- |
| 先讲题意陷阱与澄清项，再写代码                 | 埋头写，不解释思路     |
| 主动给复杂度与工程延伸（分布式 / 并发 / 内存） | 只交一份单机单线程实现 |
| 写完自己跑边界 case                            | 只测示例输入           |
| 说清与 HTTP 状态码、退避策略的对接             | 把算法题与线上系统割裂 |

## 速记卡

- **LRU**：哈希表 + 双向链表，`get`/`put` 都移动；`Map` 插入序可简化实现。
- **LFU**：双哈希表 + `minFreq` + 同频 LRU 桶。
- **严格窗口总量**用滑动窗口日志；**允许突发**用令牌桶。
- **等待图是有向图**：DFS 三色给环路径，Kahn 给节点集合，并查集不适用。
- **手撕必答五项**：语义澄清、复杂度、边界、并发、与工程实现的对接。

## 延伸阅读

[JS 手写限流器](/interview/code/rate-limiter) · [Go 并发模型与 AI 网关工程](/interview/fundamentals/backend-go-gateway) · [全量题库](/interview/question-bank)
