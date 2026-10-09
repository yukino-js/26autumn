---
title: "yukino_orm 技术笔记"
description: "yukino_orm 是构建在 MongoDB 官方驱动之上的 Knex 风格链式 Go ORM: 引擎与连接管理、链式查询构建、聚合分组、流式查询、事务与自增序列"
local_path: "$HOME/github/yukino.go/libs/yukino_orm"
---

yukino_orm 是一个面向 MongoDB 的 Go ORM, 设计主旨是把 Knex.js 的链式 (chainable) 查询体验带到 Go: 用 `Where` 系列方法累积条件, 用 `OrderBy`/`Limit`/`Offset`/`Select` 累积排序与分页, 只在调用终结方法时才真正访问数据库。它在官方驱动 `go.mongodb.org/mongo-driver/v2` 之上做薄封装, 因此仍然保留驱动的全部能力, 同时补上集合名反射推导、`$set` 自动包装、聚合与分组、流式游标、事务会话绑定与自增序列等常用能力。本文面向已经熟悉 MongoDB 文档模型、希望在 Go 中用一个统一的链式 API 组织查询的工程师, 说明其抽象模型、查询构建规则、执行语义与适用边界。

## 定位与设计原则

| 原则                   | 具体体现                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 链式而非结构化查询对象 | 所有条件、排序、分页方法都返回同一个 `Query` 指针, 可自由拼接                                                    |
| 延迟执行               | 构建阶段不访问数据库, 只有终结方法才把累积状态翻译成驱动调用                                                     |
| 不静默出错             | 非法的构建输入 (字段类型、操作符、参数个数) 被记录为错误, 在终结方法处以 error 返回, 而不是 panic 或发出错误查询 |
| 不静默覆盖             | 同一字段上的多个条件总是 AND 合并, 无法合并时用顶层 `$and` 保留                                                  |
| 贴近 Knex 的写语义     | 普通文档自动包 `$set`, `Update` 返回匹配数, `Insert` 接受切片, `Increment`/`Decrement` 直接可用                  |
| 薄封装                 | 未识别的操作符以 `$` 前缀透传, 原始驱动错误原样返回                                                              |

该库是仓库 `libs/` 下的独立 Go 模块, 模块内为扁平结构, 没有子包。

## 核心抽象

只有两个需要理解的类型:

| 抽象     | 职责                                                                 |
| -------- | -------------------------------------------------------------------- |
| `Engine` | 连接与数据库句柄, 是所有查询的入口, 也负责事务与自增序列             |
| `Query`  | 链式查询构建器, 累积条件/排序/分页/投影/分组状态, 并在终结方法中执行 |

```text
Engine
  |-- Client() / Database() / DatabaseName()
  |-- Collection(name)  -> Query(collection=name)
  |-- Model(value)      -> Query(collection=反射推导出的集合名)
  |-- Transaction(ctx, fn)   事务子 Engine (自动绑定 session)
  |-- NextSequence(name)     自增序列
  |
  +--> Query  链式累积: Where/OrderBy/Limit/Offset/Select/GroupBy/Having/...
             终结执行: Find/First/Insert/Update/Delete/Count/Exists/
                       Sum/Avg/Distinct/Pluck/Aggregate/Cursor/Each/...
```

`engine.Collection(name)` 在 name 为空或 engine 为 nil 时不会立即报错, 而是构造一个集合为 nil 的 Query, 真正的错误在终结方法的预检阶段以 `ErrCollectionRequired` 返回。

## Engine 与连接管理

`NewEngine(ctx, uri, database)` 在构造时做三件事: 校验 uri 与 database 去空白后非空 (否则分别返回 `mongo uri is required`、`mongo database is required`), 调用 `mongo.Connect`, 并对连接执行一次 `Ping`。Ping 失败时会立即关闭连接再返回错误, 避免留下悬空句柄。

| 方法                      | 行为                                         |
| ------------------------- | -------------------------------------------- |
| `Client()`                | 返回底层 `*mongo.Client`, nil 接收者返回 nil |
| `Database()`              | 返回底层 `*mongo.Database`                   |
| `DatabaseName()`          | 返回数据库名                                 |
| `Close(ctx)`              | 断开连接, nil 接收者或 nil client 时返回 nil |
| `DropDatabase(ctx)`       | 删除整个数据库                               |
| `Transaction(ctx, fn)`    | 开启会话并执行带自动提交/回滚的闭包          |
| `NextSequence(ctx, name)` | 返回全局递增的 int64                         |

