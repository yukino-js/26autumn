---
title: "代码题：手写 LRU 缓存"
description: "零依赖可运行的 LRU Cache 实现与自测: JS Map 插入序 O(1) get/put、双向链表+哈希表的通用 O(1) 结构、容量淘汰与新鲜度刷新, 延伸到 LFU、TTL、两级 LRU 与一致性哈希, 对照 Redis 近似 LRU 与 groupcache/yukino-cache-go"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清 LRU 的语义与 O(1) 要求，再给主实现、通用结构、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`。
:::

## 题目

> 手写一个 LRU（Least Recently Used）缓存：`get(key)` 与 `put(key, value)` 都要求 **O(1)** 时间复杂度，容量满时淘汰**最久未使用**的键。

## 开口先澄清语义（必拿分）

LRU 看似简单，但面试官在意的是「**为什么能 O(1)**」与一组语义边界：

| 维度               | 要点                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| **O(1) 的来源**    | 哈希表给 O(1) 定位，有序结构（双向链表 / 插入序 Map）给 O(1) 调整新鲜度与淘汰最旧——两者缺一不可 |
| **「使用」的定义** | `get` 与 `put`（命中已存在键）都算「使用」，都要把键刷新为最近；只 `put` 新键不算刷新旧键       |
| **淘汰时机**       | 容量满时淘汰**最久未使用**（队首），不是「最早插入」（那是 FIFO）                               |
| **get 未命中**     | 返回 `undefined`/`-1`，不改变结构                                                               |
| **容量边界**       | 容量为 0 / 负数应拒绝；容量为 1 时每次 put 新键都淘汰旧键                                       |

**LRU vs FIFO 的区别**是高频追问：FIFO 按「插入顺序」淘汰最早插入的，LRU 按「访问顺序」淘汰最久未访问的——一个被频繁访问的老键，FIFO 会淘汰它，LRU 会保留它。

## 主实现 · JS Map（利用插入序）

JS 的 `Map` **保持插入顺序**，且 `delete` + `set` 能把一个键移到末尾。利用这个特性，无需手写双向链表即可得到 O(1) 的 LRU：

```js
class LRUCache {
  #map = new Map(); // 插入序: 首键=最久未使用, 末键=最近使用
  #capacity;

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError("capacity must be an integer >= 1");
    this.#capacity = capacity;
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key); // 删除后重插, 移到末尾(标记为最近使用)
    this.#map.set(key, value);
    return value;
  }

  put(key, value) {
    if (this.#map.has(key)) this.#map.delete(key); // 已存在先删, 重插到末尾刷新新鲜度
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) {
      const oldest = this.#map.keys().next().value; // 首键 = 最久未使用
      this.#map.delete(oldest);
    }
  }

  has(key) {
    return this.#map.has(key);
  }
  get size() {
    return this.#map.size;
  }
  keys() {
    return [...this.#map.keys()]; // 从最久到最近
  }
}
```

复杂度：`get`/`put` 都是 O(1)——`Map.has/get/delete/set` 均摊 O(1)，`keys().next().value` 取首键也是 O(1)（迭代器的第一个元素）。

## 通用结构 · 双向链表 + 哈希表

在没有「插入序 Map」的语言里（或面试要求「不用库特性」时），经典答案是**哈希表 + 双向链表**：哈希表 `key -> 链表节点` 给 O(1) 定位，双向链表按访问顺序排列（头=最近，尾=最久）。`get` 命中时把节点移到头部；`put` 时新节点插头部，超容量则摘除尾部节点并从哈希表删除对应键。

```text
hashmap: key -> node
list:    head <-> nodeA <-> nodeB <-> ... <-> nodeZ <-> tail
         (最近)                              (最久, 先淘汰)

