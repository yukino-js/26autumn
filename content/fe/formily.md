---
title: "Formily 新手入门教程与原理解析"
---

本机器路径: 请克隆 git clone git@github.com:alibaba/formily.git

## 〇、一个 JSON 看懂 Formily 所有 Schema 驱动能力

下面这份 schema 是一份能力地图: 它覆盖了 Formily schema 驱动模式的全部能力, 从标准 JSON Schema 语义、字段类型、渲染与状态声明, 到联动、校验和表达式作用域. 建议先通读一遍, 再对照第八节逐条理解. 本文所有协议细节均按 @formily/json-schema@2.3.7 源码核对.

一点提醒: 根节点 schema 本身不会创建字段 (RecursionField 对没有 name 的根节点只递归渲染 properties) , 所以 x-component、default 这些只在字段节点上才生效. 表单级的初始值用 createForm(\{ initialValues \}) 设置.

```jsonc
{
  // 根节点只做容器: 声明 type 为 object, 下面挂 properties
  "type": "object",

  "properties": {
    // ========== 1. VoidField: 纯布局, 不产生数据路径 ==========
    // 表单级布局用一个 void 字段包裹, x-component 指向布局容器
    "layout": {
      "type": "void",
      "x-component": "FormLayout", // 作用于其下所有子字段
      "x-component-props": { "layout": "horizontal", "labelCol": 6 },
      "properties": {
        "username": {
          // ========== 2. 渲染 ==========
          "type": "string",
          "title": "用户名",
          "description": "字段级说明",
          "x-decorator": "FormItem", // 外壳: 渲染 label、必填星号、校验反馈
          "x-decorator-props": { "tooltip": "登录账号" },
          "x-component": "Input", // 输入控件, 从 createSchemaField 注册的组件表查找
          "x-component-props": { "placeholder": "请输入" },
          "x-index": 0, // 同级字段排序权重, 越小越靠前

          // ========== 3. 校验 ==========
          "required": true, // 标准关键字, 自动并入 validator
          "x-validator": [
            { "format": "email" }, // 内置格式: email/url/ipv4/ipv6/phone/date/money/zh/zip/qq
            { "min": 2, "max": 32 }, // 字符串长度或数值范围
            { "pattern": "^[a-zA-Z]" }, // 正则
            { "validator": "{{(v) => v === 'admin' ? '不允许该用户名' : ''}}" }, // 自定义 (支持异步)
          ],

          // ========== 4. 状态 ==========
          // x-display: visible / hidden (不渲染但保留值) / none (不渲染且从 values 删除)
          "x-display": "visible",
          // x-pattern: editable / disabled / readOnly / readPretty (详情态)
          "x-pattern": "editable",
          "x-value": "", // 直接设置字段值, 写入 form.values
          // 快捷开关: x-visible/x-hidden -> display, x-disabled/x-editable/x-read-only/x-read-pretty -> pattern
          "x-data": { "bizId": "demo" }, // 自定义业务数据, 挂到 field.data 上

          // ========== 5. 联动 (声明式) ==========
          // dependencies 收集依赖 -> when 求值 -> fulfill/otherwise 二选一执行
          "x-reactions": {
            "dependencies": ["orderType"],
            "when": "{{$deps[0] === 'vip'}}",
            "fulfill": {
              "state": { "pattern": "readPretty" }, // 满足: 切详情态
              "schema": { "x-component-props.placeholder": "VIP 用户名" }, // 也可以改协议属性
              "run": "console.log($self.value)", // 执行一段代码, 作用域同表达式
            },
            "otherwise": { "state": { "pattern": "editable" } },
          },
        },
        "orderType": {
          "type": "string",
          "title": "订单类型",
          "default": "normal", // 字段级 default -> field.initialValue (用于 reset 还原)
          "enum": [
            // enum -> field.dataSource, 选择类组件消费
            { "label": "普通", "value": "normal" },
            { "label": "VIP", "value": "vip" },
          ],
          "x-decorator": "FormItem",
          "x-component": "Select",
          "x-index": 1,

          // ========== 6. 联动 (函数式 + 被动联动) ==========
          "x-reactions": [
            // 函数式: 整个 reaction 是一段函数, autorun 自动追踪读取的 observable
            "{{(field) => { field.visible = $values.username !== '' }}}",
            // 被动联动: target 指定要驱动的目标字段,
            // effects 指定监听本字段的哪些生命周期 (默认 onFieldInit + onFieldValueChange),
            // 表达式中用 $target 读写目标字段状态
            {
              "target": "user.contact.phone",
              "effects": ["onFieldValueChange"],
              "fulfill": {
                "state": { "required": "{{$self.value === 'vip'}}" },
              },
            },
          ],
        },
      },
    },

    // ========== 7. ObjectField: 嵌套对象 ==========
    "user": {
      "type": "object",
      "properties": {
        "contact": {
          "type": "object",
          "properties": {
            "phone": {
              "type": "string",
              "title": "手机号",
              "x-decorator": "FormItem",
              "x-component": "Input",
              "x-validator": { "format": "phone" },
            },
          },
        },
      },
    },

    // ========== 8. ArrayField: 数组字段 ==========
    "items": {
      "type": "array",
      "title": "商品列表",
      "x-decorator": "FormItem",
      "x-component": "ArrayItems",
      "items": {
        "type": "object",
        "properties": {
          "index": { "type": "void", "x-component": "ArrayItems.Index" }, // 行序号
          "name": {
            "type": "string",
            "title": "商品名",
            "x-decorator": "FormItem",
            "x-component": "Input",
            // 数组行内作用域: $record 当前行值, $index 行号, $records 全部行
            "x-reactions": "{{(field) => { field.title = '第 ' + ($index + 1) + ' 行' }}}",
          },
          "remove": { "type": "void", "x-component": "ArrayItems.Remove" }, // 删除按钮
          "moveUp": { "type": "void", "x-component": "ArrayItems.MoveUp" }, // 上移按钮
        },
      },
      "properties": {
        "addition": {
          "type": "void",
          "title": "添加条目",
          "x-component": "ArrayItems.Addition", // 追加按钮, 操作 array field 的 push
        },
      },
    },

    // ========== 9. 表达式 ==========
    // 任意协议属性值写成 "{{表达式}}" 都会被编译执行 (compiler.ts),
    // 可用作用域: $self 当前字段, $form 表单, $values 表单值, $deps 依赖值,
    // $target 目标字段, $record/$records/$index 数组行, $props 改组件 props,
    // $effect/$memo/$observable 响应式工具
    "submit": {
      "type": "void",
      "x-component": "FormButtonGroup",
      "properties": {
        "submitBtn": {
          "type": "void",
          "x-content": "提交", // -> field.content, 作为组件 children 渲染 (按钮文字)
          "x-component": "Submit",
          "x-component-props": {
            "disabled": "{{!$form.valid}}", // 表单无效时禁用提交
          },
        },
      },
    },
  },
}
```