所有 getter 都做了 nil 接收者保护, 因此在 engine 尚未初始化时调用不会 panic, 而是返回零值, 这让"先构造 Query 后补 engine"的代码路径更安全。

## 集合命名策略

`engine.Model(value)` 通过反射推导集合名, 规则为: 剥掉指针与切片/数组到达底层结构体, 把 CamelCase 转成 snake_case, 再按英文规则变复数。

| 结构体        | 集合名           |
| ------------- | ---------------- |
| `User`        | `users`          |
| `ChatHistory` | `chat_histories` |
| `Address`     | `addresses`      |
| `Category`    | `categories`     |
| `Day`         | `days`           |

复数规则覆盖常见情况: 辅音字母 + `y` 结尾改为 `-ies`; `s`/`x`/`sh`/`ch` 结尾加 `-es`; 其余加 `-s`。`Model` 也接受切片 (如 `[]*User`), 同样能得到 `users`。这套规则是纯机械的, 对不规则复数 (person/people) 与缩写 (HTTPServer 会得到 `h_t_t_p_server`) 不适用, 这类情况应直接用 `Collection("自定义名字")`。

若传入非结构体 (如字符串、数值), 推导结果为空串, 于是 `Collection("")` 产生一个 nil 集合的 Query, 在终结方法处返回 `ErrCollectionRequired`。

## 链式查询构建

### 条件方法

| 方法                                                                                                      | 生成的语义                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `Where(field, value)`                                                                                     | `field == value`; value 为 nil 时退化为 null 检查 |
| `Where(field, op, value)`                                                                                 | 按操作符比较                                      |
| `Where(bson.M{...})`                                                                                      | 对象形式, 每个键一个等值条件 (键排序后依次累积)   |
| `WhereNot(field, value)`                                                                                  | `$ne`                                             |
| `WhereIn` / `WhereNotIn`                                                                                  | `$in` / `$nin`                                    |
| `WhereNull` / `WhereNotNull`                                                                              | 等于 null / `$ne: nil`                            |
| `WhereBetween` / `WhereNotBetween`                                                                        | `$gte`+`$lte` / `$not{$gte,$lte}`                 |
| `WhereLike` / `WhereILike`                                                                                | SQL LIKE 模式转锚定正则, 后者加 `i` 选项          |
| `OrWhere(...)` 及 `OrWhereNot`/`OrWhereIn`/`OrWhereNotIn`/`OrWhereNull`/`OrWhereNotNull`/`OrWhereBetween` | 追加一个 `$or` 分支                               |

`Where` 只在参数个数为 1/2/3 时有效: 1 个参数必须是 `bson.M` 或 `map[string]any`, 2 个参数是字段与值, 3 个参数是字段、操作符、值。字段必须是去空白后非空的字符串, 操作符必须是字符串, 否则记录错误。

### 操作符

`Where` 的第二个参数在三个参数形式下按大小写不敏感的方式归一化:

| 写法                     | 归一化结果                               |
| ------------------------ | ---------------------------------------- |
| `=`, `==`                | 等值                                     |
| `!=`, `<>`               | `$ne`                                    |
| `>`, `>=`, `<`, `<=`     | `$gt` / `$gte` / `$lt` / `$lte`          |
| `in`, `not in`, `nin`    | `$in` / `$nin`                           |
| `like`, `ilike`          | 模式匹配                                 |
| `between`, `not between` | 区间匹配                                 |
| 其它以 `$` 开头的字符串  | 原样透传 (如 `$regex`、`$exists`、`$in`) |

其它任何未识别操作符都会被拒绝: 构建器记录错误, 下一次执行方法返回该错误, 不会把残缺的查询发给 MongoDB, 也不会 panic。`between`/`notBetween` 要求 2 元素切片或数组, `like`/`ilike` 要求字符串, 否则同样记录错误。

### 过滤文档的构建规则

构建器不会简单地把条件塞进一个 map, 而是区分"可合并"与"必须保留"的情况:

```text
Where("age", ">", 18).Where("age", "<", 30)   -> { age: { $gt: 18, $lt: 30 } }
Where("age", 18).Where("age", ">", 10)        -> { age: 18, $and: [ { age: { $gt: 10 } } ] }
Where("age", 18).Where("age", 18)             -> { age: 18, $and: [ { age: 18 } ] }
OrWhere("a", 1).OrWhere("b", 2)               -> { $or: [ { a: 1 }, { b: 2 } ] }
```

