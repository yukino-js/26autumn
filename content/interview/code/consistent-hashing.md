---
title: "代码题：手写一致性哈希"
description: "零依赖可运行的一致性哈希实现与自测: 强雪崩哈希函数选型、虚拟节点、二分查找顺时针定位、分布均匀性与最小重映射验证, 对照取模哈希、groupcache、yukino-cache-go 与 Redis Cluster 16384 槽"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清「为什么需要一致性哈希」，再给主实现、自测（含分布均匀性与最小重映射验证）与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`。
:::

## 题目

> 手写一致性哈希（Consistent Hashing）：支持 `addNode` / `removeNode` / `getNode(key)`，要求节点增减时**只有约 1/N 的键重新映射**，且负载尽量均匀。

## 开口先澄清语义（必拿分）

一致性哈希解决的是「**分片成员会变化时的键路由**」问题，采分点在于讲清「为什么取模不行」：

| 方案                 | 节点增减时的影响                                           | 负载均衡           |
| -------------------- | ---------------------------------------------------------- | ------------------ |
| 取模 `hash(key) % N` | **N 变化导致几乎全部键重新映射**（缓存全失效、数据全迁移） | 依赖哈希均匀性     |
| **一致性哈希**       | **仅相邻节点区间的键迁移，约 1/N**                         | 靠虚拟节点保证均匀 |

还要主动声明三个关键点：① **虚拟节点**——每个真实节点映射成多个虚拟节点散布在环上，虚拟节点越多分布越均匀、迁移越平滑（但环的元数据越大）；② **顺时针定位**——键哈希后找环上第一个 ≥ 它的虚拟节点，绕回环首；③ **哈希函数的雪崩性**——这是最容易被忽略但最致命的点（见下）。

## 关键踩坑：哈希函数的雪崩性决定分布

一致性哈希的均匀性**完全依赖哈希函数对虚拟节点名的散列质量**。一个常见的坑：用 FNV-1a 这类简单哈希对 `node#0`、`node#1`… 这类**顺序输入**做虚拟节点，由于雪崩性不足，虚拟节点会在环上聚簇，导致负载严重倾斜（实测 3 节点 30000 键出现 16221 / 6226 / 7553 的 2.6× 偏斜）。**必须用雪崩性强的哈希**（如 cyrb128、MurmurHash、xxHash），让相邻的虚拟节点名散列到环上互不相关的位置。这是「会写」与「写得对」的分水岭。

## 主实现