渲染这份 schema 只需要:

```tsx
const SchemaField = createSchemaField({
  components: {
    FormLayout,
    FormItem,
    Input,
    Select,
    ArrayItems,
    FormButtonGroup,
    Submit, // 均来自 @formily/antd
  },
});

const form = createForm({ initialValues: { orderType: "normal" } });

export default () => (
  <FormProvider form={form}>
    <SchemaField schema={schema} />
  </FormProvider>
);
```

能力速查表:

| 分组     | 协议键                                                                                                                  | 落到哪里                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 标准语义 | type / title / description / default / required / enum                                                                  | 字段模型、initialValue、dataSource          |
| 渲染     | x-component / x-component-props / x-decorator / x-decorator-props / x-content / x-index                                 | componentType、decoratorType、content、排序 |
| 状态     | x-display / x-pattern / x-visible / x-hidden / x-disabled / x-editable / x-read-only / x-read-pretty / x-value / x-data | display、pattern、value、field.data         |
| 校验     | x-validator + required/format/pattern/min/max 等标准关键字                                                              | field.validator                             |
| 联动     | x-reactions (声明式 / 函数式 / 被动联动)                                                                                | createReactions 执行                        |
| 表达式   | `"{{...}}"`                                                                                                             | compiler.ts 编译求值                        |

---

## 一、Formily 是什么

Formily 是阿里巴巴开源的一款高性能表单解决方案. 它的核心设计理念是将表单字段的状态进行分布式管理, 每个字段独立渲染、独立更新, 从而避免了传统受控表单中"改一个字段、整棵树重渲染"的性能问题.

Formily 2.x 采用 monorepo 架构, 由多个独立的 npm 包组成, 各司其职:

| 包名                    | 职责                                         |
| ----------------------- | -------------------------------------------- |
| @formily/reactive       | 响应式状态管理引擎 (类似 MobX)               |
| @formily/core           | 表单领域模型 (Form、Field、生命周期、副作用) |
| @formily/react          | React 绑定层 (组件、Hooks、Schema 渲染)      |
| @formily/reactive-react | 将 reactive 与 React 渲染桥接 (observer)     |
| @formily/json-schema    | JSON Schema 协议解析与字段转换               |
| @formily/path           | 表单字段路径系统                             |
| @formily/shared         | 公共工具函数、事件订阅基类                   |
| @formily/validator      | 校验引擎                                     |
| @formily/antd           | Ant Design 组件适配                          |
| @formily/next           | Fusion Next 组件适配                         |

它们之间的依赖关系可以用一句话概括: reactive 是地基, core 是骨架, react 是皮肤, json-schema 是协议层.

---

## 二、快速上手

### 2.1 安装

```bash
# React + Ant Design 场景
npm install @formily/core @formily/react @formily/antd antd

# 或者使用 Fusion Next
npm install @formily/core @formily/react @formily/next @alifd/next
```

### 2.2 第一个表单 (JSX 模式)

```tsx
import React from "react";
import { createForm } from "@formily/core";
import { FormProvider, Field } from "@formily/react";
import { Input, FormItem } from "@formily/antd";

const form = createForm();

export default () => (
  <FormProvider form={form}>
    <Field
      name="username"
      title="用户名"
      required
      decorator={[FormItem]}
      component={[Input, { placeholder: "请输入用户名" }]}
    />
    <Field
      name="password"
      title="密码"
      required
      decorator={[FormItem]}
      component={[Input.Password]}
    />
    <button onClick={() => form.submit(console.log)}>提交</button>
  </FormProvider>
);
```

这段代码做了三件事:

1. createForm() 创建一个表单模型实例, 它管理所有字段的状态和值.
2. FormProvider 通过 React Context 将 form 实例注入组件树.
3. Field 组件声明一个表单字段, name 是字段标识, decorator 是包裹层 (通常是 FormItem, 负责渲染 label 和错误信息) , component 是实际的输入控件.

### 2.3 第一个表单 (JSON Schema 模式)

```tsx
import React from "react";
import { createForm } from "@formily/core";
import { createSchemaField, FormProvider } from "@formily/react";
import { Input, FormItem, FormLayout } from "@formily/antd";

const SchemaField = createSchemaField({
  components: { Input, FormItem, FormLayout },
});

const form = createForm();

const schema = {
  type: "object",
  properties: {
    username: {
      type: "string",
      title: "用户名",
      required: true,
      "x-decorator": "FormItem",
      "x-component": "Input",
      "x-component-props": { placeholder: "请输入用户名" },
    },
    password: {
      type: "string",
      title: "密码",
      required: true,
      "x-decorator": "FormItem",
      "x-component": "Input.Password",
    },
  },
};

export default () => (
  <FormProvider form={form}>
    <SchemaField schema={schema} />
    <button onClick={() => form.submit(console.log)}>提交</button>
  </FormProvider>
);
```

JSON Schema 模式的核心优势是: 表单结构完全由数据描述, 可以由后端下发, 实现"后端驱动表单渲染".

### 2.4 字段联动

联动是表单中最常见的需求. Formily 提供了 x-reactions 协议:

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "title": "类型",
      "enum": ["personal", "company"],
      "x-decorator": "FormItem",
      "x-component": "Select"
    },
    "companyName": {
      "type": "string",
      "title": "公司名称",
      "x-decorator": "FormItem",
      "x-component": "Input",
      "x-reactions": {
        "dependencies": ["type"],
        "fulfill": {
          "state": {
            "visible": "{{$deps[0] === 'company'}}"
          }
        }
      }
    }
  }
}
```

当 type 字段的值变为 "company" 时, companyName 字段自动显示; 否则隐藏.

### 2.5 使用 Effects 处理副作用

对于更复杂的联动逻辑, 可以使用 effects:

```tsx
import { createForm, onFieldValueChange } from "@formily/core";