get(key):  node = hashmap[key]; 把 node 摘出并移到 head 之后; 返回 node.value
put(key,v): 若存在则更新并移到 head; 否则新建节点插 head, 超容量则删 tail 前一个节点 + hashmap 对应键
```

**Go 的标准做法**是用 `container/list`（双向链表）+ `map[string]*list.Element`，这正是 [Go singleflight 与两级 LRU](/interview/code/go-singleflight) 里 yukino-cache-go 的 LRU 实现方式；**Redis 的近似 LRU** 则不维护全局链表（指针内存与操作开销太大），而是「随机采样 N 个键淘汰其中最久未访问的」（见 [Redis 技术深挖题库](/interview/qa/redis-internals) 的 Q21）。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 基本 get/put
{
  const c = new LRUCache(2);
  c.put("a", 1);
  c.put("b", 2);
  assert(c.get("a") === 1, "get a");
  assert(c.get("b") === 2, "get b");
}
// 2. 超容量淘汰最久未使用
{
  const c = new LRUCache(2);
  c.put("a", 1);
  c.put("b", 2);
  c.put("c", 3); // 淘汰 a (最久未使用)
  assert(!c.has("a"), "a 被淘汰");
  assert(c.get("b") === 2 && c.get("c") === 3, "b/c 保留");
}
// 3. get 刷新新鲜度: a 被访问后, 淘汰的是 b 而非 a
{
  const c = new LRUCache(2);
  c.put("a", 1);
  c.put("b", 2);
  c.get("a"); // a 变最近
  c.put("c", 3); // 淘汰 b
  assert(!c.has("b"), "b 被淘汰(a 被 get 刷新)");
  assert(c.get("a") === 1 && c.get("c") === 3, "a/c 保留");
}
// 4. put 已存在键: 更新值并刷新新鲜度
{
  const c = new LRUCache(2);
  c.put("a", 1);
  c.put("b", 2);
  c.put("a", 10); // 更新 a, a 变最近
  c.put("c", 3); // 淘汰 b
  assert(!c.has("b"), "b 被淘汰(a 被更新刷新)");
  assert(c.get("a") === 10, "a 值已更新");
}
// 5. get 不存在的键返回 undefined
{
  const c = new LRUCache(2);
  assert(c.get("nope") === undefined, "未命中返回 undefined");
}
// 6. 容量 1
{
  const c = new LRUCache(1);
  c.put("a", 1);
  c.put("b", 2); // 淘汰 a
  assert(!c.has("a") && c.get("b") === 2, "容量 1");
}
// 7. keys 顺序: 从最久到最近
{
  const c = new LRUCache(3);
  c.put("a", 1);
  c.put("b", 2);
  c.put("c", 3);
  c.get("a"); // a 变最近
  assert(c.keys().join(",") === "b,c,a", "keys 从最久到最近");
}
// 8. 非法容量抛错
{
  let threw = false;
  try {
    new LRUCache(0);
  } catch (e) {
    threw = true;
  }
  assert(threw, "容量 0 抛 RangeError");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. LRU vs LFU：什么时候 LRU 不够

LRU 的缺陷是**缓存污染**：一次性批量扫描大量「只访问一次」的冷数据，会把真正的热数据挤出去。LFU（Least Frequently Used）按访问频率淘汰，能抵抗扫描型污染，但要维护频率计数与频率桶，且「历史热点」可能永远不被淘汰（需要频率衰减）。**Redis 同时提供近似 LRU 与近似 LFU**（`maxmemory-policy` 的 `allkeys-lru` / `allkeys-lfu`），LFU 用 24 位字段的高 16 位存访问时间、低 8 位存对数计数器，并用 `lfu-decay-time` 让计数随时间衰减（见 [Redis 技术深挖题库](/interview/qa/redis-internals) Q21）。

### 2. 带 TTL 的 LRU

生产缓存几乎都要 TTL。实现要点：① 每个条目存 `expireAt`，`get` 时先判过期（惰性删除，过期即视为未命中并删除）；② 淘汰时「过期优先于 LRU」——先清过期条目，不够再按 LRU 淘汰；③ 可选定期扫描（类似 Redis 的定期删除）兜底清理不再被访问的过期键。注意 TTL 与 LRU 是两个正交维度：TTL 管「数据还能不能用」，LRU 管「容量满了淘汰谁」。

### 3. 两级 LRU 与 singleflight

真实的缓存系统往往是**两级**的：进程内 LRU（L1，无网络开销）+ 分布式缓存（L2，如 Redis）。yukino-cache-go 就是这个模式——进程内两级 LRU + singleflight 合并并发回源 + 一致性哈希在节点间分片（见 [Go singleflight 与两级 LRU](/interview/code/go-singleflight)）。**singleflight 解决的是「缓存击穿」**：热点键失效瞬间大量并发回源，用 singleflight 让同键并发只回源一次、其余等待共享结果（见 [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure) 的 groupcache 章节）。

### 4. 与项目经验的连接

- **yukino-chat 的会话记忆**：每用户 Agent 运行时的空闲回收、连接表都是「容量有界 + 淘汰最久未用」的 LRU 思想。
- **yukino-chatbot 的进程内 LRU 降级**：Redis 不可用时降级到进程内 LRU（最大 10000 条目、256MB、TTL 10 分钟），正是「带字节预算与 TTL 的 LRU」。
- **groupcache 的主/热双缓存**：用字节预算约束、按「最旧优先 + 热缓存超 1/8 时优先淘汰热缓存」驱逐，是 LRU 在去中心化缓存里的变体。

面试时能把「手写 LRU」上升到「LRU vs LFU 的污染抵抗、TTL 与 LRU 的正交、两级缓存 + singleflight 防击穿」，就是从「会写数据结构」到「懂缓存系统」的分水岭。

---

**延伸阅读**

- [Go singleflight 与两级 LRU](/interview/code/go-singleflight)：Go `container/list` 实现的两级 LRU + singleflight 合并回源。
- [Redis 技术深挖题库](/interview/qa/redis-internals)：近似 LRU/LFU 的采样实现、过期删除与内存淘汰策略。
- [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure)：groupcache 的一致性哈希、singleflight 与主/热双缓存。
- [Yukino 缓存与 ORM 题库](/interview/qa/yukino-cache-orm)：缓存封装、并发重建与失效广播在 Go 工程中的落地。
- [JavaScript 与 TypeScript 题库](/interview/qa/js-ts-language)：Map 插入序、私有字段、迭代器等语言基础。