规则是: 同一字段上的多个操作符如果能合进一个操作符 map 就合并; 等值与操作符混用、重复等值、重复操作符等无法无损合并的情况, 用顶层 `$and` 数组保留, 绝不覆盖。构建器内部用 `opFields` 区分"框架自己生成的操作符 map"与"用户传入的恰好是 map 的等值", 避免误合并。

`OrWhere` 会追加一个 `$or` 分支; 若已有主条件链, 主链整体作为第一个分支。一个需要留意的语义: 在 `OrWhere` 之后新增的 `Where` 仍然并入主 AND 链, 因此 `Where(a).OrWhere(b).Where(c)` 等价于 `(a AND c) OR b`, 与 SQL 的操作符优先级不同, 建议把 `OrWhere` 写在最后。空对象的 `OrWhere(bson.M{})` 被当作空分支丢弃, 否则空分支会匹配全部文档。

`WhereLike`/`WhereILike` 会把 SQL LIKE 模式翻译成锚定正则: 先对模式做正则元字符转义, 再把 `%` 替换为 `.*`、`_` 替换为 `.`, 最后加上 `^` 与 `$`。`WhereILike` 额外设置 `i` 选项实现大小写不敏感。

### 排序、分页与投影

| 方法                     | 行为                                                 |
| ------------------------ | ---------------------------------------------------- |
| `OrderBy(field)`         | 升序 (默认)                                          |
| `OrderBy(field, "desc")` | 降序; 方向大小写不敏感, 非 `desc` 一律升序           |
| `Limit(n)`               | 仅在 `n > 0` 时生效                                  |
| `Offset(n)`              | 仅在 `n > 0` 时生效                                  |
| `Select(fields...)`      | 设置投影, 替换旧投影; 字段默认包含, `-` 前缀表示排除 |

MongoDB 只允许"包含投影"与"仅排除 `_id`"混用, 其它混合方式会被服务端拒绝。`Pluck` 内部会临时使用投影但不修改 Query 自身的投影状态。

### 克隆

`Query` 是可变的。要从一个公共基础派生多个变体, 应使用 `Clone`, 它会深拷贝条件、`$or` 分组、排序、投影、分组键、Having 条件与聚合别名, 使克隆体与原体互不影响。

```go
base := engine.Collection("users").Where("active", true)
adults := base.Clone().Where("age", ">=", 18)
minors := base.Clone().Where("age", "<", 18)
```

### 构建期错误模型

构建器把所有输入问题记录在内部的 `err` 字段 (只保留第一个), 终结方法在执行前的预检阶段统一返回。这样链式调用本身不会中断, 调用方只需在终结方法处检查一次错误。预检还会拒绝"存在未消费的 GroupBy/Having/聚合别名状态却调用了非 `Aggregate` 的终结方法", 防止分组状态被静默忽略。

## 执行方法

| 方法                         | 底层操作                         | 返回值与语义                                                                     |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `Insert(ctx, docs...)`       | `InsertOne` / `InsertMany`       | `InsertResult{InsertedIDs, InsertedCount}`; 单个切片参数会被展开; 空文档列表报错 |
| `First(ctx, out)`            | `FindOne`                        | 无匹配时返回 `ErrNotFound` (即驱动 `mongo.ErrNoDocuments` 的别名)                |
| `Find(ctx, out)`             | `Find` + `Cursor.All`            | 一次性加载全部匹配文档到 out                                                     |
| `Update(ctx, update)`        | `UpdateMany`                     | 返回匹配文档数 (knex 风格 affected rows), 影响所有匹配文档                       |
| `Upsert(ctx, update)`        | `UpdateMany` + `SetUpsert(true)` | 返回 `MatchedCount`/`ModifiedCount`/`UpsertedCount`/`UpsertedID`                 |
| `Increment(ctx, field, n?)`  | `Update` 包 `$inc`               | n 默认为 1, 返回匹配数                                                           |
| `Decrement(ctx, field, n?)`  | `Update` 包 `$inc` 负值          | n 默认为 1, 返回匹配数                                                           |
| `Delete(ctx)`                | `DeleteMany`                     | 返回删除文档数                                                                   |
| `Count(ctx)`                 | `CountDocuments`                 | 匹配数                                                                           |
| `Exists(ctx)`                | 基于 `Count`                     | 匹配数是否大于 0                                                                 |
| `EnsureIndexes(ctx, models)` | `Indexes().CreateMany`           | 返回创建的索引名; 空列表直接返回 nil                                             |
| `DropCollection(ctx)`        | `Collection.Drop`                | 删除整个集合                                                                     |