const form = createForm({
  effects() {
    onFieldValueChange("type", (field) => {
      const companyField = field.query("companyName").take();
      if (companyField) {
        companyField.visible = field.value === "company";
      }
    });
  },
});
```

---

## 三、架构全景

```
+----------------------------------------------------------+
|                    用户代码 / UI 层                      |
|   <FormProvider> <SchemaField> <Field> <FormConsumer>    |
+---------------------------+------------------------------+
                            |
+---------------------------v------------------------------+
|              @formily/react (React 绑定层)               |
|  connect / mapProps / observer / hooks / contexts        |
+---------------------------+------------------------------+
                            |
+---------------------------v------------------------------+
|         @formily/reactive-react (渲染桥接层)             |
|  observer() -> useObserver() -> Tracker -> forceUpdate   |
+---------------------------+------------------------------+
                            |
+---------------------------v------------------------------+
|              @formily/core (表单领域模型)                |
|  Form / Field / ArrayField / ObjectField / VoidField     |
|  Heart (事件中心) / Graph (字段图) / LifeCycle / Effects |
+---------------------------+------------------------------+
                            |
+---------------------------v------------------------------+
|            @formily/reactive (响应式引擎)                |
|  observable / autorun / reaction / computed / batch      |
|  Proxy 拦截 -> 依赖收集 -> 精确更新                      |
+----------------------------------------------------------+
```

辅助层:

```
@formily/json-schema --> 将 JSON Schema 转换为 Field Props
@formily/path        --> 字段路径解析、匹配、寻址
@formily/validator   --> 校验规则解析与执行
@formily/shared      --> Subscribable 事件基类、工具函数
```

---

## 四、原理解析: @formily/reactive 响应式引擎

这是整个 Formily 的地基. 理解了它, 就理解了 Formily 为什么能做到"字段级精确更新".

### 4.1 核心思想

reactive 是一个基于 ES6 Proxy 的响应式状态管理库, 设计思路与 MobX 高度相似, 但实现更轻量. 它的核心循环是:

```
读取数据 -> 收集依赖 -> 修改数据 -> 触发依赖 -> 重新执行
```

用代码表达:

```ts
import { observable, autorun } from "@formily/reactive";

const state = observable({ count: 0 });

autorun(() => {
  console.log(state.count); // 读取 -> 收集依赖
});

state.count = 1; // 修改 -> 触发依赖 -> 重新打印 1
```

### 4.2 数据结构

reactive 维护了几张全局的 WeakMap 和栈结构 (定义在 environment.ts 中) :

```ts
// 原始对象 -> 代理对象 的映射
export const RawProxy = new WeakMap();
// 代理对象 -> 原始对象 的映射
export const ProxyRaw = new WeakMap();
// 原始对象 -> 依赖关系图 的映射 (核心! )
export const RawReactionsMap = new WeakMap<object, ReactionsMap>();
// 当前正在执行的 reaction 栈
export const ReactionStack: Reaction[] = [];
// 批处理计数器
export const BatchCount = { value: 0 };
// 待执行的 reactions 队列
export const PendingReactions = new ArraySet<Reaction>();
```

其中 RawReactionsMap 的结构是:

```
WeakMap<target, Map<key, ArraySet<Reaction>>>
```

含义是: 对于某个原始对象 target 的某个属性 key, 有哪些 Reaction 依赖了它.

### 4.3 Proxy 拦截: 依赖收集

当你调用 observable(obj) 时, reactive 会创建一个 Proxy 包裹原始对象. Proxy 的 get 拦截器 (handlers.ts) 做了两件事:

```ts
get(target, key, receiver) {
  const result = target[key]
  // 第一步: 依赖收集 -- 将当前 reaction 与 target[key] 绑定
  bindTargetKeyWithCurrentReaction({ target, key, receiver, type: 'get' })
  // 第二步: 深度代理 -- 如果 result 是对象, 递归创建 Proxy
  if (!isObservable(result) && isSupportObservable(result)) {
    return createObservable(target, key, result)
  }
  return result
}
```

bindTargetKeyWithCurrentReaction 的实现 (reaction.ts) :

```ts
export const bindTargetKeyWithCurrentReaction = (operation) => {
  const { key, type, target } = operation;
  const reactionLen = ReactionStack.length;
  if (reactionLen === 0) return; // 没有正在执行的 reaction, 跳过
  const current = ReactionStack[reactionLen - 1]; // 取栈顶
  if (current) {
    // 双向绑定:
    // 1. target[key] -> current (写入 RawReactionsMap)
    // 2. current -> target[key] 的 reactionsMap (写入 reaction._reactionsSet)
    addReactionsMapToReaction(
      current,
      addRawReactionsMap(target, key, current),
    );
  }
};
```

这就是"依赖收集"的本质: 在读取数据时, 把"谁在读"和"读了什么"建立双向关联.

### 4.4 Proxy 拦截: 触发更新

Proxy 的 set 拦截器:

```ts
set(target, key, value, receiver) {
  const hadKey = hasOwnProperty.call(target, key)
  const oldValue = target[key]
  target[key] = value
  if (!hadKey) {
    // 新增属性
    runReactionsFromTargetKey({ target, key, value, oldValue, type: 'add' })
  } else if (value !== oldValue) {
    // 修改属性 (值变了才触发)
    runReactionsFromTargetKey({ target, key, value, oldValue, type: 'set' })
  }
  return true
}
```

runReactionsFromTargetKey 会从 RawReactionsMap 中查出所有依赖了 target[key] 的 reactions, 然后:

- 如果在批处理中 (BatchCount > 0) , 加入 PendingReactions 队列, 等批处理结束统一执行
- 否则立即执行

### 4.5 autorun 与 Tracker

autorun 是 reactive 最核心的 API. 它的执行流程 (以下为简化版, 省略了重入保护与 try/finally) :

```ts
export const autorun = (tracker: Reaction) => {
  const reaction: Reaction = () => {
    // 1. 释放旧的依赖绑定
    releaseBindingReactions(reaction);
    // 2. 开启批处理
    batchStart();
    // 3. 将自身压入 ReactionStack (这样 get 拦截器就能收集到它)
    ReactionStack.push(reaction);
    // 4. 执行用户函数 (触发 get 拦截 -> 依赖收集)
    tracker();
    // 5. 弹出栈、结束批处理
    ReactionStack.pop();
    batchEnd();
  };
  // 立即执行一次 (首次依赖收集)
  reaction();
  // 返回 dispose 函数
  return () => disposeBindingReactions(reaction);
};
```

注意上面是简化版: 源码用 try/finally 保证 tracker() 抛异常时也能弹出 ReactionStack 并执行 batchEnd, 并用 _boundary 计数做重入保护.

Tracker 是 autorun 的变体, 专为 React 渲染设计. 它多了一个 scheduler 回调, 用于在依赖变化时触发 React 重渲染 (以下同样为简化版) :

```ts
export class Tracker {
  constructor(scheduler) {
    this.track._scheduler = (callback) => {
      scheduler(callback); // 调用 forceUpdate
    };
  }