```js
// cyrb128: 强雪崩的 128 位字符串哈希, 取首个 32 位
// (FNV-1a 对 "node#i" 这类顺序输入雪崩不足, 会导致虚拟节点聚簇、负载倾斜)
function hash32(str) {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
}

class ConsistentHash {
  #replicas; // 每个真实节点的虚拟节点数
  #ring = new Map(); // hash -> node
  #sorted = []; // 升序的 hash 数组

  constructor(replicas = 100) {
    this.#replicas = replicas;
  }

  #rebuild() {
    this.#sorted = [...this.#ring.keys()].sort((a, b) => a - b);
  }

  addNode(node) {
    for (let i = 0; i < this.#replicas; i++) {
      this.#ring.set(hash32(`${node}#${i}`), node);
    }
    this.#rebuild();
  }

  removeNode(node) {
    for (let i = 0; i < this.#replicas; i++) {
      this.#ring.delete(hash32(`${node}#${i}`));
    }
    this.#rebuild();
  }

  getNode(key) {
    if (this.#sorted.length === 0) return null;
    const h = hash32(key);
    // 二分找第一个 >= h 的虚拟节点 (顺时针)
    let lo = 0,
      hi = this.#sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#sorted[mid] < h) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.#sorted.length) lo = 0; // 环回绕
    return this.#ring.get(this.#sorted[lo]);
  }
}
```

复杂度：`getNode` 是 O(log V)（V = 虚拟节点总数，二分查找）；`addNode`/`removeNode` 是 O(R + V log V)（R 为该节点虚拟节点数，重建排序）。生产实现通常用平衡树 / 跳表维护环，把增删节点降到 O(R log V) 而不全量重建。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 稳定路由: 同一 key 总是路由到同一 node
{
  const ch = new ConsistentHash(50);
  ["A", "B", "C"].forEach((n) => ch.addNode(n));
  assert(ch.getNode("user:123") === ch.getNode("user:123"), "稳定路由");
}

// 2. 分布均匀: 3 节点 30000 key, 每节点占比接近 1/3
{
  const ch = new ConsistentHash(150);
  ["A", "B", "C"].forEach((n) => ch.addNode(n));
  const cnt = { A: 0, B: 0, C: 0 };
  for (let i = 0; i < 30000; i++) cnt[ch.getNode("key:" + i)]++;
  const each = Object.values(cnt);
  assert(
    each.every((c) => c > 8000 && c < 12000),
    "分布均匀 " + JSON.stringify(cnt),
  );
}

// 3. 最小重映射: 加一个节点, 只有约 1/N 的 key 改变归属
{
  const ch = new ConsistentHash(150);
  ["A", "B", "C"].forEach((n) => ch.addNode(n));
  const before = {};
  for (let i = 0; i < 10000; i++) before["key:" + i] = ch.getNode("key:" + i);
  ch.addNode("D");
  let moved = 0;
  for (let i = 0; i < 10000; i++)
    if (ch.getNode("key:" + i) !== before["key:" + i]) moved++;
  assert(moved > 1500 && moved < 4000, "最小重映射 moved=" + moved + " (~25%)");
}

// 4. 移除节点: 只有该节点的 key 重新分配, 其他节点的 key 不动
{
  const ch = new ConsistentHash(150);
  ["A", "B", "C"].forEach((n) => ch.addNode(n));
  const before = {};
  for (let i = 0; i < 10000; i++) before["key:" + i] = ch.getNode("key:" + i);
  ch.removeNode("B");
  let movedFromOthers = 0;
  for (let i = 0; i < 10000; i++) {
    const k = "key:" + i;
    if (before[k] !== "B" && ch.getNode(k) !== before[k]) movedFromOthers++;
  }
  assert(movedFromOthers === 0, "移除 B 只影响 B 的 key");
}

// 5. 空环返回 null
{
  const ch = new ConsistentHash(10);
  assert(ch.getNode("x") === null, "空环 null");
}

// 6. 单节点: 所有 key 都路由到它
{
  const ch = new ConsistentHash(10);
  ch.addNode("only");
  let all = true;
  for (let i = 0; i < 100; i++) if (ch.getNode("k" + i) !== "only") all = false;
  assert(all, "单节点");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. 虚拟节点数量的权衡

虚拟节点数是「分布均匀度 + 迁移平滑度」与「环元数据大小 + 查找常数」的权衡。groupcache 默认副本数在数十量级（节点规模不大时无需调整）；节点越多、对均匀度要求越高，虚拟节点越多。**带权虚拟节点**还能表达异构容量：容量大的节点分配更多虚拟节点，自然承担更多负载。

### 2. 一致性哈希 vs Redis Cluster 的哈希槽

Redis Cluster **不用一致性哈希**，而是固定 **16384 个哈希槽**（`CRC16(key) % 16384`），槽与节点的映射由集群管理（见 [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure)）。两者的取舍：哈希槽把「键→槽」固定、「槽→节点」可变，扩缩容是「迁移槽」而非「重算环」，实现更简单、可控；一致性哈希的「键→节点」直接由环决定，去中心化更彻底但均匀度依赖虚拟节点。**面试能对比这两者，就是从「背算法」到「懂选型」的分水岭**。

### 3. 与项目经验的连接

- **groupcache**：用带虚拟副本的一致性哈希环在节点间分片缓存键，节点增减时仅相邻区间键迁移（见 [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure) 的 groupcache 章节）。
- **yukino-cache-go**：进程内两级 LRU + 一致性哈希在多实例间分片，配合 singleflight 合并回源（见 [Go singleflight 与两级 LRU](/interview/code/go-singleflight)）。
- **缓存失效放大**：一致性哈希节点故障时，该节点负责的键全部回源，容量评估要考虑这个放大（见中间件题库 groupcache 的「节点变更与故障」）。

面试时能把「手写一致性哈希」上升到「为什么取模不行、虚拟节点权衡、哈希雪崩性、与 Redis 哈希槽的对比」，就是从「会写」到「懂分布式」的分水岭。

---

**延伸阅读**

- [Go singleflight 与两级 LRU](/interview/code/go-singleflight)：一致性哈希在分布式缓存里的落地（配合 singleflight 防击穿）。
- [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure)：groupcache 一致性哈希与虚拟副本、Redis Cluster 16384 槽。
- [LRU 缓存](/interview/code/lru-cache)：一致性哈希常与 LRU 组合（分片 + 片内淘汰）。
- [Redis 技术深挖题库](/interview/qa/redis-internals)：Redis Cluster 哈希槽与数据倾斜。
- [分布式组件与一致性题库](/interview/qa/distributed-components)：分片、副本、数据迁移的通用原理。