几个关键语义:

- `Update` 与 `Delete` 使用 `Many` 系列, 会作用于全部匹配文档。没有任何 `Where` 条件时它们会命中整个集合, 因此调用方必须在应用层保证至少有一个条件。
- `Insert` 的切片展开有白名单式的例外: `bson.D` (本身是切片但语义上是单个文档) 与字节切片不会被展开, 其余切片/数组会被摊平成多个文档。
- `Update`/`Upsert` 的更新文档会经过 `$set` 归一化: `bson.M`、`map[string]any`、`bson.D` 与结构体 (含指向结构体的指针) 若不含 `$` 前缀的键, 会被包成 `{$set: doc}`; 含有任一 `$` 键则原样透传。结构体更新会把所有被序列化的字段 (包括零值, 遵守 `omitempty` 标签) 写进 `$set`, 因此部分更新更适合用 `bson.M`。
- `First` 支持排序、偏移与投影; `Find` 与 `Cursor` 额外支持 limit。

## 聚合与分组

### 单值聚合

`Sum`、`Avg`、`Min`、`Max` 都通过一条 `$match` + `$group` 的聚合管线执行, 返回 `float64`:

```text
[ { $match: <条件链> },
  { $group: { _id: null, result: { $sum|$avg|$min|$max: "$field" } } } ]
```

`Sum`/`Avg` 对缺失或非数值字段返回 0; `Min`/`Max` 对非数值字段 (字符串、日期) 会在解码阶段失败, 这类字段应改用 `Distinct` 或自定义聚合管线。无匹配文档时返回 0。

| 方法                        | 说明                                                 |
| --------------------------- | ---------------------------------------------------- |
| `Distinct(ctx, field)`      | 返回 `[]any`; 只使用条件链, 忽略排序/分页/投影       |
| `CountDistinct(ctx, field)` | `Distinct` 结果的长度                                |
| `Pluck(ctx, field, out)`    | 把单字段值收集进 `out` (必须是指向切片的非 nil 指针) |

`Pluck` 支持点号路径, 内部用 `{field:1, _id:0}` 投影 (field 为 `_id` 时不排除 `_id`), 遵守排序/limit/offset, 不改动 Query 的投影状态; 缺失字段的文档会贡献该元素类型的零值。

### 分组聚合

分组聚合由 `GroupBy` + 累加器别名 + `Aggregate` 组成, 生成一条完整管线:

```text
$match(条件) -> $group(分组键 + 累加器) -> $project(平铺结果列)
  -> $match(having) -> $sort -> $skip -> $limit
```

累加器方法:

| 方法                  | 生成表达式                 |
| --------------------- | -------------------------- |
| `CountAs(alias)`      | `{ $sum: 1 }` (每组文档数) |
| `SumAs(field, alias)` | `{ $sum: "$field" }`       |
| `AvgAs(field, alias)` | `{ $avg: "$field" }`       |
| `MinAs(field, alias)` | `{ $min: "$field" }`       |
| `MaxAs(field, alias)` | `{ $max: "$field" }`       |

结果每行以顶层字段给出分组键与别名。单分组键时 `_id` 直接取该字段; 多分组键时 `_id` 是一个以平铺名称为键的子文档, `$project` 再把它展开。点号路径在结果中会平铺为下划线形式 (`addr.city` 变成 `addr_city`)。`Having` 接受与 `Where` 相同的参数形式, 但引用的是结果列名; `OrderBy` 同样只能引用结果列。

构建期会强制以下规则, 违反时返回错误而不是发出语义错误的管线:

| 规则                                          | 说明                                     |
| --------------------------------------------- | ---------------------------------------- |
| 必须至少有一个 `GroupBy` 键                   | 否则 `Aggregate` 报错                    |
| `Select` 不能与 `GroupBy` 组合                | 结果列固定为分组键与别名                 |
| 点号分组键不能平铺后冲突                      | 例如 `addr.city` 与 `addr_city` 同时出现 |
| 别名不能与分组键冲突、不能重复                | 否则结果列含义不明                       |
| 别名不能是 `_id`、不能以 `$` 开头、不能含 `.` | 避免与 Mongo 内部字段冲突或产生非法列名  |
| `Having`/`OrderBy` 只能引用结果列             | 未知列直接报错                           |
| 非 `Aggregate` 的终结方法不得携带分组状态     | 防止状态被静默忽略                       |