  track = (tracker) => {
    releaseBindingReactions(this.track);
    batchStart();
    ReactionStack.push(this.track);
    this.results = tracker(); // 执行渲染函数, 收集依赖
    ReactionStack.pop();
    batchEnd();
    return this.results;
  };
}
```

Tracker.track 的源码同样以 try/finally 包裹执行过程, 并带 _boundary 重入保护.

### 4.6 批处理机制 (batch)

批处理是性能的关键. 没有批处理, 连续修改 10 个字段会触发 10 次重渲染; 有了批处理, 只触发 1 次.

```ts
export const batch = createBoundaryAnnotation(batchStart, batchEnd);

// batchStart: BatchCount.value++
// batchEnd:   BatchCount.value--; if (=== 0) executePendingReactions()
```

在 batchEnd 时, 所有积攒在 PendingReactions 中的 reactions 会被去重后统一执行. Formily 的 Field.onInput、Form.setValues 等操作都包裹在 batch 中.

### 4.7 computed 与 reaction

computed 创建一个惰性求值的缓存反应:

```ts
const fullName = observable.computed(() => `${state.first} ${state.last}`);
```

它内部也是一个 reaction, 但标记了 _isComputed = true. 当依赖变化时, 不立即重新计算, 而是标记 _dirty = true, 下次读取时才重新求值.

reaction 是 autorun 的增强版, 分离了"追踪函数"和"响应函数":

```ts
reaction(
  () => state.count, // tracker: 只追踪这个表达式的依赖
  (newVal, oldVal) => {
    // subscriber: 值变了才执行
    console.log(newVal, oldVal);
  },
);
```

### 4.8 与 MobX 的区别

| 维度     | Formily Reactive                   | MobX             |
| -------- | ---------------------------------- | ---------------- |
| 体积     | 约 5KB gzip                        | 约 16KB gzip     |
| 依赖收集 | 每次执行前释放旧依赖、重新收集     | 类似             |
| 批处理   | 内置 batch, 支持嵌套               | 内置 transaction |
| 数据树   | 内置 DataNode 树结构, 支持路径寻址 | 无               |
| 设计目标 | 为表单场景优化                     | 通用状态管理     |

---

## 五、原理解析: @formily/core 表单领域模型

### 5.1 Form 模型

Form 是整个表单的"大脑". 通过 createForm(props) 创建:

```ts
const form = createForm({
  values: { name: 'hello' },        // 表单值
  initialValues: { name: '' },      // 初始值 (用于 reset)
  effects() { ... },                // 副作用函数
  pattern: 'editable',              // 交互模式
  display: 'visible',               // 展示状态
})
```

Form 构造函数的执行顺序:

```ts
constructor(props) {
  this.initialize(props)   // 初始化属性、创建 Heart 和 Graph
  this.makeObservable()    // 用 define() 将属性标记为 observable
  this.makeReactive()      // 用 observe() 监听 values 变化, 触发事件
  this.makeValues()        // 初始化 values 和 initialValues
  this.onInit()            // 发布 ON_FORM_INIT 生命周期事件
}
```

Form 的关键属性:

- values: 表单当前值 (深度 observable 对象)
- initialValues: 初始值
- fields: 所有字段的字典 \{ [address: string]: Field \}
- heart: 事件中心 (Heart 实例)
- graph: 字段图 (Graph 实例)
- pattern: 交互模式 (editable / disabled / readOnly / readPretty)
- display: 展示状态 (visible / hidden / none)

Form 的关键方法:

- createField / createArrayField / createObjectField / createVoidField: 创建字段
- setValues / setValuesIn: 设置表单值
- setFieldState / setFormState: 设置状态
- submit / validate / reset: 提交、校验、重置
- query: 字段查询 (支持路径模式匹配)
- addEffects / removeEffects: 动态增删副作用

### 5.2 Field 模型

Field 继承自 BaseField, 代表一个有值的数据字段. 它的创建流程:

```ts
constructor(address, props, form, designable) {
  this.form = form
  this.props = props
  initializeStart()
  this.locate(address)      // 在 form.fields 中注册自己
  this.initialize()         // 初始化所有属性
  this.makeObservable()     // 标记 observable 属性
  this.makeReactive()       // 建立响应式联动
  this.onInit()             // 发布 ON_FIELD_INIT 事件
  initializeEnd()
}
```

Field 的核心属性:

- address: 字段的绝对路径 (如 "user.name")
- path: 字段的数据路径 (去除 VoidField 后的路径)
- value: 字段值 (computed, 实际从 form.values 中按 path 读取)
- initialValue: 初始值
- componentType / componentProps: 渲染组件及其 props
- decoratorType / decoratorProps: 装饰器组件及其 props
- feedbacks: 校验反馈信息
- validator: 校验规则
- display / pattern: 展示状态和交互模式

### 5.3 值的存取机制

Field 的 value 是一个 computed 属性:

```ts
get value() {
  return this.form.values[this.path]  // 从 form.values 中按路径读取
}

set value(value) {
  this.form.setValuesIn(this.path, value)  // 写入 form.values
}
```

这意味着所有字段的值实际上存储在 form.values 这一个 observable 对象中. 字段只是通过路径来读写自己的那一部分.

### 5.4 字段生命周期

```
createField() -> onInit -> [React 挂载] -> onMount -> [用户交互] -> onInput -> onUnmount
```

在 React 层 (Field.tsx) :

```tsx
export const Field = (props) => {
  const form = useForm();
  const parent = useField();
  const field = form.createField({ basePath: parent?.address, ...props });
  useEffect(() => {
    field?.onMount();
    return () => field?.onUnmount();
  }, [field]);
  return (
    <FieldContext.Provider value={field}>
      <ReactiveField field={field} />
    </FieldContext.Provider>
  );
};
```

注意: form.createField 是幂等的. 如果同一路径的字段已经存在, 会复用已有实例并更新 props, 而不是创建新实例.

### 5.5 makeReactive: 响应式联动

Field 的 makeReactive 方法建立了多条响应式链路:

```ts
protected makeReactive() {
  // 1. 值变化 -> 发布事件 + 触发校验
  createReaction(() => this.value, (value) => {
    this.notify(LifeCycleTypes.ON_FIELD_VALUE_CHANGE)
    if (this.selfModified) validateSelf(this)
  })

  // 2. 初始值变化 -> 发布事件
  createReaction(() => this.initialValue, () => {
    this.notify(LifeCycleTypes.ON_FIELD_INITIAL_VALUE_CHANGE)
  })

  // 3. display 变化 -> 处理值的缓存与恢复
  createReaction(() => this.display, (display) => {
    if (display === 'none') {
      this.caches.value = toJS(this.value)  // 缓存值
      this.form.deleteValuesIn(this.path)   // 从 values 中删除
    } else {
      if (this.caches.value !== undefined) {
        this.setValue(this.caches.value)    // 恢复值
      }
    }
  })

  // 4. 执行用户定义的 reactions
  createReactions(this)
}
```

这里有一个精妙的设计: 当字段 display 变为 none 时, 值会从 form.values 中删除 (提交时不会包含隐藏字段的值) , 但会缓存在 caches 中, 等字段重新显示时恢复.

### 5.6 Heart 事件中心

Heart 继承自 Subscribable, 是 Formily 的发布-订阅事件系统:

```ts
export class Heart extends Subscribable {
  lifecycles: LifeCycle[] = []; // 内部生命周期
  outerLifecycles: Map<any, LifeCycle[]> = new Map(); // 外部生命周期

  publish = (type, payload, context) => {
    // 遍历所有 lifecycle, 调用 notify
    this.lifecycles.forEach((lc) => lc.notify(type, payload, context));
    this.outerLifecycles.forEach((lcs) =>
      lcs.forEach((lc) => lc.notify(type, payload, context)),
    );
    // 同时通知 Subscribable 的订阅者
    this.notify({ type, payload });
  };
}
```

每个字段通过 this.notify(type) 向 form.heart 发布事件. effects 中注册的 onFieldValueChange 等钩子, 本质上就是注册到 Heart 上的 LifeCycle 实例.

### 5.7 Effects 系统

Effects 是 Formily 管理副作用的核心机制. 它的工作原理:

```ts
// createForm 时传入 effects
const form = createForm({
  effects() {
    onFieldValueChange("name", (field, form) => {
      // 当 name 字段值变化时执行
    });
  },
});
```

内部实现 (packages/core/src/shared/effective.ts) :

1. runEffects 被调用时, 设置 GlobalState.effectStart = true
2. effects 函数体同步执行, 其中的 onFieldValueChange 等调用 createEffectHook
3. createEffectHook 创建一个 LifeCycle 实例, push 到 GlobalState.lifecycles
4. runEffects 返回所有收集到的 LifeCycle 数组
5. 这些 LifeCycle 被传入 Heart 构造函数

createEffectHook 的核心逻辑:

```ts
export const createEffectHook = (type, callback) => {
  return (...args) => {
    // 必须在 effects 函数体中同步调用
    GlobalState.lifecycles.push(
      new LifeCycle(type, (payload, ctx) => {
        callback(payload, ctx)(...args);
      }),
    );
  };
};
```

对于字段级 effects (如 onFieldValueChange) , 还有一个路径匹配步骤:

```ts
function createFieldEffect(type) {
  return createEffectHook(type, (field, form) => (pattern, callback) => {
    // 用 FormPath 匹配字段路径
    if (FormPath.parse(pattern).matchAliasGroup(field.address, field.path)) {
      batch(() => callback(field, form));
    }
  });
}
```

### 5.8 字段类型

Formily 有四种字段类型:

| 类型        | 类          | 有值 | 用途                            |
| ----------- | ----------- | ---- | ------------------------------- |
| Field       | Field       | 是   | 普通数据字段 (输入框、选择器等) |
| ArrayField  | ArrayField  | 是   | 数组字段 (列表、表格)           |
| ObjectField | ObjectField | 是   | 对象字段 (嵌套表单)             |
| VoidField   | VoidField   | 否   | 纯布局字段 (卡片、分组)         |

VoidField 不存储值, 它的 path 和 address 不同: path 会跳过 VoidField 的节点. 例如:

```
address: "layout.username"   (包含 VoidField 的路径)
path:    "username"           (数据路径, 跳过了 layout)
```

---

## 六、原理解析: @formily/reactive-react 渲染桥接

### 6.1 observer 的工作原理

observer 是连接 reactive 和 React 的桥梁. 它的核心逻辑非常简洁:

```ts
export function observer(component, options) {
  const wrappedComponent = (props) => {
    return useObserver(() => component(props), options);
  };
  return memo(wrappedComponent);
}
```

useObserver 的实现:

```ts
export const useObserver = (view, options) => {
  const forceUpdate = useForceUpdate();
  const tracker = useCompatFactory(
    () =>
      new Tracker(() => {
        forceUpdate(); // 依赖变化时, 强制 React 重渲染
      }),
  );
  return tracker.track(view); // 执行渲染函数, 收集依赖
};
```

整个流程:

1. 组件渲染时, tracker.track(view) 执行渲染函数
2. 渲染函数中读取了 field.value 等 observable 属性
3. Proxy get 拦截器将当前 tracker 与这些属性绑定
4. 当属性变化时, tracker 的 scheduler 被调用
5. scheduler 调用 forceUpdate, 触发 React 重渲染
6. 重渲染时重新执行 track, 释放旧依赖、收集新依赖

### 6.2 useForceUpdate 的精巧设计

```ts
export function useForceUpdate() {
  const [, setState] = useState([]);
  // ...
  const scheduler = useCallback(() => {
    if (RENDER_COUNT.value === 0) {
      update(); // 没有正在渲染的组件, 直接更新
    } else {
      RENDER_QUEUE.add(update); // 有组件正在渲染, 延迟更新
    }
  }, []);
  // ...
}
```

这里有一个全局的 RENDER_COUNT 计数器和 RENDER_QUEUE 队列. 它解决的问题是: 如果在 React 渲染过程中同步触发另一个组件的 setState, 会导致 React 警告或错误. 所以 formily 会检测当前是否有组件正在渲染, 如果有, 就把更新延迟到渲染结束后统一执行.

### 6.3 useCompatFactory 与垃圾回收

React 18 的 StrictMode 和 ConcurrentMode 会导致组件的 mount/unmount 行为不可预测. useCompatFactory 通过 GarbageCollector 确保 Tracker 实例在组件真正卸载时被正确销毁:

```ts
export const useCompatFactory = (factory) => {
  const instRef = useRef(null);
  const gcRef = useRef();
  if (!instRef.current) {
    instRef.current = factory(); // 创建 Tracker
  }
  if (!gcRef.current) {
    gcRef.current = new GarbageCollector(() => {
      instRef.current?.dispose(); // GC 时销毁 Tracker
    });
    gcRef.current.open(objectRetainedByReact);
  }
  // ...
};
```

---

## 七、原理解析: @formily/react 组件层

### 7.1 组件渲染流程

以 Field 组件为例, 完整的渲染链路:

```
<Field name="username" component={[Input]} decorator={[FormItem]} />
  |
  +-- useForm() -> 从 FormContext 获取 form 实例
  +-- useField() -> 从 FieldContext 获取父字段
  +-- form.createField() -> 创建/复用 Field 模型
  |
  +-- <FieldContext.Provider value={field}>  -> 注入字段上下文
  |
  +-- <ReactiveField field={field}>  -> observer 包裹的渲染组件
       |
       +-- 读取 field.display -> 决定是否渲染
       +-- 读取 field.decoratorType -> 渲染装饰器 (FormItem)
       +-- 读取 field.componentType -> 渲染组件 (Input)
       +-- 读取 field.value -> 传入 value prop
       +-- 构造 onChange -> 调用 field.onInput()