## 流式查询

`Find` 会把全部结果加载进内存, 大结果集应使用游标:

| 方法            | 风格 | 说明                                                   |
| --------------- | ---- | ------------------------------------------------------ |
| `Each(ctx, fn)` | 回调 | 自动打开与关闭游标, 回调返回错误时立即停止并返回该错误 |
| `Cursor(ctx)`   | 手动 | 返回 `*Cursor`, 调用方负责 `Close`                     |

`Cursor` 提供 `Next`、`Decode`、`Current` (原始 BSON)、`Err`、`Close`。两者都遵守 Query 的条件、排序、limit、offset 与投影, 并且在通过事务子 Engine 打开时会把后续的 `getMore`/`killCursors` 也绑定到事务会话上, 保证游标生命周期与事务一致。回调式 `Each` 是大多数场景下的首选, 因为它把"忘记关闭游标"这一常见缺陷从 API 层面消除。

## 事务

`engine.Transaction(ctx, fn)` 基于 MongoDB 会话与 `WithTransaction` 实现: 回调返回 nil 触发自动提交, 返回错误触发自动回滚。

```go
err := engine.Transaction(ctx, func(sc context.Context, tx *yukino_orm.Engine) error {
    if _, err := tx.Collection("accounts").
        Where("_id", fromID).
        Update(sc, bson.M{"$inc": bson.M{"balance": -amount}}); err != nil {
        return err
    }
    _, err := tx.Collection("accounts").
        Where("_id", toID).
        Update(sc, bson.M{"$inc": bson.M{"balance": amount}})
    return err
})
```

事务子 Engine 持有 session, 每个查询在执行前会把 session 绑定到上下文: 若传入的 context 尚未携带 session, 框架用 `mongo.NewSessionContext` 补上, 否则原样使用。因此即使调用方传入普通 context 而不是回调提供的 `sc`, 查询仍会加入事务; 但推荐始终使用 `sc`, 因为它携带了正确的事务截止时间与取消语义。注意事项: 不要在回调外保留 `tx`, 它的会话在回调返回后即结束; 事务要求 MongoDB 副本集或分片集群部署, 单机实例上会失败。

## 自增序列

`engine.NextSequence(ctx, name)` 实现经典的 counters 集合模式: 在 `counters` 集合中以 name 为 `_id`, 用 `FindOneAndUpdate` 配合 `$inc: {value: 1}` 与 upsert, 并返回更新后的文档, 因此每次调用得到全局递增的 `int64` (1, 2, 3, ...)。原子性由 MongoDB 的单文档更新保证, 每个序列名对应一个独立文档。它同样会绑定当前 engine 的会话, 因此在事务子 Engine 上调用时也参与事务。

## 日志

库内置一个带颜色与级别的日志器:

| 调用               | 输出目标                      |
| ------------------ | ----------------------------- |
| `Info` / `Infof`   | 标准输出, 蓝色 `[info ]` 前缀 |
| `Error` / `Errorf` | 标准错误, 红色 `[error]` 前缀 |

级别常量的数值顺序是 `InfoLevel (0) < ErrorLevel (1) < Disabled (2)`, 数值越大输出越少。`SetLevel(InfoLevel)` 打开全部日志; `SetLevel(ErrorLevel)` 只保留错误; `SetLevel(Disabled)` 全部静默。级别切换是全局的, 会影响该进程内所有使用该库的代码。

## 错误处理

| 错误                         | 触发条件                                                                   |
| ---------------------------- | -------------------------------------------------------------------------- |
| `mongo uri is required`      | `NewEngine` 的 uri 去空白后为空                                            |
| `mongo database is required` | `NewEngine` 的 database 去空白后为空                                       |
| `ErrCollectionRequired`      | 终结方法执行时 Query 未绑定集合 (例如 `Collection("")` 或非结构体 `Model`) |
| `ErrNotFound`                | `First` 无匹配文档, 是 `mongo.ErrNoDocuments` 的别名                       |
| 构建期错误                   | 非法字段类型、未识别操作符、错误的参数个数/类型, 在终结方法处返回          |
| 分组校验错误                 | `GroupBy`/`Having`/`Aggregate` 违反上文规则                                |
| 驱动原生错误                 | 其余情况原样透传, 可用 `errors.Is` 等标准方式判断                          |