```

### 7.2 ReactiveField 的渲染逻辑

ReactiveField 是 Formily React 层最核心的组件. 它被 observer 包裹, 因此会自动追踪渲染过程中读取的所有 observable 属性:

```tsx
const ReactiveInternal = (props) => {
  const field = props.field;
  if (field.display !== "visible") return null; // 追踪 display

  const renderComponent = () => {
    const value = field.value; // 追踪 value
    const onChange = (...args) => {
      field.onInput(...args); // 用户输入 -> 更新值
    };
    return React.createElement(
      field.componentType, // 追踪 componentType
      { ...toJS(field.componentProps), value, onChange }, // 追踪 componentProps
    );
  };

  const renderDecorator = (children) => {
    return React.createElement(
      field.decoratorType, // 追踪 decoratorType
      toJS(field.decoratorProps), // 追踪 decoratorProps
      children,
    );
  };

  return renderDecorator(renderComponent());
};

export const ReactiveField = observer(ReactiveInternal);
```

关键点: 由于 observer 的存在, 只有当这个字段自己的 value、display、componentProps 等属性变化时, 这个组件才会重渲染. 其他字段的变化不会影响它. 这就是"字段分布式渲染"的实现原理.

### 7.3 connect 与 mapProps

connect 用于将第三方 UI 组件适配为 Formily 字段组件:

```ts
export function connect(target, ...mappers) {
  const Target = mappers.reduce((target, mapper) => mapper(target), target);
  return React.forwardRef((props, ref) => {
    return React.createElement(Target, { ...props, ref });
  });
}
```

mapProps 是最常用的 mapper, 它将 Field 模型的状态映射为组件 props:

```ts
export function mapProps(...args) {
  return (target) => {
    return observer((props) => {
      const field = useField();
      const results = args.reduce(
        (props, mapper) => {
          if (isFn(mapper)) {
            return Object.assign(props, mapper(props, field));
          } else {
            // 对象映射: { value: 'checked' } 表示把 field.value 映射为 props.checked
            each(mapper, (to, extract) => {
              FormPath.setIn(props, to, FormPath.getIn(field, extract));
            });
            return props;
          }
        },
        { ...props },
      );
      return React.createElement(target, results);
    });
  };
}
```

典型用法:

```ts
const Checkbox = connect(
  AntCheckbox,
  mapProps({ value: "checked" }), // field.value -> props.checked
  mapReadPretty(PreviewText), // readPretty 模式下渲染预览组件
);
```

### 7.4 Context 体系

Formily React 层使用了 7 个 Context:

```ts
FormContext          -> Form 实例
FieldContext         -> 当前 Field 实例
SchemaMarkupContext  -> Markup 模式下的父 Schema
SchemaContext        -> 当前 Schema
SchemaExpressionScopeContext -> {{...}} 表达式求值的作用域
SchemaComponentsContext -> 注册的组件表
SchemaOptionsContext -> createSchemaField 的选项
```

FieldContext 是嵌套的: 每个 Field 组件都会创建一个新的 FieldContext.Provider, 子字段通过 useField() 获取的是最近的父字段. 这使得字段树的结构自然形成.

### 7.5 SchemaField 与 RecursionField

createSchemaField 是 JSON Schema 模式的入口:

```ts
const SchemaField = createSchemaField({
  components: { Input, Select, FormItem },
  scope: { myUtil },
});
```

它返回一个 SchemaField 组件, 内部渲染流程:

```
<SchemaField schema={schema} />
  |
  +-- 将 schema 包装为 Schema 实例
  +-- 提供 SchemaOptionsContext、SchemaComponentsContext、ExpressionScope
  |
  +-- <RecursionField schema={schema} />
       |
       +-- schema.toFieldProps() -> 转换为 Field props
       +-- 根据 schema.type 选择渲染组件:
       |   +-- 'object' -> <ObjectField>
       |   +-- 'array'  -> <ArrayField>
       |   +-- 'void'   -> <VoidField>
       |   +-- 其他     -> <Field>
       |
       +-- 递归渲染 properties:
           Schema.getOrderProperties(schema).map(({ schema, key }) => (
             <RecursionField schema={schema} name={key} />
           ))
```

RecursionField 是递归渲染的核心. 它根据 schema.type 决定创建哪种字段, 然后递归处理子 properties.

---

## 八、原理解析: @formily/json-schema 协议层

### 8.1 Schema 协议扩展

Formily 在标准 JSON Schema 基础上扩展了 x-* 属性:

| 属性                              | 含义                                                   |
| --------------------------------- | ------------------------------------------------------ |
| x-component                       | 渲染组件名 (从 components 表中查找)                    |
| x-component-props                 | 组件 props                                             |
| x-decorator                       | 装饰器组件名                                           |
| x-decorator-props                 | 装饰器 props                                           |
| x-reactions                       | 联动规则                                               |
| x-display                         | 展示状态 (visible / hidden / none)                     |
| x-pattern                         | 交互模式 (editable / disabled / readOnly / readPretty) |
| x-validator                       | 校验规则                                               |
| x-visible / x-hidden / x-disabled | 快捷状态设置                                           |
| x-index                           | 排序权重                                               |
| x-data                            | 自定义扩展数据                                         |
| x-content                         | 内容 (如按钮文字)                                      |

### 8.2 Schema 到 Field Props 的转换

Schema.toFieldProps() 方法将 JSON Schema 转换为 createField 的参数:

```ts
// transformer.ts
export const transformFieldProps = (schema, options) => {
  return {
    name: schema.name,
    reactions: [getBaseReactions(schema, options)].concat(
      getUserReactions(schema, options),
    ),
  };
};
```

其中 getBaseReactions 负责将 x-component、x-decorator、x-validator 等属性同步到字段状态; getUserReactions 负责处理 x-reactions 联动规则.

### 8.3 x-reactions 的执行机制

x-reactions 支持两种形式:

形式一: 对象声明式

```json
{
  "x-reactions": {
    "dependencies": ["fieldA", "fieldB"],
    "when": "{{$deps[0] === 'yes'}}",
    "fulfill": {
      "state": { "visible": true },
      "run": "console.log('fulfilled')"
    },
    "otherwise": {
      "state": { "visible": false }
    }
  }
}
```

形式二: 函数式

```json
{
  "x-reactions": "{{(field) => { field.visible = field.query('a').value() === 'yes' }}}"
}
```

执行流程 (transformer.ts 中的 getUserReactions) :

```ts
const getUserReactions = (schema, options) => {
  const reactions = toArr(schema["x-reactions"]);
  return reactions.map((unCompiled) => {
    return (field) => {
      const baseScope = getBaseScope(field, options);
      const reaction = shallowCompile(unCompiled, baseScope);

      if (isFn(reaction)) {
        return reaction(field, baseScope); // 函数式: 直接执行
      }

      // 对象声明式:
      const { when, fulfill, otherwise, target, dependencies } = reaction;
      const run = () => {
        const $deps = getDependencies(field, dependencies);
        const scope = { ...baseScope, $deps };
        const condition = when ? shallowCompile(when, scope) : true;
        const request = condition ? fulfill : otherwise;
        setSchemaFieldState({ field, target, request, scope });
      };

      if (target) {
        // 被动联动: 监听目标字段的事件
        reaction.effects.forEach((type) =>
          FieldEffects[type](field.address, run),
        );
      } else {
        // 主动联动: 在 autorun 中执行 (自动追踪依赖)
        run();
      }
    };
  });
};
```

### 8.4 表达式编译

x-reactions 中的 `{{...}}` 语法会被 compiler.ts 编译为 JavaScript 函数:

```ts
// "{{ $deps[0] === 'yes' }}" -> new Function('$deps', "return $deps[0] === 'yes'")
```

编译时可用的作用域变量:

| 变量                  | 含义                      |
| --------------------- | ------------------------- |
| $self                 | 当前字段                  |
| $form                 | 表单实例                  |
| $values               | 表单值                    |
| $deps / $dependencies | 依赖字段的值数组          |
| $target               | 目标字段状态 (被动联动时) |
| $record               | 当前记录 (数组字段中)     |
| $records              | 所有记录                  |
| $index                | 当前索引                  |
| $observable           | 创建 observable 对象      |
| $effect               | autorun.effect            |
| $memo                 | autorun.memo              |
| $props                | 设置组件 props            |

---

## 九、原理解析: @formily/path 路径系统

### 9.1 为什么需要路径系统

表单字段天然是一棵树. Formily 用路径来标识每个字段的位置:

```
form
+-- user          (ObjectField, address: "user", path: "user")
|   +-- name      (Field, address: "user.name", path: "user.name")
|   +-- age       (Field, address: "user.age", path: "user.age")
+-- layout        (VoidField, address: "layout", path: "")
|   +-- email     (Field, address: "layout.email", path: "email")
+-- tags          (ArrayField, address: "tags", path: "tags")
    +-- 0         (ObjectField, address: "tags.0", path: "tags.0")
        +-- label (Field, address: "tags.0.label", path: "tags.0.label")
```

注意 VoidField "layout" 的 path 是空的, 所以 email 的 path 是 "email" 而不是 "layout.email". 这意味着 form.values 的结构是:

```json
{
  "user": { "name": "...", "age": 18 },
  "email": "...",
  "tags": [{ "label": "..." }]
}
```

### 9.2 路径匹配

FormPath 支持丰富的模式匹配语法, 用于 effects 和 query 中:

```ts
form.query("user.*"); // 匹配 user 下所有直接子字段
form.query("user.name"); // 精确匹配
form.query("*(user,tags)"); // 匹配 user 或 tags
form.query("user.*(name,age)"); // 匹配 user.name 或 user.age
form.query("tags.*.label"); // 匹配数组中所有元素的 label
```

---

## 十、原理解析: @formily/validator 校验引擎

### 10.1 校验规则

Formily 支持多种校验规则声明方式:

```ts
// 内置规则
{ required: true }
{ format: 'email' }
{ pattern: /^\d+$/ }
{ len: 11 }
{ min: 1, max: 100 }

// 自定义校验函数
{ validator: (value) => value === 'admin' ? '不能是 admin' : '' }

// 异步校验
{ validator: async (value) => {
    const exists = await checkUsername(value)
    return exists ? '用户名已存在' : ''
  }
}
```

### 10.2 校验触发时机

校验在以下时机自动触发:

- onInput: 用户输入后 (selfModified 为 true 时)
- onFocus: 聚焦时 (可配置)
- onBlur: 失焦时 (可配置)
- submit: 提交时 (全量校验)

在 Field.makeReactive 中:

```ts
createReaction(
  () => this.value,
  (value) => {
    if (this.selfModified && !this.caches.inputting) {
      validateSelf(this); // 值变化且是用户修改的 -> 触发校验
    }
  },
);
```

### 10.3 校验结果

校验结果存储在 field.feedbacks 数组中:

```ts
interface IFieldFeedback {
  type: "error" | "warning" | "success";
  messages: string[];
  triggerType: "onInput" | "onFocus" | "onBlur";
}
```

field.errors 是一个 computed 属性, 过滤出 type === 'error' 的 feedbacks. form.errors 则聚合所有字段的 errors.

---

## 十一、完整数据流

以用户在输入框中输入一个字符为例, 完整的数据流:

```
1. 用户在 <Input> 中输入 "hello"
   |
2. Input 的 onChange 被触发
   |
3. ReactiveField 中构造的 onChange 调用 field.onInput(...args)
   |