对常见错误 (无匹配、唯一键冲突、上下文超时) 建议在应用层建一层统一的错误包装, 库本身只做透传。

## 并发与安全约束

- `Query` 是可变的、有状态的, 不是并发安全的。多个 goroutine 不能共享同一个 Query; 需要派生变体请用 `Clone`, 需要并发执行请为每个 goroutine 创建独立的 Query。
- 无条件的 `Update`/`Delete` 会命中整个集合, 调用方必须在应用层保证条件存在。
- 结构体更新会把零值一并写入 `$set` (除非标注 `omitempty`), 这可能覆盖数据库中的既有值; 需要局部更新时使用 `bson.M`。
- 字段名、操作符、别名等外部输入在构建期被校验, 但仍不建议把未经清洗的用户输入直接拼成字段名。

## 性能与资源约束

| 关注点   | 现状                                                                 | 建议                                                 |
| -------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| 大结果集 | `Find` 一次性 `Cursor.All` 进内存                                    | 使用 `Each`/`Cursor` 流式处理                        |
| 网络传输 | 默认无投影时返回整文档                                               | 用 `Select` 只取需要的字段                           |
| 聚合     | 单值聚合走 `$match` + `$group` 两阶段管线                            | 条件链会下推到 `$match`, 但排序/分页对单值聚合无意义 |
| 分组聚合 | `$match -> $group -> $project -> $match -> $sort -> $skip -> $limit` | 先过滤再分组, 尽量让 `Where` 命中索引                |
| 索引     | 提供 `EnsureIndexes` 但不自动建索引                                  | 应用启动时显式创建所需索引                           |
| 游标     | `Each` 自动关闭, 手动 `Cursor` 需自行关闭                            | 优先使用 `Each`                                      |
| 事务     | 会话绑定使 `getMore`/`killCursors` 也留在事务内                      | 事务内避免长耗时的流式扫描                           |

## 可测试性

测试套件为每个用例创建带时间戳隔离的临时数据库, 并在清理时删除, 因此用例之间不会互相污染。默认连接 `mongodb://localhost:27017`, 可通过环境变量 `MONGO_URI` 覆盖。若目标 MongoDB 需要认证而调用方未提供凭据, 集成测试会被跳过而不是失败, 便于在 CI 中运行。纯构建逻辑 (条件合并、操作符别名、LIKE 转换、`$set` 归一化、集合命名、投影、克隆独立性、分组校验) 都有不依赖数据库的单元测试, 而插入/查询/更新/删除/聚合/事务/游标等依赖真实实例的行为由集成测试覆盖。

## 适用场景与选型建议

适合使用 yukino_orm 的场景:

- 团队习惯了 Knex.js 的链式风格, 希望在 Go 与 MongoDB 之间获得相似的表达方式。
- 需要把条件、排序、分页、投影、聚合、分组、流式游标、事务与自增序列统一到一套 API 下, 而不想直接操作驱动的 `options` 组合。
- 希望集合名由结构体自动推导, 减少硬编码字符串。
- 需要链式构建期就捕获非法输入并在执行点统一返回错误, 避免发出语义错误的查询。

不适合或需要谨慎评估的场景:

- 需要类型安全的查询构建 (编译期检查字段名与类型): 当前不支持泛型化查询, 字段名是字符串。
- 需要回调式嵌套分组 (`where(qb => {...})`): 当前未提供, 复杂布尔表达式需要拆成多次构建或直接传原始 `bson.M`。
- 需要跨集合关联、迁移管理或 schema 定义: 库只做查询构建, 不提供这些 ORM 能力。
- 需要在单个 Query 上并发执行: `Query` 有可变状态, 并发场景应为每个 goroutine 使用独立 Query。
- 需要不规则复数或缩写命名的集合: 应显式使用 `Collection`。

相关主题: 集合名推导、`$set` 归一化与 `Pluck` 的元素构造都建立在反射之上, `bson` 标签则是驱动与本库共用的字段映射扩展点, 这些语言层机制见 [Go 语言核心](go); 把查询结果挡在数据库之前的缓存层设计见 [yukino_cache](yukino-cache)。