4. field.onInput 内部 (batch 包裹) :
   +-- 解析事件参数, 提取 value
   +-- 设置 field.inputValue / field.inputValues
   +-- 设置 field.selfModified = true
   +-- 调用 field.setValue(value)
   |   +-- 写入 form.values[field.path] = value
   |       +-- Proxy set 拦截器触发 runReactionsFromTargetKey
   |           +-- 触发 Field 的 makeReactive 中的 reaction
   |           |   +-- 发布 ON_FIELD_VALUE_CHANGE 事件
   |           |   +-- 触发 validateSelf (校验)
   |           +-- 触发 Form 的 makeReactive 中的 observe
   |           |   +-- 发布 ON_FORM_VALUES_CHANGE 事件
   |           +-- 触发其他依赖了 form.values[path] 的 reactions
   |                (如 x-reactions 中 dependencies 包含此字段的联动)
   |
5. batch 结束, 执行 PendingReactions:
   +-- 当前字段的 ReactiveField 重渲染 (value 变了)
   +-- 依赖此字段的其他字段的 ReactiveField 重渲染
   +-- FormConsumer 重渲染 (如果监听了 values)
   |
6. 校验完成, field.feedbacks 更新
   +-- 装饰器 (FormItem) 重渲染, 显示错误信息
```

整个过程中, 只有真正依赖了变化数据的组件才会重渲染. 这就是 Formily 高性能的秘密.

---

## 十二、进阶用法

### 12.1 自定义组件

```tsx
import { connect, mapProps } from "@formily/react";

const MyInput = connect(
  (props) => <input {...props} />,
  mapProps({
    value: "value",
    onInput: "onChange",
  }),
);

// 在 schema 中使用
const SchemaField = createSchemaField({
  components: { MyInput, FormItem },
});
```

### 12.2 自定义装饰器

装饰器负责渲染字段的"外壳" (label、错误信息、必填标记等) :

```tsx
const MyFormItem = observer((props) => {
  const field = useField();
  return (
    <div className="form-item">
      <label>{field.title}</label>
      {props.children}
      {field.errors.map((err) => (
        <span className="error">{err}</span>
      ))}
    </div>
  );
});
```

### 12.3 异步数据源

```tsx
const form = createForm({
  effects() {
    onFieldMount("city", async (field) => {
      field.loading = true;
      const data = await fetchCities();
      field.dataSource = data;
      field.loading = false;
    });
  },
});
```

### 12.4 表单提交

```tsx
const handleSubmit = async () => {
  try {
    const values = await form.submit(); // 先校验, 通过后返回 values
    await api.save(values);
  } catch (errors) {
    console.log("校验失败", errors);
  }
};
```

form.submit 的内部流程:

```
submit()
  +-- 发布 ON_FORM_SUBMIT_START
  +-- setSubmitting(true)
  +-- validate()  -> 全量校验
  |   +-- 遍历所有字段
  |   +-- 对每个字段执行 validator
  |   +-- 收集所有 errors
  +-- 如果校验通过:
  |   +-- 调用 props.onSubmit(values)
  |   +-- 发布 ON_FORM_SUBMIT_SUCCESS
  +-- 如果校验失败:
  |   +-- 发布 ON_FORM_SUBMIT_FAILED
  +-- setSubmitting(false)
      +-- 发布 ON_FORM_SUBMIT_END
```

### 12.5 FormConsumer

FormConsumer 用于在表单外部消费表单状态:

```tsx
<FormProvider form={form}>
  <SchemaField schema={schema} />
  <FormConsumer>
    {(form) => (
      <div>
        当前值: {JSON.stringify(form.values)}
        是否有效: {form.valid ? "是" : "否"}
      </div>
    )}
  </FormConsumer>
</FormProvider>
```

FormConsumer 内部也是 observer, 它会自动追踪渲染函数中读取的 form 属性.

---

## 十三、设计哲学总结

### 13.1 协议驱动

Formily 的核心设计哲学是"协议驱动". 表单的结构、行为、联动、校验全部可以通过 JSON Schema 协议描述. 这使得:

- 表单可以由后端动态下发
- 表单可以由可视化设计器生成 (Designable)
- 表单逻辑可以跨项目复用

### 13.2 领域模型与渲染分离

@formily/core 是纯 JavaScript 的领域模型, 不依赖任何 UI 框架. 这意味着:

- 同一套表单逻辑可以在 React、Vue、甚至非 UI 环境中使用
- 表单的状态管理、校验、联动逻辑与渲染完全解耦
- 可以独立测试表单逻辑

### 13.3 响应式精确更新

传统的 React 表单方案 (如 React Hook Form 的 watch、Ant Design Form 的 shouldUpdate) 需要开发者手动控制渲染范围. Formily 通过 reactive 的依赖追踪自动实现了字段级精确更新:

- 每个字段的 ReactiveField 是独立的 observer
- 只有当该字段依赖的 observable 属性变化时才重渲染
- 无需手动优化, 无需 shouldComponentUpdate

### 13.4 路径即身份

Formily 用路径 (Path) 作为字段的唯一标识. 这带来了:

- 自然的树形结构表达
- 强大的模式匹配查询能力
- 与 JSON 数据结构的天然对应
- 数组字段的动态增删只需操作路径

---

## 十四、源码阅读指南

如果你想深入阅读 Formily 源码, 建议按以下顺序:

1. packages/reactive/src/environment.ts -- 理解全局数据结构
2. packages/reactive/src/handlers.ts -- 理解 Proxy 拦截
3. packages/reactive/src/reaction.ts -- 理解依赖收集与触发
4. packages/reactive/src/autorun.ts -- 理解 autorun/reaction
5. packages/reactive/src/tracker.ts -- 理解 Tracker (React 桥接的关键)
6. packages/reactive-react/src/hooks/useObserver.ts -- 理解 observer 如何工作
7. packages/core/src/models/Form.ts -- 理解表单模型
8. packages/core/src/models/Field.ts -- 理解字段模型
9. packages/core/src/effects/ -- 理解副作用系统
10. packages/core/src/shared/effective.ts -- 理解 effects 的收集与注册 (runEffects / createEffectHook)
11. packages/react/src/components/ReactiveField.tsx -- 理解渲染逻辑
12. packages/react/src/components/RecursionField.tsx -- 理解 Schema 递归渲染
13. packages/json-schema/src/transformer.ts -- 理解 x-reactions 的执行

每个文件都不大 (最大的 Form.ts 约 618 行, Field.ts 约 522 行) , 代码质量很高, 注释适中, 非常适合学习.
