---
title: "CSS 技术笔记"
---

本文档收录 55 个 CSS 核心知识点, 覆盖选择器、布局、工程化、渲染原理、性能优化、响应式、动画、跨端与现代 CSS 新特性等方向, 内容兼顾原理深度与工程实践, 适合深入学习参考.

## CSS 基础与选择器

### 1. CSS 选择器的优先级?

A:

优先级由层叠 (cascade) 规则决定, 核心口诀是: 先比来源与重要性, 再比选择器权重 (specificity), 最后比书写顺序.

来源与重要性层级 (从高到低):

1. 浏览器过渡声明 (transition 过程中的样式)
2. 用户代理的 `!important` 声明
3. 用户样式表的 `!important` 声明
4. 作者样式的 `!important` 声明
5. CSS 动画 (@keyframes) 运行期间的声明
6. 作者普通声明 (日常所写的样式绝大多数属于这一层)
7. 用户普通声明
8. 用户代理 (浏览器默认样式表) 普通声明

注意 `!important` 之间反转了来源优先级: 用户代理的 `!important` 高于作者的 `!important`, 这是为了可访问性兜底.

同一来源、同一重要性下, 比较选择器权重, 权重是一个四元组 (a, b, c, d), 按位比较, 不进制:

- a: 行内样式 `style="..."`, 命中记 (1,0,0,0)
- b: ID 选择器, 如 `#app`
- c: 类选择器 `.btn`、属性选择器 `[type="text"]`、伪类 `:hover`、`:nth-child()`
- d: 元素选择器 `div`、伪元素 `::before`

补充规则:

- 通配符 `*`、组合器 (空格、`>`、`+`、`~`) 不增加任何权重
- `:not()`、`:is()`、`:has()` 本身不计权重, 计入的是其参数; `:is()` 取参数列表中权重最高的那个; `:where()` 永远为 (0,0,0,0), 常用于设计可覆写的基础样式
- 权重相同则后书写的声明生效 (就近覆盖)
- 直接设置在元素上的样式永远高于继承而来的样式; 继承的样式可以被任意一条命中该元素的声明覆盖

`@layer` 层叠层是 CSS Cascade 5 引入的机制: 层内样式整体低于未分层样式, 层与层之间按声明顺序, 后声明的层优先级高; 但 `!important` 在层间反转 (先声明的层的 `!important` 更高).

```css
@layer base, components, utilities;

@layer utilities {
  .text-red {
    color: red;
  } /* 层内权重 (0,0,1,0), 但整层低于未分层样式 */
}
.title {
  color: blue;
} /* 未分层, 即使权重相同也赢 */
```

工程建议: 避免使用 `!important` 和行内样式, 通过合理的类名组织 (BEM、CSS Modules) 控制权重冲突; 组件库样式可用 `:where()` 或 `@layer` 降低优先级, 方便业务方覆盖.

### 2. 伪类和伪元素有什么区别?

A:

伪类 (pseudo-class) 用于选中真实存在的元素在特定状态或特定位置下的情形, 语法是单冒号; 伪元素 (pseudo-element) 用于创建或选中 DOM 树中并不真实存在的"部分", 语法是双冒号.

常用伪类:

- 状态类: `:hover`、`:active`、`:focus`、`:focus-visible`、`:focus-within`、`:visited`、`:disabled`、`:checked`
- 结构类: `:first-child`、`:last-child`、`:nth-child(2n+1)`、`:nth-of-type()`、`:only-child`、`:empty`、`:not()`
- 关系与逻辑类: `:is()`、`:where()`、`:has()`

常用伪元素:

- `::before` / `::after`: 在元素内容前后插入生成盒子, 必须配合 `content` 属性才渲染
- `::first-line` / `::first-letter`: 排版首行、首字母
- `::placeholder`: 输入框占位文本
- `::selection`: 用户选中的文本
- `::marker`: 列表项标记
- `::backdrop`: 全屏元素 (如 dialog) 背后的遮罩层

关键区别点:

- 伪类选中的是已有元素, 伪元素选中的是"虚拟"的子结构
- CSS3 规范用双冒号区分伪元素, 但 `::before`、`::after` 等历史原因单冒号写法依然被浏览器兼容, 新代码应统一双冒号
- 伪元素不在 DOM 树中, JS 无法直接获取或绑定事件, 只能通过 `getComputedStyle(el, '::before')` 读取其计算样式
- 一个选择器只能有一个伪元素, 且必须出现在选择器末尾; 伪类可以叠加多个, 如 `a:hover:focus`

典型应用: 用 `::before`/`::after` 画图标、分隔线、清除浮动、做叠加层, 可以避免额外 DOM 节点, 保持结构语义干净.

### 3. CSS 属性继承是什么? 哪些属性可以继承?

A:

继承指子元素在未显式声明某属性时, 自动取父元素该属性的计算值. 继承只发生在特定属性上, 且继承来的值优先级最低.

可继承的常见属性 (规律: 与文字排版相关的基本都可继承):

- 字体: `font-family`、`font-size`、`font-weight`、`font-style`、`font-variant`
- 文本: `color`、`line-height`、`text-align`、`text-indent`、`text-transform`、`letter-spacing`、`word-spacing`、`white-space`、`direction`
- 其他: `visibility`、`cursor`、`list-style`、`border-collapse`、`quotes`

不可继承的常见属性: 盒模型相关 (`width`、`height`、`margin`、`padding`、`border`)、定位相关 (`position`、`top` 等、`z-index`)、`background`、`display`、`float`、`overflow`、`transform` 等.

每个属性都接受五个全局关键字:

- `inherit`: 强制继承父元素计算值
- `initial`: 重置为该属性的规范初始值 (注意 `display: initial` 是 `inline` 而不是 `block`)
- `unset`: 可继承属性表现为 `inherit`, 不可继承属性表现为 `initial`
- `revert`: 回滚到上一层级联来源 (作者样式回滚到用户/浏览器默认样式)
- `revert-layer`: 回滚到上一个 `@layer` 的值

经典延伸: 为什么 `a` 标签的 `color` 不继承父元素? 因为浏览器的 UA 默认样式表直接给 `a` 设置了颜色, 直接命中的声明优先级高于继承值; 想继承需显式写 `a { color: inherit; }`.

### 4. CSS 中的 :root 和 html 选择器有什么区别?

A:

`:root` 和 `html` 在大多数情况下指向同一个元素, 但在语义、特异性和使用场景上有区别.

特异性差异:

- `:root` 是伪类, 特异性为 (0, 0, 1, 0)
- `html` 是元素选择器, 特异性为 (0, 0, 0, 1)
- `:root` 的优先级高于 `html`

```css
html {
  color: red;
}
:root {
  color: blue;
}
/* 最终颜色为 blue, 因为 :root 特异性更高 */
```

使用场景:

`:root` 的适用场景:

- 定义全局 CSS 变量 (约定俗成)
- 在独立的 SVG 文档中, `:root` 匹配根 `<svg>` 元素而非 `<html>` (内联在 HTML 中的 SVG 不适用, `:root` 仍匹配 html)
- XML 文档中, `:root` 匹配文档的根元素 (不一定是 html)

```css
:root {
  --color-primary: #1890ff;
  --spacing-unit: 8px;
  --font-family: -apple-system, sans-serif;
}
```

`html` 的适用场景:

- 设置基础字体大小 (用于 rem 计算)
- 设置全局背景色
- 需要被更低特异性选择器覆盖时

```css
html {
  font-size: 16px;
  background: #f5f5f5;
  scroll-behavior: smooth;
}
```

在独立 SVG 文档 (.svg 文件) 中的区别: 文档根元素是 `<svg>`, 因此 `:root` 能匹配到根 `<svg>` 元素, 而 `html` 选择器匹配不到任何元素 — 这是两者在非 HTML 文档中语义分野的典型例子.

### 5. CSS 中的 :is() 和 :where() 伪类有什么区别?

A:

`:is()` 和 `:where()` 都是 CSS 伪类函数, 用于简化选择器书写, 接受一个选择器列表作为参数. 两者的唯一区别在于特异性计算.

特异性区别:

```css
/* :is() 的特异性 = 参数中特异性最高的选择器 */
:is(#id, .class, div) {
  color: red;
}
/* 特异性 = #id 的特异性 = (0, 1, 0, 0) */

/* :where() 的特异性始终为 0 */
:where(#id, .class, div) {
  color: red;
}
/* 特异性 = (0, 0, 0, 0) */
```

实际影响:

```css
:is(.article, .post) p {
  color: blue;
}
/* 特异性 = (0, 0, 1, 1) */

:where(.article, .post) p {
  color: blue;
}
/* 特异性 = (0, 0, 0, 1) */
```

简化选择器:

```css
/* 传统写法 */
.article h1,
.article h2,
.article h3,
.post h1,
.post h2,
.post h3 {
  margin-bottom: 16px;
}

/* :is() 简化 */
:is(.article, .post) :is(h1, h2, h3) {
  margin-bottom: 16px;
}

/* :where() 简化 (低优先级) */
:where(.article, .post) :where(h1, h2, h3) {
  margin-bottom: 16px;
}
```

使用场景:

`:is()` 适用:

- 需要保持正常特异性
- 简化复杂选择器, 不改变优先级

```css
:is(input, select, textarea):focus {
  outline: 2px solid #1890ff;
}

:is(h1, h2, h3, h4, h5, h6) {
  font-weight: 600;
}
```

`:where()` 适用:

- 需要低优先级的默认样式, 方便覆盖
- 重置样式、基础样式
- 组件库的默认主题, 允许用户轻松覆盖

```css
:where(ul, ol) {
  list-style: none;
  padding: 0;
}

:where(.btn) {
  padding: 8px 16px;
  border-radius: 4px;
}
```

容错性:

- `:is()` 和 `:where()` 都支持容错解析
- 选择器列表中有一个无效, 不会导致整个规则失效
- 传统选择器列表中有一个无效, 整个规则被丢弃

```css
/* 传统: 如果 :unsupported 无效, 整个规则失效 */
.valid,
:unsupported {
  color: red;
}

/* :is(): 忽略无效的, 保留有效的 */
:is(.valid, :unsupported) {
  color: red;
}
```

---

## 盒模型与布局

### 6. 标准盒模型与怪异盒模型 (IE 盒模型) 有什么区别?

A:

两种盒模型的区别在于 `width`/`height` 的计量范围, 由 `box-sizing` 控制.

标准盒模型 (`box-sizing: content-box`, 默认值):

- `width` 只包含 content 区域
- 元素实际占据宽度 = `width + padding-left + padding-right + border-left + border-right`
- 后果: 设置 `width: 100%` 再加 padding 或 border 会撑破父容器

怪异盒模型 / IE 盒模型 (`box-sizing: border-box`):

- `width` 包含 content + padding + border
- 元素实际占据宽度 = `width` (+ margin 外边距始终不计入)
- padding、border 向内挤压 content, 不会再改变外尺寸

历史背景: 早期 IE 在怪异模式 (quirks mode, 无 DOCTYPE 或 DOCTYPE 错误) 下使用 IE 盒模型, W3C 标准盒模型与之冲突, CSS3 引入 `box-sizing` 让开发者自由选择.

现代开发共识: 全局重置为 `border-box`, 因为"所见即所得"的尺寸更直觉, 布局计算不容易溢出:

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
```

注意 `box-sizing` 不影响 margin, margin 塌陷、margin 合并规则在两种盒模型下完全一致.

### 7. 什么是 BFC? 如何触发 BFC? BFC 有什么作用?

A:

BFC (Block Formatting Context, 块级格式化上下文) 是页面中的一块独立渲染区域, 内部元素的布局规则与外界隔离: 内部的变化不会影响外部, 外部也不会影响内部. 可以把它理解为一块"自治"的布局沙盒.

常见触发方式 (满足其一即可):

- 根元素 `<html>`
- `float` 不为 `none`
- `position` 为 `absolute` 或 `fixed`
- `overflow` 不为 `visible` (即 `hidden`、`auto`、`scroll`)
- `display` 为 `inline-block`、`table-cell`、`table-caption`、`flex`、`inline-flex`、`grid`、`inline-grid`、`flow-root`
- `contain: layout` / `content` / `strict`
- 多列容器 (`column-count` 非 `auto`) 等

精确性补充: 严格来说 flex/grid 容器建立的是独立的 flex/grid 格式化上下文, 效果与 BFC 等价 (同样不与浮动重叠、隔断 margin 合并); 另外 flex/grid 容器的直接子项 (flex item / grid item) 会各自建立新的 BFC.

BFC 内部布局规则:

- 盒子在垂直方向一个接一个排列
- 同一个 BFC 内相邻盒子的垂直 margin 会合并
- BFC 区域不会与浮动元素重叠
- 计算 BFC 高度时, 其内部的浮动元素也参与计算

三大典型应用:

1. 清除浮动 / 解决高度塌陷: 父元素触发 BFC 后, 高度计算会包含浮动子元素

```css
.parent {
  overflow: hidden;
} /* 或 display: flow-root, 语义最纯粹 */
```

2. 阻止 margin 穿透/合并: 给父子之一包裹一个 BFC 边界, 隔断 margin 合并关系

3. 两栏自适应布局: 左栏浮动, 右栏触发 BFC 后不与浮动重叠, 自动占满剩余宽度

```css
.left {
  float: left;
  width: 200px;
}
.right {
  overflow: hidden;
} /* BFC, 自适应剩余宽度 */
```

`display: flow-root` 是现代最推荐的触发方式, 它只为创建 BFC 而生, 没有 `overflow: hidden` 裁剪内容、`float` 改变布局等副作用.

### 8. 如何实现元素的水平垂直居中?

A:

按适用场景分类:

定宽定高子元素:

- 绝对定位 + 负 margin: 子元素 `position: absolute; top: 50%; left: 50%; margin-top: -h/2; margin-left: -w/2`
- 绝对定位 + margin auto: 子元素 `position: absolute; inset: 0; margin: auto;` (四个方向都设为 0 且定宽高时, auto margin 均分剩余空间)

不定宽不定高子元素 (最常用):

- 绝对定位 + transform: `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);` — 注意 transform 百分比相对自身尺寸, 而 top/left 百分比相对包含块
- flex: 父元素 `display: flex; justify-content: center; align-items: center;`
- grid: 父元素 `display: grid; place-items: center;` 或子元素 `place-self: center`
- grid + margin auto: 父 `display: grid`, 子 `margin: auto`

行内/文本场景:

- 单行文本垂直居中: `line-height` 等于容器高度 + `text-align: center`
- 表格方案: 父 `display: table-cell; vertical-align: middle; text-align: center;`

选择建议: 现代项目优先 flex/grid, 语义清晰且对子元素数量、尺寸变化健壮; 需要兼容老浏览器或弹窗居中常用 absolute + transform; transform 方案会创建合成层, 对动画友好, 但可能引发模糊 (亚像素渲染), 必要时对尺寸取整.

### 9. 介绍 flex 布局和 grid 布局

A:

flex 是一维布局模型, 一次只处理一个方向 (主轴) 上的排列; grid 是二维布局模型, 同时控制行和列. 两者互补而非替代: flex 适合组件内部的内容分布, grid 适合页面级骨架与严格二维对齐.

flex 容器属性:

- `flex-direction`: 主轴方向, `row`(默认) / `row-reverse` / `column` / `column-reverse`
- `flex-wrap`: 是否换行, `nowrap`(默认) / `wrap`
- `justify-content`: 主轴对齐, `flex-start` / `center` / `flex-end` / `space-between` / `space-around` / `space-evenly`
- `align-items`: 交叉轴对齐 (单行), `stretch`(默认) / `center` / `baseline` 等
- `align-content`: 多行时行与行之间的分布, 单行无效
- `gap`: 项目间距, 替代子元素 margin 的方案

flex 项目属性:

- `flex-grow`: 放大比例, 默认 0 (不放大)
- `flex-shrink`: 缩小比例, 默认 1; 实际收缩量按 `flex-shrink × flex-basis` 加权分配, 基数大的缩得多
- `flex-basis`: 主轴上的初始基准尺寸, 默认 `auto` (取 width/height)
- `flex` 缩写: `flex: 1` 等价于 `flex: 1 1 0%`, 常见于均分剩余空间; 默认值是 `flex: 0 1 auto`
- `align-self`: 单个项目覆盖交叉轴对齐
- `order`: 改变视觉顺序 (不影响 DOM 顺序与无障碍顺序)

grid 容器核心属性:

- `grid-template-columns` / `grid-template-rows`: 定义轨道尺寸, 支持 `fr` 单位 (剩余空间份数)、`repeat()`、`minmax()`、`auto-fill` / `auto-fit`
- `gap` (`row-gap` / `column-gap`)
- `grid-template-areas`: 用命名区域画图, 可读性极强
- `justify-items` / `align-items` / `place-items`: 单元格内对齐
- `justify-content` / `align-content`: 整个网格在容器内的分布
- `grid-auto-flow`、`grid-auto-rows`: 控制隐式网格 (自动放置产生的轨道)

grid 项目属性: `grid-column` / `grid-row` (如 `grid-column: 1 / 3` 跨两列)、`grid-area`、`justify-self` / `align-self`.

经典对比代码:

```css
/* flex: 一行均分, 换行后最后一行无法对齐网格 */
.list {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.item {
  flex: 1 1 200px;
}

/* grid: 响应式卡片网格, 自动计算列数且每列严格对齐 */
.list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
```

`auto-fill` 与 `auto-fit` 的区别: 容器有剩余空间时, `auto-fill` 保留空轨道, `auto-fit` 折叠空轨道让现有项目拉伸填满, 均分卡片场景通常用 `auto-fit`.

### 10. 如何使用 CSS 实现中间宽度固定、两边宽度自适应的布局?

A:

以"左栏、中间主区固定 300px、右栏, 左右随窗口伸缩"为例, 常见有五种方案.

方案一: flex (现代首选)

```html
<div class="container">
  <aside class="left"></aside>
  <main class="center"></main>
  <aside class="right"></aside>
</div>
```

```css
.container {
  display: flex;
}
.left,
.right {
  flex: 1 1 0;
  min-width: 0;
} /* min-width: 0 防止内容撑破收缩 */
.center {
  flex: 0 0 300px;
}
```

方案二: grid (一行代码描述轨道)

```css
.container {
  display: grid;
  grid-template-columns: 1fr 300px 1fr;
}
```

方案三: 浮动 + margin (经典兼容方案)

左右栏分别左右浮动并定宽, 中间栏不浮动、用 margin 避让. 注意 DOM 顺序: 浮动元素必须在中间栏之前, 否则中间栏 (块级) 会独占一行把浮动挤下去.

```css
.left {
  float: left;
  width: 200px;
}
.right {
  float: right;
  width: 200px;
}
.center {
  margin: 0 200px;
}
```

方案四: 绝对定位

```css
.container {
  position: relative;
}
.left {
  position: absolute;
  left: 0;
  top: 0;
  width: 200px;
}
.right {
  position: absolute;
  right: 0;
  top: 0;
  width: 200px;
}
.center {
  margin: 0 200px;
}
```

缺点: 绝对定位脱离文档流, 侧栏高度超出时无法撑开容器, 页脚可能盖住侧栏.

方案五: 圣杯布局与双飞翼布局 (中间栏优先渲染的经典考题)

圣杯布局: 三栏全部左浮动, 中间栏 `width: 100%` 并放在 DOM 最前; 左栏 `margin-left: -100%` 拉到行首, 右栏 `margin-left: -右栏宽度`; 父容器用 `padding: 0 200px` 腾出两侧空间, 左右栏再相对定位归位.

双飞翼布局: 同样三栏左浮动、中间栏 `width: 100%`, 但中间栏内部再套一层 div 用 `margin: 0 200px` 避让, 不需要父 padding 和相对定位, 结构多一层但定位更简单.

对比总结: 现代项目直接用 flex/grid; 浮动与绝对定位方案主要涉及对文档流、浮动负 margin 的理解; 圣杯/双飞翼涉及中间栏优先加载 (SEO 时代诉求) 与负 margin 机制.

### 11. 什么是 margin 塌陷与 margin 合并? 如何解决?

A:

margin 合并 (collapsing margins) 指垂直方向上两个 margin 相遇时, 不叠加而是合并为其中较大者. 只发生在块级盒子的垂直方向, 水平方向永不合并. 三种典型场景:

1. 相邻兄弟元素: 上面的 `margin-bottom: 20px` 与下面的 `margin-top: 30px`, 实际间距 30px
2. 父子元素 (margin 穿透/塌陷): 父元素没有 border、padding、行内内容、清除浮动或 BFC 隔离时, 子元素的 `margin-top` 会"穿透"父元素, 表现为父元素整体向下移动, 而不是子元素在父元素内部下移
3. 空块元素自身的上下 margin 也会合并

不会合并的情形: 浮动元素、绝对定位元素、行内块、BFC 内部与外部之间、`display: flex`/`grid` 容器的子项之间.

解决方案:

- 父子穿透: 给父元素加 `padding-top` 或透明 `border`、触发父元素 BFC (`overflow: hidden`、`display: flow-root`), 或干脆改用 padding 实现间距
- 兄弟合并: 统一只用一个方向的 margin (如全部用 `margin-bottom`), 或用 flex/grid 容器的 `gap` 属性, gap 不参与合并, 是最现代的做法
- 用 `::before` 插入 `display: table` 的伪元素也可以隔断合并 (早期 clearfix 的副产物)

理解要点: margin 合并是规范刻意设计的排版行为 (段落间距不至于翻倍), 不是 bug; 工程上的最佳实践是用 `gap` 与单向 margin 约定规避它.

### 12. position 有哪些取值? sticky 是如何工作的?

A:

五个取值:

- `static`: 默认值, 正常文档流, `top/right/bottom/left/z-index` 无效
- `relative`: 仍在文档流中占位, 相对自身原位置偏移, 常用于给 absolute 后代做定位基准, 同时提升层叠优先级
- `absolute`: 脱离文档流, 相对最近的非 `static` 祖先的 padding box 定位 (其包含块; 带 `transform`/`filter` 等的祖先同样会成为包含块); 若无则相对初始包含块 — 尺寸与视口相同, 但锚定在文档顶部, 会随页面滚动而不是固定在可视区
- `fixed`: 脱离文档流, 相对视口定位, 滚动不移动
- `sticky`: 粘性定位, 是 relative 与 fixed 的混合体

sticky 工作机制: 元素在阈值内表现为 `relative`, 随正常流滚动; 一旦滚动到设定阈值 (如 `top: 0`), 就"粘"住表现为 `fixed`, 直到父容器滚出视口. 它始终被限制在其最近的滚动祖先与父容器范围内.

sticky 常见失效原因 (常见疑问):

1. 父级 (任意祖先) 设置了 `overflow: hidden` / `scroll` / `auto`, 且该父级不是实际滚动容器, 粘性参考的滚动盒被改变
2. 父元素高度与子元素一样高 (如父级 `height: 100%` 或 flex 拉伸), 没有可粘滞的活动空间
3. 未设置阈值属性 (至少给一个 `top`/`bottom`/`left`/`right`)
4. 表格相关元素上支持不全 (旧浏览器)

`fixed` 的坑 (常见疑问): 当祖先元素存在 `transform`、`filter`、`perspective`、`backdrop-filter`、`will-change: transform` 时, 该祖先会成为 fixed 元素的包含块, fixed 不再相对视口, 弹窗/悬浮按钮"跑飞"多半是这个原因.

### 13. z-index 为什么会失效? 什么是层叠上下文?

A:

层叠上下文 (stacking context) 是三维概念上的渲染分组: 同一层叠上下文内的元素按规则决定谁盖谁; 不同层叠上下文之间, 只比较两个上下文根元素的层级, 内部元素永远无法"越狱".

创建层叠上下文的常见条件:

- 根元素 `<html>` (根层叠上下文)
- `position` 为 `absolute` / `relative` 且 `z-index` 非 `auto`
- `position: fixed` / `sticky`
- flex 或 grid 容器的子项且 `z-index` 非 `auto`
- `opacity` 小于 1
- `transform`、`filter`、`perspective`、`backdrop-filter` 非 `none`
- `mix-blend-mode` 非 `normal`
- `isolation: isolate`
- `will-change` 值为上述属性
- `contain: layout` / `paint` / `content` / `strict`
- `-webkit-overflow-scrolling: touch` 等历史属性

同一层叠上下文内的绘制顺序 (从下到上):

1. 上下文根元素的背景与边框
2. 负 `z-index` 的定位元素
3. 普通流中的块级盒子
4. 浮动元素
5. 普通流中的行内盒子 (含 inline-block)
6. `z-index: 0` / `auto` 的定位元素
7. 正 `z-index` 的定位元素

z-index 失效的典型场景:

- 元素是 `static` 定位, `z-index` 本身不生效
- 父元素 (或祖先) 创建了层叠上下文且层级较低, 子元素 `z-index: 9999` 也翻不出父级的"天花板", 被别的父级分支盖住 — 这是"弹窗被遮挡"类 bug 的根源
- 同级元素都未设 z-index, 按绘制顺序后写的覆盖先写的, 看起来像失效

工程解法: 全局规划层级区间 (如基础 0、吸顶 100、抽屉 500、弹窗 1000、toast 2000), 弹窗类组件用 portal 挂到 `body` 下避开祖先层叠上下文, 或使用原生 `<dialog>` (top layer, 顶层渲染, 天然不被任何 z-index 遮挡).

### 14. CSS 中的浮动有什么特点? 如何清除浮动?

A:

浮动 (float) 最初设计用于实现文字环绕图片的效果, 后来被广泛用于页面布局. 理解浮动的特性对掌握 CSS 布局至关重要.

浮动的特点:

- 浮动元素脱离正常文档流, 向左或向右移动, 直到碰到包含块边界或另一个浮动元素
- 浮动元素不占据原文档流中的位置, 后续块级元素会忽略浮动元素的位置 (但行内内容会环绕)
- 浮动元素会创建 BFC (块级格式化上下文)
- 浮动元素的 display 计算值会被强制转为 block (如 float 的 span 表现为块级)
- 浮动元素的高度不会撑开父元素 (高度塌陷问题)

高度塌陷问题:

```html
<div class="parent">
  <div class="child" style="float: left; height: 100px;">浮动子元素</div>
</div>
<!-- parent 高度为 0, 因为子元素脱离了文档流 -->
```

清除浮动的方案:

方案一: 额外标签 + clear:

```html
<div class="parent">
  <div class="child" style="float: left;">浮动</div>
  <div style="clear: both;"></div>
</div>
```

缺点: 增加无意义的 DOM 节点.

方案二: 父元素触发 BFC:

```css
.parent {
  overflow: hidden;
}
```

原理: BFC 计算高度时会包含浮动子元素.

方案三: ::after 伪元素 (推荐):

```css
.clearfix::after {
  content: "";
  display: block;
  clear: both;
}

/* 更健壮的写法 */
.clearfix::before,
.clearfix::after {
  content: "";
  display: table;
}
.clearfix::after {
  clear: both;
}
```

方案四: 使用现代布局替代:

```css
.container {
  display: flex;
}

.container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}
```

clear 属性的值:

- `left`: 元素左侧不允许有浮动元素
- `right`: 元素右侧不允许有浮动元素
- `both`: 两侧都不允许有浮动元素

浮动布局的历史地位: 在 Flex 和 Grid 出现之前, 浮动是主要的布局手段. 现代开发中, 浮动应仅用于其原始目的 — 文字环绕效果, 布局应使用 Flex 或 Grid.

### 15. CSS 中的 grid 和 flex 应该如何选择?

A:

Grid 和 Flex 不是竞争关系, 而是互补的布局系统. 选择取决于布局维度和设计意图.

核心区别:

- Flex 是一维布局: 一次只处理一个方向 (行或列)
- Grid 是二维布局: 同时处理行和列

选择 Flex 的场景:

- 内容驱动的布局: 元素尺寸由内容决定, 需要弹性分配
- 单行/单列排列: 导航栏、按钮组、标签页、工具栏
- 对齐需求: 垂直居中、两端对齐、等分布局
- 组件内部: 卡片内容排列、表单项、列表项
- 不确定元素数量: 动态添加/删除元素时自动适应

```css
.nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.button-group {
  display: flex;
  gap: 8px;
}
```

选择 Grid 的场景:

- 页面级布局: header + sidebar + main + footer 的整体结构
- 精确的二维控制: 元素需要占据特定的行和列
- 复杂网格: 图片画廊、仪表盘、数据表格
- 重叠布局: 元素需要在网格中重叠
- 固定列数/行数: 设计稿明确定义了网格结构

```css
.page {
  display: grid;
  grid-template-areas:
    "header header"
    "sidebar main"
    "footer footer";
  grid-template-columns: 250px 1fr;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
```

两者配合:

```css
.page {
  display: grid;
  grid-template-columns: 250px 1fr;
  grid-template-rows: 60px 1fr 40px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card {
  display: flex;
  flex-direction: column;
}
```

决策流程:

1. 布局是二维的 (需要同时控制行和列)? 选 Grid
2. 布局是一维的 (只关心一个方向的排列)? 选 Flex
3. 元素位置由内容决定? 选 Flex
4. 元素位置由布局决定? 选 Grid
5. 需要重叠? 选 Grid
6. 不确定? 两者都试试, 选代码更简洁的

### 16. CSS 中的 gap 属性在 flex 和 grid 中有什么区别?

A:

gap 属性 (及其子属性 row-gap 和 column-gap) 用于设置网格或弹性容器中子元素之间的间距. 它在 Grid 和 Flex 中的行为基本一致, 但历史兼容性和使用场景有所不同.

语法:

```css
.container {
  gap: 16px; /* row-gap 和 column-gap 均为 16px */
  gap: 16px 24px; /* row-gap: 16px, column-gap: 24px */
  row-gap: 16px;
  column-gap: 24px;
}
```

在 Grid 中:

- Grid 从一开始就支持 gap (最初叫 grid-gap, 后统一为 gap)
- 控制网格轨道之间的间距
- 不影响容器边缘与第一个/最后一个子元素的距离

在 Flex 中:

- Flex 的 gap 支持较晚 (Chrome 84+, Firefox 63+, Safari 14.1+)
- IE 完全不支持 Flex gap
- 控制 flex item 之间的间距
- 换行时, row-gap 控制行间距, column-gap 控制列间距

与 margin 的对比:

```css
/* 传统方案: 用 margin 模拟 gap */
.flex-container > * + * {
  margin-left: 16px;
}

/* 或负 margin 方案 */
.flex-container {
  margin: -8px;
}
.flex-container > * {
  margin: 8px;
}

/* gap 方案: 更简洁, 无边缘多余间距 */
.flex-container {
  gap: 16px;
}
```

gap 的优势:

- 只在元素之间添加间距, 容器边缘没有多余间距
- 不需要处理第一个/最后一个子元素的特殊 margin
- 换行时自动处理行间距和列间距
- 代码更简洁, 意图更明确

兼容性注意:

- Grid gap: 所有现代浏览器均支持; IE 的旧版 -ms-grid 实现不支持 gap
- Flex gap: IE 不支持, 旧版 Safari (14.1 之前) 不支持
- 需要兼容旧浏览器时, 仍需使用 margin 方案

---

## 视觉绘制与常见效果

### 17. CSS 如何绘制一个三角形?

A:

方法一: border 法 (最经典)

元素宽高设为 0, 设置较粗的四条边框, 其中三条透明, 一条着色. 原理: 相邻边框交界处是 45° 斜切线, 宽高压成 0 后, 每条边框就是一个三角形.

```css
.triangle-up {
  width: 0;
  height: 0;
  border-left: 50px solid transparent;
  border-right: 50px solid transparent;
  border-bottom: 100px solid #f40;
}
```

要直角三角形: 只保留相邻两条边框, 一色一透明. 要更扁/更尖的三角形: 调整各边宽度比例.

方法二: linear-gradient 渐变法

用两个 45° 方向的线性渐变各画一半, 适合画菜单箭头, 且可以带圆角的感觉、可以只画"线框"三角:

```css
.arrow {
  width: 12px;
  height: 12px;
  background:
    linear-gradient(45deg, transparent 50%, #333 50%),
    linear-gradient(-45deg, #333 50%, transparent 50%);
  background-size: 50% 100%;
  background-position: left, right;
  background-repeat: no-repeat;
}
```

方法三: clip-path 裁剪法 (最直观)

```css
.triangle {
  width: 100px;
  height: 100px;
  background: #f40;
  clip-path: polygon(50% 0, 0 100%, 100% 100%);
}
```

优点: 不受 border 模型限制, 可以裁剪出任意多边形; 缺点: 老浏览器需 `-webkit-` 前缀, 裁剪外阴影会被裁掉.

方法四: transform 旋转法

画一个正方形, 只留相邻两边边框, 旋转 45°, 常用于下拉菜单顶部带边框的指向小三角 (能与容器边框颜色一致且带背景):

```css
.pop-arrow {
  width: 10px;
  height: 10px;
  background: #fff;
  border-left: 1px solid #ddd;
  border-top: 1px solid #ddd;
  transform: rotate(45deg);
}
```

延伸: 如何画带边框的三角形": border 法做不到, 常用双层叠加 (两个伪元素三角形错位 1px, 底色三角形稍大露边) 或方法四的旋转正方形方案.

### 18. 移动端 1px 问题是什么? 如何实现 0.5px 边框?

A:

问题本质: 在 DPR (devicePixelRatio) ≥ 2 的屏幕上, 1 个 CSS 像素由 2×2 或 3×3 个物理像素渲染, 导致 CSS 里写的 `1px` 边框在高分辨率屏上显得比设计稿 (设计稿的 1px 通常指 1 物理像素, 即 hairline) 粗. 这就是"移动端 1px 问题".

解决方案:

1. transform scale 伪元素法 (通用, 最推荐): 伪元素画 1px 边框再整体缩放一半

```css
.hairline {
  position: relative;
}
.hairline::after {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  width: 200%;
  height: 200%;
  border: 1px solid #ddd;
  transform: scale(0.5);
  transform-origin: 0 0;
  pointer-events: none;
  box-sizing: border-box;
}
```

只想要一条下边线就用 `border-bottom` + `transform: scaleY(0.5)`; 圆角同步放大再缩小即可.

2. viewport 整体缩放法 (早期手淘 flexible 方案): 按 DPR 动态设置 `<meta name="viewport" content="initial-scale=0.5">`, 页面所有 1px 自动变 hairline; 缺点是全页面元素都要按放大后的尺寸体系写, 且影响第三方组件, 新项目较少采用.

3. 渐变背景法: 用 `linear-gradient` 让 1px 高度的背景一半是颜色一半透明:

```css
.line {
  height: 1px;
  background: linear-gradient(to top, #ddd 50%, transparent 50%);
}
```

4. `box-shadow` 模拟: `box-shadow: 0 0.5px 0 #ddd;` 利用阴影的亚像素渲染.

5. 直接写 `0.5px`: iOS 8+ 的 Safari 支持小数物理像素边框, Android 大多会四舍五入成 0 或 1, 兼容性差, 只能渐进增强.

6. SVG 法: 用内联 SVG 画 1 物理像素的线, 配合 viewport 缩放或按 DPR 的 media query 切换.

媒体查询按 DPR 区分:

```css
@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 2dppx) { ... }
```

### 19. 隐藏元素有哪些方式? 它们有什么区别?

A:

常见方式及差异对比:

- `display: none`: 元素从渲染树移除, 不占空间, 不响应任何事件, 子元素一并消失, 屏幕阅读器读不到; 切换会触发 reflow + repaint; 不能直接做 transition 过渡 (需 `@starting-style` 或 `transition-behavior: allow-discrete` 等新特性)
- `visibility: hidden`: 仍在渲染树并占据空间, 不响应事件, 但子元素设置 `visibility: visible` 可以单独恢复显示; 屏幕阅读器读不到; 只触发 repaint; 支持 transition 过渡
- `opacity: 0`: 占据空间, 仍然会响应点击事件 (大坑), 屏幕阅读器可读; 仅触发合成层变化, 性能最好, 过渡最平滑; 会创建层叠上下文
- `position: absolute; left: -9999px;` 或 `transform: translateX(-100%)`: 移出视口, 占位与否取决于定位方式, 常用于"视觉隐藏但可被辅助技术读取"的场景
- `clip-path: inset(50%)` 或 `clip: rect(0 0 0 0)`: 裁剪隐藏, 无障碍场景常用的 visually-hidden 模式
- `height: 0; overflow: hidden;`: 高度塌陷隐藏, 常配合过渡做手风琴
- `z-index: -1` 或背景色遮挡: 不是真正隐藏, 只是盖住
- `hidden` 属性 / `aria-hidden="true"`: 语义层面隐藏

选择建议: 要过渡动画选 `opacity`/`visibility`; 彻底移除且不需要读屏选 `display: none`; 无障碍隐藏文本 (如图标按钮的文字说明) 用 visually-hidden 方案 (`clip-path` + 1px 尺寸 + 溢出裁剪) 而不是 `display: none`.

### 20. 如何实现单行和多行文本溢出省略号?

A:

单行 (三件套缺一不可):

```css
.ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
```

多行 (WebKit 私有属性, 但所有现代浏览器均已实现):

```css
.ellipsis-2 {
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
```

注意点:

- `display: -webkit-box` 会让子元素按旧版 flexbox 排版, 内部复杂结构可能被影响, 一般把这段样式挂在纯文本节点上
- `-webkit-line-clamp` 的标准化版本是 `line-clamp`, 规范在推进中
- 该方案省略号是浏览器自动加的, 无法定制"展开全文"按钮的位置

兼容老浏览器的多行方案:

- 限高法: 固定 `line-height`, 容器 `max-height: line-height × 行数` + `overflow: hidden`, 省略号用 `::after` 定位在右下角 (容易露馅, 需要背景遮盖)
- float 伪元素法: 用浮动把"…"挤到右下角
- JS 方案: 二分查找截断字符数, 或用 canvas measureText 测量, 最精确且有交互 (展开/收起) 时必选

flex/grid 容器中文本省略失效是高频 bug: flex 子项默认 `min-width: auto` 不会收缩到内容以下, 需要给 flex 子项加 `min-width: 0` (grid 子项同理可能需要 `minmax(0, 1fr)`), 内部 `text-overflow` 才生效.

### 21. px、em、rem、vw、vh 有什么区别? 如何选择?

A:

绝对单位:

- `px`: 最常用的绝对单位, 1 CSS 像素; 在高 DPR 屏上对应多个物理像素, 与设备无关的逻辑单位

相对单位:

- `em`: 相对当前元素自身的 `font-size`; 但用在 `font-size` 属性本身上时, 相对父元素的 `font-size`. 嵌套使用会逐层累积放大/缩小, 难维护, 这是它最大的坑
- `rem`: 永远相对根元素 (`<html>`) 的 `font-size`, 无累积问题, 常用于整体可缩放的布局体系
- `vw` / `vh`: 视口宽/高的 1%; 衍生有 `vmin`、`vmax`, 以及解决移动浏览器地址栏伸缩问题的 `svh` (small)、`lvh` (large)、`dvh` (dynamic)
- `%`: 相对包含块对应属性 (宽度相对包含块宽度, 高度相对包含块高度 — 高度百分比需要父链有确定高度才生效; `padding`/`margin` 的百分比一律相对包含块宽度, 包括垂直方向, 可利用此特性做固定宽高比容器)
- 字体相对: `ch` (数字 0 的宽度, 等宽排版好用)、`ex`、`lh` / `rlh` (行高)
- 容器查询单位: `cqw` / `cqh` / `cqmin` / `cqmax`, 相对查询容器尺寸

典型选择策略:

- 布局尺寸: PC 后台用 px; 移动端适配用 rem (flexible 方案动态算 html font-size) 或 vw 方案 (postcss-px-to-viewport, 设计稿 375 时 100vw = 375px)
- 字体: 需要跟随用户系统字号设置 (可访问性) 用 rem; 局部组件希望随父级字号缩放的微调场景用 em (如按钮内图标与文字的相对比例)
- 全屏弹层/首屏高度: `100dvh` 优于 `100vh` (移动端地址栏)
- 最大宽度限制阅读宽度: `max-width: 70ch` 之类

### 22. 什么是 CSS 的 aspect-ratio 属性?

A:

aspect-ratio 是 CSS 中用于设置元素宽高比的属性, 替代了传统的 padding-top 百分比 hack 方案.

语法:

```css
.element {
  aspect-ratio: 16 / 9;
  aspect-ratio: 1;
  aspect-ratio: 4 / 3;
  aspect-ratio: auto;
  aspect-ratio: auto 16 / 9;
}
```

传统方案 (padding hack):

```css
.video-wrapper {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 9/16 = 56.25% */
}

.video-wrapper > * {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
```

aspect-ratio 方案:

```css
.video-wrapper {
  width: 100%;
  aspect-ratio: 16 / 9;
}
```

工作原理:

- 当元素只设置了 width 或 height 之一时, aspect-ratio 自动计算另一个维度
- 如果同时设置了 width 和 height, aspect-ratio 被忽略
- 对于替换元素 (img、video), 默认使用固有宽高比

```css
.square {
  width: 200px;
  aspect-ratio: 1;
}

.banner {
  height: 300px;
  aspect-ratio: 21 / 9;
}

.card-image {
  width: 100%;
  aspect-ratio: 4 / 3;
}
```

与 max-width/max-height 配合:

```css
.element {
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 500px;
}
```

---

## CSS 工程化与样式方案

### 23. 介绍 CSS 原子化 (tailwindcss 的核心原理)、css-in-js 的核心原理、CSS 模块化 (.module.css 的核心原理), 按性能排序, 解释 css-in-js 为什么性能差?

A:

三者都是解决"样式组织与作用域"的工程方案, 但实现时机与形态完全不同.

CSS 原子化 (Tailwind CSS 核心原理):

- 思想: 每个类只做一个样式声明, 如 `flex`、`mt-4` (margin-top: 1rem)、`text-red-500`, 通过组合大量原子类拼装 UI, 不写自定义 CSS
- 实现: 构建期扫描所有源码文件 (v3 需在 content 配置中声明 glob, v4 起默认自动探测源文件), 用正则提取类名 token, JIT (Just-In-Time) 按需生成对应的工具类 CSS 规则, 输出一份静态样式表; 未使用的类不会出现在产物中, 产物体积只随用到的不同工具类数量增长, 随项目变大很快收敛
- 变体机制: `hover:`、`md:`、`dark:` 等前缀编译为伪类/媒体查询包裹的规则; 动态值通过 CSS 变量注入 (如 `bg-[var(--brand)]`)
- 产物是纯静态 CSS, 零运行时

css-in-js 核心原理:

- 思想: 样式即 JS 值, 用 JS 的表达力 (变量、函数、props 插值) 写样式, 天然与组件同生命周期、天然作用域隔离
- 运行时流派 (styled-components、emotion): 渲染时把模板字符串解析成 CSS 文本, 序列化后对内容做 hash 生成唯一类名, 通过 `<style>` 标签或 `CSSStyleSheet.insertRule()` 插入文档; 有缓存, 相同样式只插入一次
- 编译时流派 (Linaria、vanilla-extract、compiled): Babel/构建插件在编译期把样式代码静态求值并抽取成普通 `.css` 文件, 运行时只剩类名映射, 动态部分用 CSS 变量传值, 零运行时成本

CSS Modules (.module.css 核心原理):

- 思想: 保留写原生 CSS 的习惯, 默认所有类名局部作用域
- 实现: 构建工具 (webpack css-loader / Vite 内置) 处理 `.module.css` 文件时, 把每个类名改写为带 hash 的唯一名 (如 `.title` → `._title_x7a2b_1`), 同时生成一份"原名 → 混淆名"的映射对象导出给 JS:

```js
import styles from "./App.module.css";
// styles.title === '_title_x7a2b_1'
<div className={styles.title} />;
```

- 配套机制: `:global()` 声明全局类; `composes` 在模块间组合复用类; 构建期完成, 产物同样是纯静态 CSS

性能排序 (从优到劣):

CSS 原子化 ≈ CSS Modules > 编译时 css-in-js > 运行时 css-in-js

前两者与编译时 css-in-js 都是构建期产出静态 CSS, 浏览器直接并行下载、解析、缓存, 没有任何 JS 运行时开销; 运行时 css-in-js 则把样式生成搬到了浏览器运行阶段.

运行时 css-in-js 性能差的原因 (重点):

1. 序列化开销: 每次组件渲染都要把 props/state 插值进模板并序列化成 CSS 字符串, 还要对内容做 hash 查缓存; 列表场景每个 item 样式不同则完全失去缓存, 渲染成本随渲染次数线性增长
2. 样式注入触发样式重算: 动态插入/更新 `<style>` 规则会使受影响子树重新进行样式计算 (recalculate style), 高频变更 (如动画、滚动联动) 时甚至引发连续 reflow
3. 阻塞在 JS 之后: 静态 CSS 由浏览器预加载扫描器提前并行下载; css-in-js 的样式必须等 JS 下载、解析、执行、组件渲染后才存在, 首屏样式可用时间显著延后, SSR 下还要额外做样式收集 (flush) 与注水, 增加 HTML 体积与 hydration 成本
4. 缓存不友好: 动态生成的类名随内容变化, 浏览器无法像静态文件那样长缓存; 库本身还有额外的 runtime 包体积
5. React 并发渲染的副作用约束: 渲染期间插入样式是副作用, React 18 为此专门提供了 `useInsertionEffect`, 说明该模式与并发特性存在本质张力, 处理不当会出现样式闪烁 (FOUC)

补充结论: 这不是说 css-in-js 一无是处 — 它的动态样式表达力、与组件共存亡的维护性仍适合强主题化、强动态的场景; 但性能敏感、SSR、大体量项目应优先选静态方案 (Tailwind / CSS Modules / 编译时 css-in-js), 这也是社区公开反思运行时 css-in-js (如 "Why We're Breaking Up with CSS-in-JS" 一文) 并整体转向静态方案的大背景.

### 24. Web Component 如何实现样式隔离?

A:

Web Component 的样式隔离依赖 Shadow DOM. 通过 `el.attachShadow({ mode: 'open' })` 在宿主元素内挂载一棵影子树, 影子树拥有独立的 DOM 作用域和样式作用域:

- 外部文档的 CSS 选择器无法选中影子树内部节点, 全局样式不会影响内部 (例外: 可继承属性和 CSS 自定义属性仍能穿透)
- 影子树内部的 `<style>` 样式也不会泄漏到外部文档

```js
class MyCard extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .title { color: red; } /* 只作用于本组件内部 */
      </style>
      <div class="title"><slot></slot></div>
    `;
  }
}
customElements.define("my-card", MyCard);
```

配套的样式控制接口 (隔离与开放的平衡点, 延伸):

- `:host`: 在影子树内部选中宿主元素本身; `:host(.active)`、`:host([disabled])` 按宿主状态匹配; `:host-context(.dark)` 按宿主所处祖先上下文匹配
- `::slotted()`: 给通过 `<slot>` 分发进来的外部内容设置样式, 但只能选中插槽的直接子节点, 不能深入内部
- CSS 自定义属性穿透: 外部定义 `--card-color`, 内部 `color: var(--card-color)`, 是官方推荐的主题化/定制通道, 因为 CSS 变量天然继承穿透 shadow 边界
- `::part()`: 组件内部元素标注 `part="button"`, 外部用 `my-card::part(button) { }` 精确定制, 是"受控开放"的标准方式
- Constructable Stylesheets: `new CSSStyleSheet()` + `shadow.adoptedStyleSheets = [sheet]`, 在多个组件实例间共享同一份样式表, 避免每个实例内联重复 `<style>`, 是性能最佳实践

注意点:

- `mode: 'closed'` 时 `element.shadowRoot` 返回 null, 外部脚本无法访问影子树, 隔离更强但调试与扩展更难
- 全局 reset、字体、`@font-face` 不会自动进入影子树, 需要每个组件内自行引入或通过 adoptedStyleSheets 注入
- 与 iframe 对比: Shadow DOM 是"样式与 DOM 作用域"隔离, 共享同一文档与 JS 上下文; iframe 是完整的浏览上下文隔离, 更彻底但通信成本高

### 25. scss 是什么? 有什么用? scss 的 mixin 等常用语法有哪些?

A:

SCSS 是 CSS 预处理器 Sass 的主流语法 (缩进语法叫 Sass, 花括号语法叫 SCSS), 它是 CSS 的超集, 任何合法 CSS 都是合法 SCSS. 浏览器不认识 SCSS, 需要编译器 (dart-sass) 编译为纯 CSS 后使用.

解决的问题: 原生 CSS 缺乏变量 (CSS 变量出现之前)、复用机制、逻辑运算与模块化能力, 大型项目样式难以维护.

常用语法清单:

1. 变量: `$primary: #1677ff;` 支持作用域, `!default` 标记可被覆盖的默认值 (主题定制常用)

2. 嵌套与父选择器 `&`:

```scss
.card {
  padding: 16px;
  &:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  } /* & 引用父选择器 .card */
  &-title {
    font-size: 18px;
  } /* 拼接为 .card-title */
}
```

3. mixin 与 include: 定义可复用、可带参数的样式块

```scss
@mixin flex-center($direction: row) {
  display: flex;
  flex-direction: $direction;
  justify-content: center;
  align-items: center;
  @content; /* 允许调用方注入额外声明 */
}
.box {
  @include flex-center(column) {
    gap: 8px;
  }
}
```

4. 继承 / 占位选择器: `@extend` 与 `%placeholder`

```scss
%btn-base {
  display: inline-block;
  border-radius: 4px;
}
.btn-primary {
  @extend %btn-base;
  background: $primary;
}
```

mixin 与 extend 的核心区别 (常见疑问): mixin 是"复制声明"到每个调用处, 支持参数, 产物体积可能膨胀; extend 是"合并选择器"到同一组声明, 产物更精简但不能传参, 且会改变选择器位置, 可能引入意外的层叠顺序. 带参复用选 mixin, 纯静态公共样式选占位选择器.

5. 运算与函数: `+ - * /`(除法推荐 `math.div($a, $b)`)、内置函数 (`lighten()`、`darken()`、`map-get()`、`if()`...)、`@function` 自定义函数 (有返回值, 与 mixin 区分)

6. 控制指令: `@if / @else`、`@for $i from 1 through 12`、`@each $name in $list`、`@while`, 常用于栅格系统、间距工具类批量生成

7. 插值: `#{$var}` 把变量嵌入选择器、属性名、URL 等任意位置

8. 模块化: `@use 'file' as ns` (命名空间加载, 每个文件只加载一次) 与 `@forward` (聚合转发), 已取代会重复引入、污染全局的 `@import`

```scss
@use "variables" as v;
.btn {
  color: v.$primary;
}
```

现代定位: CSS 原生变量、嵌套 (CSS Nesting) 普及后, SCSS 的变量与嵌套需求在弱化, 但 mixin、循环、函数、构建期逻辑仍是不可替代的生产力工具, 常与 PostCSS 串联使用 (scss → autoprefixer → cssnano).

### 26. PostCSS 是什么? 有什么用?

A:

PostCSS 是一个用 JS 插件生态转换 CSS 的工具平台. 工作流: 把 CSS 源码解析成 AST (抽象语法树) → 插件遍历修改 AST → 重新序列化为 CSS. 它本身不做任何事, 一切能力来自插件.

与预处理器 (SCSS/Less) 的本质区别 (常见疑问): 预处理器是"另一门语言 → CSS"的编译器, 处理的是源码; PostCSS 是"CSS → CSS"的转换器, 处理的是产物. 二者在构建链中串联而非互斥: 先 SCSS 编译, 再 PostCSS 转换.

代表插件与用途:

- `autoprefixer`: 基于 caniuse 数据与 browserslist 配置, 自动添加/移除厂商前缀 (`-webkit-` 等), 是最知名的插件
- `postcss-preset-env`: 把未来的 CSS 语法 (嵌套、自定义媒体查询、`color-mix` 等) 按目标浏览器降级为可用语法, 类似 CSS 界的 Babel preset
- `cssnano`: 压缩优化 (去注释、合并规则、压缩颜色/单位/计算值)
- `postcss-pxtorem` / `postcss-px-to-viewport`: 移动端适配, 构建期把 px 批量换算为 rem/vw
- `postcss-modules`: CSS Modules 的底层实现之一
- `tailwindcss` / `@tailwindcss/postcss`: Tailwind 通过官方 PostCSS 插件接入任意构建链 (v3 内置于 tailwindcss 包; v4 起核心为独立的高性能引擎, PostCSS 插件拆分为 `@tailwindcss/postcss`, 另提供 Vite 插件与 CLI 接入方式)
- `stylelint` 的自动修复也跑在 PostCSS 之上

自定义插件示例 (感受 AST 操作):

```js
const plugin = () => ({
  postcssPlugin: "add-ie-hack",
  Declaration(decl) {
    if (decl.prop === "position" && decl.value === "sticky") {
      decl.cloneBefore({ prop: "position", value: "-webkit-sticky" });
    }
  },
});
plugin.postcss = true;
```

在 webpack 中的位置: `sass-loader` (编译 scss) → `postcss-loader` (autoprefixer 等) → `css-loader` (处理 import/url 与 modules) → `style-loader` 或 `mini-css-extract-plugin`.

延伸: Lightning CSS (Rust) 与基于 SWC 的方案用原生速度重做了 PostCSS 的多数场景 (前缀、压缩、降级), 是新构建工具链的趋势.

### 27. CSS 变量 (自定义属性) 与 SCSS 变量有什么区别?

A:

这是"编译期"与"运行时"的区别, 是理解现代主题方案的关键.

CSS 自定义属性 (运行时):

```css
:root {
  --brand: #1677ff;
}
.btn {
  color: var(--brand, #333);
} /* 第二参数是回退值 */
```

- 真实存在于 DOM 计算样式中, 运行时可读写: `el.style.setProperty('--brand', 'red')` 立即生效, 全页面引用处联动更新
- 遵循层叠与继承规则: 可以在任意选择器、媒体查询、`:hover` 中重新定义, 局部覆盖
- 可以做运行时主题切换、用户自定义皮肤、响应式变量
- 参与动画/transition 需 `@property` 注册类型后才可过渡

SCSS 变量 (编译期):

- 编译时被静态替换为字面量, 产物中不存在, 浏览器无感知
- 无法运行时修改, 改主题必须重新编译
- 但可以参与编译期运算、循环、mixin 参数等逻辑, 表达力更强
- 有作用域概念: 变量有块级作用域, `!global` 显式提升为全局, `!default` 声明可被后续赋值覆盖的默认值 (两者机制不同)

工程实践 (二者结合): 用 SCSS 变量管理设计 token 的"事实来源", 编译输出为 CSS 变量, 运行时主题/动态需求全部走 CSS 变量:

```scss
$brand: #1677ff;
:root {
  --brand: #{$brand}; /* 编译期定值, 运行时可改 */
}
[data-theme="dark"] {
  --brand: #4e8cff;
}
```

### 28. link 和 @import 有什么区别?

A:

- 本质不同: `<link>` 是 HTML 标签, `@import` 是 CSS 规则, 且必须写在 CSS 文件最顶部 (除 `@charset`/`@layer` 外) 才有效
- 加载时机: 多个 `<link>` 并行下载, 且浏览器预加载扫描器 (preload scanner) 能在 HTML 解析早期就发现并发起请求; `@import` 必须等包含它的 CSS 文件下载并解析后才能发现下一层 URL, 形成串行瀑布, 嵌套时延迟逐级放大
- 能力差异: `<link>` 支持 `rel="preload"`、`rel="alternate stylesheet"`、`media`、`disabled` 等, 且能被 JS 操作 DOM 动态增删; `@import` 也支持媒体查询后缀 (`@import url(a.css) screen;`), 但无法被 JS 直接操控, 也没有预加载能力
- 渲染阻塞: 两者都是渲染阻塞资源; 但 `@import` 的串行特性会显著拖慢首次渲染
- 历史兼容: 极老浏览器 (IE4 及更早) 不支持 `@import`, 当年曾用作 hack, 如今无意义

结论: 生产环境永远用 `<link>` 加载样式表, 避免 `@import`; 需要异步加载非关键 CSS 时用 `media="print" onload` 或 `rel="preload" as="style"` 技巧.

### 29. 什么是 CSS Modules? 它的原理是什么?

A:

CSS Modules 是一种 CSS 类名局部作用域方案, 通过构建工具在编译时将类名转换为唯一标识符, 避免全局样式冲突.

核心原理 — 编译时转换:

- 构建工具 (Webpack 的 css-loader、Vite 内置支持) 识别 `.module.css` 后缀
- 将 CSS 文件中的每个类名转换为唯一的哈希字符串
- 转换规则通常为: `[文件名]_[类名]_[哈希]`, 如 `Button_primary_abc123`
- 生成一个 JSON 映射对象, 导出原始类名到哈希类名的对应关系
- JavaScript 通过 import 获取映射对象, 使用映射后的类名

```css
/* Button.module.css */
.primary {
  background: #1890ff;
  color: white;
}

.large {
  padding: 16px 32px;
  font-size: 18px;
}
```

```javascript
import styles from "./Button.module.css";

function Button({ size }) {
  return (
    <button
      className={`${styles.primary} ${size === "large" ? styles.large : ""}`}
    >
      按钮
    </button>
  );
}
```

编译后的 HTML:

```html
<button class="Button_primary_abc123 Button_large_def456">按钮</button>
```

特性:

局部作用域:

- 类名只在当前模块内有效, 不会污染全局
- 不同文件可以使用相同的类名, 编译后哈希不同, 互不冲突

全局样式:

```css
:global(.global-class) {
  color: red;
}

:global {
  .another-global {
    color: blue;
  }
}
```

组合 (composes):

```css
.base {
  padding: 8px 16px;
  border-radius: 4px;
}

.primary {
  composes: base;
  background: #1890ff;
}
```

与其他方案的对比:

| 维度       | CSS Modules  | CSS-in-JS    | 原子化 CSS   |
| ---------- | ------------ | ------------ | ------------ |
| 作用域     | 编译时哈希   | 运行时生成   | 预定义类名   |
| 运行时开销 | 无           | 有           | 无           |
| 动态样式   | 不支持       | 支持         | 有限支持     |
| 学习成本   | 低           | 中           | 中           |
| 工具链依赖 | 需要构建工具 | 需要运行时库 | 需要构建工具 |

局限性:

- 类名是静态的, 无法根据 props 动态生成
- 需要构建工具支持, 无法在纯 HTML 中使用
- 调试时类名是哈希值, 不够直观 (可通过配置保留原始类名)
- 无法处理 JavaScript 驱动的动态样式 (如根据状态改变颜色)

### 30. 如何实现 CSS 的按需加载和懒加载?

A:

CSS 按需加载和懒加载是性能优化的重要手段, 目标是减少首屏加载的 CSS 体积, 只在需要时加载对应样式.

代码分割 (Code Splitting):

```javascript
// Webpack: 动态 import 触发 CSS 分割
const openModal = async () => {
  const { Modal } = await import("./Modal");
};

// React.lazy + Suspense
const HeavyComponent = React.lazy(() => import("./HeavyComponent"));
```

CSS 懒加载:

```javascript
function loadCSS(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = resolve;
    link.onerror = reject;
    document.head.appendChild(link);
  });
}

button.addEventListener("click", async () => {
  await loadCSS("/css/editor.css");
  openEditor();
});
```

媒体查询分割:

```html
<link rel="stylesheet" href="print.css" media="print" />
<link rel="stylesheet" href="mobile.css" media="(max-width: 768px)" />
```

注意: media 属性不会阻止 CSS 下载, 浏览器仍会下载所有 CSS, 只是不匹配时不阻塞渲染. 真正的按需加载需要 JavaScript 动态插入.

Critical CSS (关键 CSS):

```html
<style>
  .header {
    height: 60px;
    background: #fff;
  }
  .hero {
    min-height: 80vh;
  }
</style>

<link
  rel="preload"
  href="full.css"
  as="style"
  onload="this.onload=null;this.rel='stylesheet'"
/>
<noscript><link rel="stylesheet" href="full.css" /></noscript>
```

工具支持:

- critical: 自动提取首屏关键 CSS
- critters: Webpack 插件, 内联关键 CSS
- purgecss: 移除未使用的 CSS
- uncss: 分析 HTML, 移除未使用的 CSS

Tailwind CSS 的按需生成:

```javascript
// tailwind.config.js
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
};
```

最佳实践:

- 首屏 CSS 控制在 14KB 以内 (一个 TCP 包)
- 关键 CSS 内联到 HTML, 非关键 CSS 异步加载
- 路由级代码分割, 每个页面独立 CSS chunk
- 使用 PurgeCSS 移除未使用的样式
- 组件库使用按需引入 (如 babel-plugin-import)
- 避免 @import, 它会串行加载 CSS

### 31. 什么是 CSS 的 @layer 规则?

A:

@layer (Cascade Layers) 是 CSS 层叠层规则, 允许开发者显式定义样式的优先级层级, 解决第三方库样式覆盖困难、特异性战争等问题.

问题背景:

```css
/* 第三方库的样式, 特异性很高 */
.ui-lib .btn.btn-primary {
  background: blue;
}

/* 你想覆盖它, 但需要更高的特异性 */
.my-app .container .btn.btn-primary {
  background: red;
}
```

@layer 解决方案:

```css
@layer reset, base, components, utilities;

@layer reset {
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
}

@layer base {
  body {
    font-family: sans-serif;
    line-height: 1.5;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
}

@layer components {
  .btn {
    padding: 8px 16px;
    border-radius: 4px;
  }
  .btn-primary {
    background: #1890ff;
    color: #fff;
  }
}

@layer utilities {
  .mt-4 {
    margin-top: 16px;
  }
  .text-center {
    text-align: center;
  }
}
```

层级规则:

- 后声明的 layer 优先级高于先声明的
- 未归属任何 layer 的样式优先级最高
- 同一 layer 内, 按正常的特异性和源码顺序决定
- layer 的优先级覆盖特异性: utilities 层的 `.mt-4` 可以覆盖 components 层的 `.btn-primary`, 即使后者特异性更高

嵌套 layer:

```css
@layer framework {
  @layer layout {
    .container {
      width: 100%;
    }
  }
  @layer theme {
    .container {
      background: #fff;
    }
  }
}

@layer framework.theme {
  .container {
    background: #f5f5f5;
  }
}
```

匿名 layer:

```css
@layer {
  .element {
    color: red;
  }
}
```

与第三方库配合:

```css
@layer third-party, app;

/* @import 不能嵌在 @layer 块内 (会被忽略), 需用 layer() 导入条件指定归属层 */
@import "normalize.css" layer(third-party);
@import "ui-library.css" layer(third-party);

@layer app {
  .btn {
    background: red;
  }
}
```

---

## 渲染原理与性能优化

### 32. 什么是重排 (reflow) 和重绘 (repaint)? 如何避免?

A:

渲染管线: DOM + CSSOM → Render Tree → Layout (重排) → Paint (重绘) → Composite (合成).

- 重排 (reflow/layout): 几何信息变化时重新计算元素位置与大小. 触发源: 增删可见 DOM、修改宽高/边距/定位/字体、窗口 resize、内容变化 (图片加载完成)、激活伪类改变布局等
- 重绘 (repaint): 外观变化但几何不变时重新绘制像素, 如 `color`、`background`、`box-shadow`、`visibility`
- 合成 (composite): `transform`、`opacity` 在合成线程直接变换已有图层, 既不重排也不重绘, 成本最低

关系: 重排必然引发重绘和合成, 重绘必然引发合成; 重排是开销最大的操作, 且会向上向下传染 (父级尺寸变化导致整棵子树重排).

强制同步布局 (layout thrashing, 常见疑问): 读取 `offsetWidth`、`offsetTop`、`getBoundingClientRect()`、`scrollTop` 等几何值时, 若队列中有未应用的重排, 浏览器被迫立即同步执行重排以返回正确值; 在循环中"写样式 → 读几何 → 再写样式"会造成每轮都同步重排, 是典型性能杀手.

优化手段:

- 批量修改: 用 `class` 切换代替逐条 `style` 赋值; 用 `DocumentFragment` 或一次性 `innerHTML` 做 DOM 批量插入; 元素先 `display: none` (脱离渲染树) 改完再显示, 两次重排代替 N 次
- 读写分离: 先集中读几何值缓存, 再集中写样式
- 动画只用 `transform` / `opacity`, 配合 `will-change` 提升合成层
- 脱离文档流: 对频繁操作的元素用 `position: absolute/fixed`, 重排范围限于自身
- 使用 `requestAnimationFrame` 合并每帧的样式写操作
- 虚拟列表、`content-visibility: auto` 减少参与布局的节点数

### 33. CSS 会阻塞渲染吗? 会阻塞 JS 执行吗?

A:

两条结论都要答, 且机制不同:

CSS 阻塞渲染 (render-blocking): 是. 浏览器必须等 CSSOM 构建完成才能合成渲染树并首绘, 否则会出现无样式闪烁 (FOUC). 所以 CSS 被称为渲染阻塞资源. 但它不阻塞 HTML 解析 — 预加载扫描器会在解析 HTML 的同时并行下载 CSS.

CSS 阻塞其后 JS 的执行: 是. 因为 JS 可能读取样式 (如 `getComputedStyle`), 规范要求脚本执行前, 它前面的所有样式表必须加载并构建完 CSSOM. 而脚本执行又会阻塞 HTML 解析 (同步脚本), 于是一条慢 CSS 会间接冻结整个页面解析. 经典依赖链:

```
CSSOM 未就绪 → 后面 <script> 无法执行 → HTML 解析暂停 → DOM 就绪延后 → 首屏延后
```

media 的例外: `media="print"` 或媒体查询当前不匹配 (如 `media="(max-width: 600px)"` 在桌面) 的样式表不阻塞渲染, 但仍会下载 (低优先级).

优化实践:

- 关键 CSS (Critical CSS) 内联进 HTML, 非关键样式异步加载 (`rel="preload" as="style" onload="this.rel='stylesheet'"` 或 `media="print"` 切换法)
- 按路由/页面拆分 CSS (代码分割), 减少首包样式体积
- `<link>` 尽量靠前放在 `<head>`, 让预加载扫描器尽早发现
- 脚本加 `defer`/`async` 解除对解析的阻塞; `defer` 脚本同样要等 CSSOM, 这是规范行为

### 34. 什么是 GPU 合成层? 如何开启 GPU 加速? 有什么注意事项?

A:

现代浏览器把页面分成若干图层 (layer), 普通图层由主线程绘制后交给合成器; 满足特定条件的元素会被提升为合成层 (compositing layer), 拥有独立的 GPU 纹理, 其 `transform`、`opacity` 变化由合成器线程直接处理, 跳过主线程的 layout 和 paint, 因此动画可以达到 60fps 且不被主线程 JS 阻塞.

常见提升为合成层的条件:

- `transform: translateZ(0)` / `translate3d(...)` / 3D 变换
- `will-change: transform` / `opacity` / `filter`
- `opacity` 或 `transform` 正在做 CSS animation/transition
- `<video>`、`<canvas>`、`<iframe>` 等元素
- `filter`、`backdrop-filter` 非 none
- `position: fixed` (部分浏览器策略)
- 与已有合成层发生重叠且 `z-index` 在其上的元素 (隐式合成)

开启 GPU 加速的写法:

```css
.box {
  will-change: transform; /* 标准推荐 */
  /* 或历史 hack: transform: translateZ(0); */
}
```

注意事项 (常见疑问):

1. 内存代价: 每个合成层都是一份独立纹理, 过度提升 (尤其隐式合成引发的"层爆炸") 会暴涨 GPU 内存, 低端设备反而掉帧卡顿
2. `will-change` 是"预告"不是"许愿": 应在动画前短期添加、结束后移除, 长期挂在大量元素上等于白白占内存
3. 合成层只对 `transform`/`opacity`/`filter` 的动画免 layout/paint; 改 `top`/`left`/`width` 照样走主线程
4. 层提升会改变渲染上下文: 创建层叠上下文、`transform` 会成为 `fixed` 后代的包含块 (见第 12 题), 可能引入定位 bug
5. 文字模糊: 缩放类 transform 动画后位图放大可能模糊, 需要重新栅格化或调整动画策略

### 35. 浏览器渲染页面的完整流程是什么? 什么是 CSSOM?

A:

从网络字节到屏幕像素的完整管线:

1. 解析 HTML: 字节 → 字符 → Token → 节点 → DOM 树; 解析中遇到 `<script>` (无 async/defer) 会暂停, 遇到 `<link>` CSS 不暂停但会阻塞渲染与后续脚本
2. 解析 CSS 构建 CSSOM: 同样经历 字节 → 字符 → Token → 节点 → CSSOM 树. CSSOM 是树结构的原因: 样式要按层叠规则继承与覆盖, 子节点继承父节点可继承属性, 就近/高优先级声明覆盖
3. 合并生成 Render Tree (渲染树): DOM 与 CSSOM 结合, 只包含可见节点 — `display: none`、`head`、`script` 等不进入; 每个节点带计算后的完整样式
4. Layout (布局/重排): 计算每个节点的几何信息 (x, y, width, height)
5. Paint (绘制): 分层并把每个图层绘制成绘制指令记录, 再栅格化 (raster) 为位图, 现代浏览器栅格化也在 GPU 进程分块 (tile) 进行
6. Composite (合成): 合成器线程把各图层位图按 transform/opacity/z-order 合成最终帧, 提交显示

关键渲染路径 (Critical Rendering Path) 优化的所有手段都围绕这条链: 减少关键资源数量与体积 (压缩、拆分、内联关键 CSS)、缩短关键路径长度 (预加载、提前发现)、减少重排重绘 (第 32 题).

预加载扫描器 (preload scanner): 主解析器被脚本阻塞时, 扫描器向前预读 HTML, 提前发起 CSS/JS/字体/图片请求, 是浏览器的重要优化, 也说明为什么资源要写在 HTML 里而不是 JS 动态插入.

`async` 与 `defer` 区别 (常一并讨论): `async` 下载完立即执行 (执行时阻塞解析, 顺序不保证); `defer` 下载并行、延迟到 DOM 解析完成后按顺序执行; `type="module"` 默认 defer 行为.

### 36. CSS 选择器是从左往右还是从右往左匹配的? 为什么?

A:

从右往左匹配. 最右侧的选择器称为关键选择器 (key selector).

原因: 渲染引擎为每个元素找样式时, 先用关键选择器在整棵 DOM 中筛出候选元素集合, 然后沿每个候选元素向祖先方向逐层验证左边的选择器. 从右往左让绝大多数规则在第一步就被排除 — 比如 `.nav .list a` 先用 `a` 选中页面所有链接, 再向上检查是否有 `.list`、`.nav` 祖先, 不匹配立即放弃该分支.

如果反过来从左往右: 先找 `.nav`, 再在整棵子树里找 `.list`, 再找 `a`, 每次都要遍历整棵子树, 且规则不匹配时已经付出了大量遍历成本, 回溯代价高得多.

由此产生的编码推论:

- 关键选择器越精确越好: `.nav a` 比 `.nav *` 高效; 避免以通配符或标签结尾的深层选择器
- 嵌套层级不必过深: `.nav a` 通常就够了, `.header .nav .list .item a` 既慢又脆弱
- ID/类选择器本身有索引加速, 现代浏览器 (Bloom filter、rule hash) 对选择器匹配已高度优化, 真实项目中选择器性能很少成为瓶颈, 优先级远低于重排与 JS 开销

这条规则也解释了为什么"父选择器"长期不存在: 从左的上下文决定右侧元素需要反向查询, 与引擎匹配方向冲突. `:has()` 的出现是引擎专门做了前向检查优化才实现的, 所以规范禁止 `:has()` 内嵌伪元素等可能引发循环/高成本的组合.

### 37. content-visibility 和 contain 属性有什么用?

A:

二者都属于 CSS Containment (容器包含) 体系, 核心思想: 开发者向浏览器承诺"某子树与外界互不影响", 浏览器据此跳过子树的样式计算、布局与绘制, 换取性能.

`contain` 属性的取值:

- `layout`: 内部布局独立, 内部变化不引发外部重排
- `paint`: 后代不绘制到元素边界外 (等价于裁剪), 外部不影响内部绘制
- `size`: 元素尺寸不依赖内容 (只看自身 width/height), 打破"内容决定尺寸"的循环依赖
- `style`: 计数器等样式影响不逸出子树
- 组合值: `strict` (= layout paint size style)、`content` (= layout paint style)

`content-visibility` 的三个值:

- `visible`: 默认, 正常渲染
- `hidden`: 跳过内容渲染且不保留可访问性状态, 比 `display: none` 快 (保留渲染状态, 恢复时无需重建)
- `auto`: 最重要 — 视口外的内容跳过渲染, 滚到附近才开始渲染, 浏览器自动管理

```css
.card-list > li {
  content-visibility: auto;
  contain-intrinsic-size: auto 200px; /* 未渲染时的占位高度, 防滚动条跳动 */
}
```

`contain-intrinsic-size` 提供预估尺寸, 避免未渲染内容高度为 0 导致滚动条位置漂移.

适用场景与定位: 超长列表/长页面 (信息流、文档站) 的低成本优化, 实测可显著降低首屏渲染时间; 与虚拟列表互补 — 虚拟列表解决 DOM 节点数, `content-visibility` 解决渲染成本, 简单场景甚至可替代虚拟列表. 注意点: `auto` 下浏览器查找 (Ctrl+F) 与锚点跳转对未渲染区域的行为有细节差异; 预估尺寸不准会有轻微滚动抖动.

### 38. CSS 中的 will-change 属性有什么作用?

A:

will-change 是 CSS 中用于提前告知浏览器元素将发生何种变化的属性, 让浏览器提前做好优化准备, 如创建合成层、分配 GPU 资源.

语法:

```css
.element {
  will-change: transform;
  will-change: opacity;
  will-change: transform, opacity;
  will-change: scroll-position;
  will-change: contents;
  will-change: auto;
}
```

工作原理:

- 浏览器在元素实际变化之前, 根据 will-change 的声明提前分配资源
- `will-change: transform` 会让浏览器将元素提升为独立的合成层
- 合成层的 transform 和 opacity 动画由 GPU 直接处理, 跳过 Layout 和 Paint
- 相当于给浏览器一个"预告", 让它有时间准备, 而非动画开始时才匆忙创建图层

正确使用:

```javascript
const element = document.querySelector(".animated");

element.addEventListener("mouseenter", () => {
  element.style.willChange = "transform";
});

element.addEventListener("animationend", () => {
  element.style.willChange = "auto";
});
```

```css
.modal-overlay {
  will-change: opacity;
}

.drawer {
  will-change: transform;
}
```

注意事项:

- 不要滥用: 每个 will-change 都会创建合成层, 占用 GPU 内存. 页面合成层过多会导致内存暴涨, 反而降低性能
- 不要提前太久: 在动画即将开始时添加, 而非页面加载时就设置
- 及时清理: 动画结束后移除, 释放资源
- 不要用于大量元素: 列表中的每个 item 都设置 will-change 是反模式
- 不要作为性能银弹: will-change 只优化 transform 和 opacity 动画, 对 width、height 等触发布局的属性无效

与 `transform: translateZ(0)` 的对比:

- 两者都能触发合成层提升
- will-change 是标准推荐方式, 语义更明确
- translateZ(0) 是 hack 手段, 会实际改变元素的 3D 变换
- will-change 可以声明更多变化类型 (scroll-position、contents 等)

### 39. CSS 中的 transform 和 position 有什么区别?

A:

transform 和 position 都可以改变元素的视觉位置, 但工作原理、性能影响和使用场景完全不同.

核心区别:

| 维度       | transform                | position                                                    |
| ---------- | ------------------------ | ----------------------------------------------------------- |
| 影响布局   | 不影响, 元素仍占据原位置 | 影响 (absolute/fixed 脱离文档流)                            |
| 渲染阶段   | 合成阶段 (Composite)     | 布局阶段 (Layout)                                           |
| 性能       | 高, 可 GPU 加速          | 低, 触发回流                                                |
| 百分比参照 | 元素自身尺寸             | 包含块尺寸                                                  |
| 层叠上下文 | 非 none 值即创建         | fixed/sticky 总是创建; absolute/relative 需 z-index 非 auto |

详细对比:

```css
/* transform: translate */
.element {
  transform: translate(100px, 50px);
}

/* position: relative */
.element {
  position: relative;
  top: 50px;
  left: 100px;
}

/* position: absolute */
.element {
  position: absolute;
  top: 50px;
  left: 100px;
}
```

性能差异:

```javascript
// 差: 每帧都触发回流
function animateWithPosition(element, x) {
  element.style.left = x + "px";
}

// 好: 只触发合成
function animateWithTransform(element, x) {
  element.style.transform = `translateX(${x}px)`;
}
```

使用场景:

使用 transform:

- 动画和过渡 (位移、缩放、旋转)
- 不影响其他元素位置的视觉偏移
- 需要 GPU 加速的高频更新
- 居中: `transform: translate(-50%, -50%)`

使用 position:

- 需要脱离文档流的定位 (弹窗、下拉菜单、固定导航)
- 需要影响其他元素布局的位置调整
- 粘性定位 (sticky)
- 层叠布局 (z-index 配合)

组合使用:

```css
.modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.dropdown {
  position: absolute;
  top: 100%;
  transform: translateY(8px);
  transition: transform 0.2s;
}
```

---

## 响应式与现代 CSS

### 40. 响应式布局有哪些方案? 媒体查询怎么用?

A:

媒体查询语法与机制:

```css
/* 移动优先: 基础样式面向小屏, 逐级增强 */
@media (min-width: 768px) and (max-width: 1023px) { ... }
@media (orientation: landscape), (min-width: 1200px) { ... } /* 逗号是"或" */

/* 常用媒体特性 */
@media (hover: none) and (pointer: coarse) { ... } /* 触屏设备 */
@media (prefers-reduced-motion: reduce) { ... }    /* 用户减弱动效偏好 */
@media (prefers-color-scheme: dark) { ... }        /* 暗色模式 */
@media (min-resolution: 2dppx) { ... }             /* 高分屏 */
@media (scripting: none) { ... }                   /* JS 被禁用 */
```

断点策略: 移动优先 (min-width 递增) 是主流, 样式天然渐进增强、代码量小; 桌面优先 (max-width 递减) 适合存量 PC 站改造.

完整响应式方案矩阵:

1. 流式布局: 宽度用 `%` / `fr` / `auto`, 内容随容器伸缩
2. flex/grid 自适应: `flex-wrap`、grid 的 `repeat(auto-fit, minmax(200px, 1fr))` 不写媒体查询就能自适应列数
3. 媒体查询断点: 处理布局结构级变化 (侧栏隐藏、栅格列数、字号阶梯)
4. rem / vw 缩放体系: rem + JS 计算根字号, 或纯 vw (postcss-px-to-viewport), 让一切尺寸随屏宽线性缩放
5. 响应式图片: `srcset` + `sizes` 按 DPR/视口选图, `<picture>` 做艺术方向裁剪与 WebP/AVIF 格式协商, `loading="lazy"`
6. 容器查询: 组件级响应式 (见第 41 题)
7. 排版自适应: `clamp(min, preferred, max)` 一行实现流式字号, 如 `font-size: clamp(14px, 1vw + 12px, 20px)`

理念要点: 现代响应式的趋势是"能不用媒体查询就不用", 优先用内在尺寸 (intrinsic sizing)、flex/grid 自适应性、`clamp()`, 把断点留给真正的结构变化.

### 41. 什么是容器查询 (container query)? 与媒体查询有什么区别?

A:

媒体查询依据视口尺寸变化样式, 容器查询依据组件自身容器的尺寸变化样式. 响应式组件库的核心痛点 — 同一个卡片组件, 放在侧栏和放在主区应有不同布局, 但视口宽度相同, 媒体查询无能为力, 容器查询正是为此而生.

用法两步走:

```css
/* 1. 声明查询容器: inline-size 表示只关心 inline 方向 (通常是宽度) */
.sidebar,
.main {
  container-type: inline-size;
  container-name: cardhost; /* 可选, 命名容器 */
}

/* 2. 在容器后代上使用 @container */
@container cardhost (min-width: 400px) {
  .card {
    display: flex;
  } /* 卡片在宽容器里变横向布局 */
}
@container (min-width: 700px) {
  /* 不指定名字则匹配最近的祖先容器 */
  .card {
    font-size: 18px;
  }
}
```

配套容器查询单位: `cqw` (容器宽 1%)、`cqh`、`cqmin`、`cqmax`, 可让字号、圆角直接随容器缩放: `font-size: 5cqw`.

与媒体查询对比:

- 参照物: 容器 vs 视口
- 关注点: 组件自适应性 vs 页面整体布局
- 容器查询需要显式声明 `container-type`, 且 `inline-size` 会对容器施加布局、样式包含与行内尺寸包含 (inline-size containment, 完整的 size containment 由 `container-type: size` 提供) — 容器的行内尺寸不再由内容撑开, 使用时要确保容器有确定宽度来源 (浮动、inline-block、绝对定位等收缩场景下会塌成 0)
- 不能查询自身, 只能影响容器的后代元素
- 浏览器支持: 2023 年起主流浏览器已全部支持, 可用于生产

### 42. :has() 选择器有什么用?

A:

`:has()` 是关系型伪类, 俗称"父选择器": 当元素的后代 (或后续兄弟) 满足参数选择器时, 选中该元素本身. 它打通了 CSS 长久以来"只能向下、向右选, 不能向上选"的限制.

```css
/* 表单校验: 内含非法输入时整个 form-group 标红 */
.form-group:has(input:invalid) { border-color: red; }

/* 卡片含图片时改布局 */
.card:has(img) { grid-template-columns: 120px 1fr; }

/* 选中"后面跟着 h2 的 h1"之类的兄弟关系 */
h1:has(+ h2) { margin-bottom: 0; }

/* 组合: 没有有效输入时禁用提交按钮的视觉样式 */
form:has(input:invalid) button[type="submit"] { opacity: .5; pointer-events: none; }

/* 计数场景: 列表超过 5 项时给容器加分页样式 */
ul:has(li:nth-child(6)) { ... }
```

典型价值:

- 大量原本需要 JS 加 class 的场景 (校验状态、空状态、内容变体) 变为纯 CSS
- 与 `:focus-within` 的区分: `:focus-within` 只管焦点, `:has()` 参数可以是任意选择器

注意事项:

- `:has()` 内不允许嵌套伪元素; 早期规范禁止 `:has()` 内再嵌套 `:has()` (避免循环与指数级匹配成本), 该限制现已放开, Chrome 126+ 等现代浏览器已支持嵌套 `:has()`
- 性能: 浏览器为 `:has()` 做了缓存与快照优化, 常规使用无碍, 但在超大 DOM 上写 `:has(*)` 这类宽泛参数仍应避免
- 浏览器支持: 2023 年底起全主流支持, 可用 `@supports selector(:has(a))` 做特性检测与降级

### 43. 如何用 prefers-color-scheme 实现暗色模式?

A:

系统级跟随:

```css
:root {
  --bg: #ffffff;
  --text: #1f2329;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141414;
    --text: #e8e8e8;
  }
}
body {
  background: var(--bg);
  color: var(--text);
}
```

现代语法还有 `light-dark()` 函数, 一行写两个值:

```css
body {
  color-scheme: light dark;
  background: light-dark(#fff, #141414);
  color: light-dark(#1f2329, #e8e8e8);
}
```

关键细节:

- `color-scheme` 属性必须设置, 它告诉浏览器本页面支持哪些配色方案, 浏览器据此把 UA 默认控件 (表单、滚动条、表单自动填充底色) 切换为对应风格; 不设置则暗色下输入框等仍是亮色, 体验割裂
- 图片适配: `<picture>` 的 `<source media="(prefers-color-scheme: dark)">` 可以换暗色版图片; 普通图片可用 `filter: brightness(.9)` 微调
- 阴影在暗色下几乎不可见, 应改用更亮的描边或发光

手动切换 + 系统跟随的完整方案 (常见工程问题):

```css
:root,
[data-theme="light"] {
  --bg: #fff;
  --text: #1f2329;
}
[data-theme="dark"] {
  --bg: #141414;
  --text: #e8e8e8;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141414;
    --text: #e8e8e8;
  }
}
```

```js
// 优先级: localStorage 用户选择 > 系统偏好
const saved = localStorage.getItem("theme");
if (saved) document.documentElement.dataset.theme = saved;
// 切换按钮: 设置/移除 data-theme 并写 localStorage
// 监听系统变化: matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)
```

防闪烁: 主题判定脚本要内联在 `<head>` 最前同步执行, 否则暗色用户会看到一帧亮色 (FOUC 主题版).

### 44. CSS 中的 calc()、min()、max()、clamp() 函数如何使用?

A:

这四个数学函数提供了在 CSS 中进行动态计算的能力, 减少了对 JavaScript 和媒体查询的依赖.

calc() (计算):

```css
.element {
  width: calc(100% - 40px);
  height: calc(100vh - 60px);
  font-size: calc(16px + 1vw);
  margin: calc(var(--spacing) * 2);
  padding: calc(10px + 2em);
}

/* + 和 - 前后必须有空格 */
width: calc(100% - 40px); /* 正确 */
width: calc(100%-40px); /* 错误 */

/* 可以嵌套 */
width: calc(calc(100% - 20px) / 2);

/* 可以与变量配合 */
width: calc(var(--base-width) + var(--extra-width));
```

min() (取最小值):

```css
.element {
  width: min(90%, 500px);
  font-size: min(4vw, 24px);
}
```

max() (取最大值):

```css
.element {
  width: max(300px, 30vw);
  font-size: max(16px, 1.2vw);
  padding: max(12px, 1vh);
}
```

clamp() (范围约束):

```css
/* clamp(min, preferred, max) */
h1 {
  font-size: clamp(16px, 2.5vw, 24px);
}

.container {
  width: clamp(320px, 90%, 1200px);
}

.section {
  padding: clamp(16px, 5vw, 64px);
}

/* clamp 等价于 max(min, min(preferred, max)) */
font-size: clamp(16px, 2.5vw, 24px);
/* 等价于 */
font-size: max(16px, min(2.5vw, 24px));
```

实际应用场景:

```css
:root {
  --space-sm: clamp(8px, 1vw, 12px);
  --space-md: clamp(16px, 2vw, 24px);
  --space-lg: clamp(24px, 4vw, 48px);
  --space-xl: clamp(32px, 6vw, 80px);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: var(--space-md);
}

.content {
  width: min(90%, 1200px);
  margin-inline: auto;
}

.hero {
  min-height: calc(100vh - var(--header-height, 60px));
}
```

浏览器兼容性:

- calc(): IE9+, 所有现代浏览器
- min() / max(): IE 不支持, 现代浏览器均支持
- clamp(): IE 不支持, Chrome 79+, Firefox 75+, Safari 13.1+

### 45. 什么是 CSS 的 @supports 规则?

A:

@supports 是 CSS 的特性查询规则, 用于检测浏览器是否支持某个 CSS 属性或值, 根据支持情况应用不同样式. 它是渐进增强的核心工具.

基本语法:

```css
@supports (property: value) {
  /* 浏览器支持时应用的样式 */
}

@supports not (property: value) {
  /* 浏览器不支持时应用的样式 */
}
```

使用示例:

```css
@supports (display: grid) {
  .container {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
  }
}

@supports not (display: grid) {
  .container {
    display: flex;
    flex-wrap: wrap;
  }
  .item {
    width: 33.333%;
  }
}

@supports (backdrop-filter: blur(10px)) {
  .glass {
    backdrop-filter: blur(10px);
    background: rgba(255, 255, 255, 0.7);
  }
}

@supports not (backdrop-filter: blur(10px)) {
  .glass {
    background: rgba(255, 255, 255, 0.95);
  }
}
```

逻辑运算符:

```css
@supports (display: grid) and (gap: 10px) {
  .container {
    display: grid;
    gap: 10px;
  }
}

@supports (backdrop-filter: blur(10px)) or (-webkit-backdrop-filter: blur(10px)) {
  .glass {
    backdrop-filter: blur(10px);
  }
}

@supports not (display: grid) {
  /* 回退样式 */
}
```

JavaScript API:

```javascript
if (CSS.supports("display", "grid")) {
  // 支持 grid
}

if (CSS.supports("backdrop-filter: blur(10px)")) {
  // 支持 backdrop-filter
}

if (CSS.supports("(display: grid) and (gap: 10px)")) {
  // 同时支持
}
```

与 Modernizr 的对比:

- @supports 是浏览器原生 API, 无需引入第三方库
- Modernizr 通过 JavaScript 检测, 可以检测更多特性 (包括 HTML5 特性)
- @supports 能检测 CSS 特性 (属性值对、`selector()`、`font-tech()` 等), 无法检测 JavaScript API
- 现代项目中, @supports 已能覆盖大部分 CSS 特性检测需求

### 46. 什么是 CSS 的 scroll-snap?

A:

CSS Scroll Snap 是一种控制滚动容器停止位置的机制, 使滚动在释放后自动吸附到预定义的锚点位置. 常用于轮播图、全屏滚动、图片画廊等场景.

核心概念:

- Scroll Snap Container: 设置 scroll-snap-type 的滚动容器
- Scroll Snap Area: 子元素上设置 scroll-snap-align 定义的吸附区域
- Snap Position: 滚动停止时, 容器的 snap port 与子元素的 snap area 对齐的位置

容器属性:

```css
.carousel {
  scroll-snap-type: x mandatory;
  /* x | y | both: 吸附方向 */
  /* mandatory | proximity: 吸附强度 */
  /* mandatory: 滚动结束必须吸附到最近锚点 */
  /* proximity: 接近锚点时才吸附, 否则自由滚动 */

  overflow-x: scroll;
  display: flex;
}

.fullpage-scroll {
  scroll-snap-type: y mandatory;
  overflow-y: scroll;
  height: 100vh;
}
```

子元素属性:

```css
.slide {
  scroll-snap-align: center;
  /* start | end | center | none */
  /* 定义子元素的哪个位置与容器对齐 */

  scroll-snap-stop: always;
  /* normal | always */
  /* always: 快速滚动时也不能跳过此元素 */

  flex: 0 0 100%;
}
```

完整轮播示例:

```css
.carousel {
  display: flex;
  overflow-x: scroll;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
}

.carousel > * {
  flex: 0 0 100%;
  scroll-snap-align: center;
  scroll-snap-stop: always;
}

/* 可选: 隐藏滚动条 */
.carousel::-webkit-scrollbar {
  display: none;
}
.carousel {
  scrollbar-width: none;
}
```

全屏滚动示例:

```css
html {
  scroll-snap-type: y proximity;
}

section {
  min-height: 100vh;
  scroll-snap-align: start;
}
```

配合 JavaScript:

```javascript
const container = document.querySelector(".carousel");

// 监听吸附位置变化
container.addEventListener("scrollsnapchange", (e) => {
  console.log("吸附到:", e.snapTargetInline);
});

// 编程式滚动到特定位置
container.scrollTo({ left: 0, behavior: "smooth" });
```

与第三方轮播库的对比:

- scroll-snap 是原生 CSS, 无需 JavaScript, 性能更好
- 支持触摸滑动、惯性滚动、键盘导航
- 但缺乏自动播放、指示器、无限循环等高级功能
- 简单轮播和全屏滚动优先使用 scroll-snap, 复杂需求使用库

---

## 动画与交互

### 47. CSS 动画和 JS 动画 (requestAnimationFrame) 有什么区别?

A:

CSS 动画 (transition / @keyframes animation):

- 声明式: 描述起点终点, 插值交给浏览器
- 性能上限高: `transform`/`opacity` 的 CSS 动画可整体移交合成器线程执行, 主线程即使被 JS 占满, 动画依旧流畅, 且浏览器能合并、降帧省电
- 表达力受限: 难以实现物理效果 (弹簧、拖拽惯性)、中途逻辑分支、与数据流同步的逐帧控制

JS 动画:

- `requestAnimationFrame` (rAF): 浏览器在每次重绘前回调, 与屏幕刷新率对齐 (通常 60Hz, 高刷屏 120Hz), 页面隐藏时自动暂停, 省电且不掉帧对齐
- `setTimeout`/`setInterval` 做动画的问题: 定时器不感知渲染帧, 间隔漂移导致掉帧与抖动, 页面隐藏时照样空转
- 表达力最强: 每帧都是代码, 可实现滚动联动、手势跟随、物理引擎、canvas 逐帧绘制
- 代价: 跑在主线程, 每帧代码超过帧预算 (60fps 约 16.7ms, 120fps 约 8ms) 就掉帧

Web Animations API (`element.animate()`) 是两者优势的合体: 用 JS 创建动画对象 (可暂停、反向、调速、组合), 但插值与渲染仍走浏览器动画管线, 可进合成线程:

```js
el.animate(
  [{ transform: "translateX(0)" }, { transform: "translateX(200px)" }],
  {
    duration: 300,
    easing: "ease-out",
    fill: "forwards",
  },
);
```

选择建议: 状态过渡/hover/loading 等用 CSS; 需要交互驱动 (拖拽、滚动进度)、复杂时序编排用 rAF 或 WAAPI; 库层面 GSAP 等底层也是 rAF + WAAPI 思路.

### 48. transition 和 animation 有什么区别?

A:

- 触发方式: `transition` 是被动的, 需要属性值变化 (hover、class 切换、JS 改样式) 才发生, 从 A 到 B 走一遍; `animation` 是主动的, 绑定即按 `@keyframes` 自动运行
- 关键帧: `transition` 只有起点和终点; `animation` 支持任意多个关键帧 (`0% {} 50% {} 100% {}`), 可描述复杂过程
- 循环与方向: `animation` 支持 `iteration-count: infinite`、`direction: alternate`、`play-state`; `transition` 一次性的, 想循环只能 JS 切换
- 填充模式: `animation-fill-mode: forwards/backwards/both` 控制动画前后元素定格在哪一帧, 是常见要点 (不加 forwards 动画结束会跳回初始状态)
- 步进: `animation-timing-function: steps(n)` 可做逐帧动画 (雪碧图帧动画、打字机效果)

```css
@keyframes sprite {
  from {
    background-position: 0 0;
  }
  to {
    background-position: -1600px 0;
  }
}
.runner {
  animation: sprite 1s steps(16) infinite;
}
```

两个高频"失效"问题:

1. transition 对 `display: none ↔ block` 无效: 因为元素进出渲染树没有可插值的中间状态. 现代解法: `transition-behavior: allow-discrete` + `@starting-style` 定义入场前样式, 或改用 opacity/visibility
2. `height: auto` 无法过渡: auto 不是可插值数值. 方案: JS 测 scrollHeight 赋值、grid 的 `grid-template-rows: 0fr → 1fr` 技巧、或新特性 `interpolate-size: allow-keywords` / `calc-size()`

### 49. 为什么 transform 动画比修改 top/left 更流畅?

A:

根本原因在于两者走的渲染管线阶段不同.

修改 `top`/`left` (或 `width`/`margin`):

- 改变几何信息 → 触发 Layout (重排) → 重新 Paint (重绘) → Composite
- 每一帧动画都走完整管线, 且跑在 JS/排版所在的主线程; 主线程一旦被长任务占用, 动画帧就被挤掉, 出现卡顿
- 重排还可能传染: 元素位置变化引起兄弟、父级连锁重算

修改 `transform` (以及 `opacity`):

- 若元素已被提升为合成层, 变化由合成器线程 (compositor thread) 直接对 GPU 纹理做矩阵变换/透明度混合, 完全跳过 Layout 和 Paint
- 合成器线程独立于主线程, 主线程 JS 繁忙时动画依然 60fps
- 即使未提升合成层, transform 也不会引发重排 (它只影响视觉呈现, 不影响布局), 开销依然远小于 top/left

```
top/left 动画: JS → Style → Layout → Paint → Composite   (每帧全套, 主线程)
transform 动画: JS → Style → Composite                     (每帧合成, 合成线程)
```

实践要点: 动画属性白名单就是 `transform` 和 `opacity` (filter 视情况); 用 `will-change: transform` 提前提升合成层; 位移用 `translate`、缩放用 `scale`、旋转用 `rotate` 等效替代布局属性; 同时警惕层爆炸带来的内存问题 (见第 34 题). 这与 FLIP 动画技术 (First Last Invert Play, 用 transform 模拟布局变化) 的思想一致: 把昂贵的 layout 动画换算成便宜的 transform 动画.

---

## 跨端与框架中的 CSS

### 50. React Native 中的 CSS 和 Web 中的 CSS 有什么不同? Yoga 引擎是什么?

A:

React Native 没有浏览器、没有 DOM、没有 CSSOM. 所谓"RN 里的 CSS"只是借用了 CSS 属性命名与 Flexbox 语义的 JS 对象, 最终由原生视图渲染. 差异清单:

1. 写法与生效方式: 样式是 JS 对象 (`StyleSheet.create({...})`, 属性驼峰命名如 `backgroundColor`), 通过 props 传递, 没有样式表文件、没有选择器、没有层叠 (cascade)
2. 继承极弱: Web 中大量属性可继承; RN 中只有 `Text` 组件嵌套 `Text` 时继承部分文字属性, `View` 完全不继承文字样式, 所有文本必须包在 `<Text>` 中
3. 单位: 数值无单位, 是逻辑像素 (dp/pt), 由系统按 DPR 换算物理像素; `PixelRatio.get()` 可查; 不支持 `em`/`rem`/`vw`, 百分比仅部分属性支持
4. 默认布局不同: 全部是 Flexbox, 且默认 `flexDirection: 'column'` (Web 默认 `row`); 无 `float`、无 `display: grid/inline/table`、`position` 只有 `relative`/`absolute` (新版逐步加入 `static` 语义), 没有 `sticky`
5. 样式属性子集与差异: 无伪类 (`:hover` 用 Pressable 状态回调)、无伪元素、无媒体查询 (用 `useWindowDimensions`/`Platform.select`), `boxShadow` 旧版分平台 (iOS `shadow*` 四件套 / Android `elevation`), `zIndex` 只在兄弟间有效且 Android 早期有绘制顺序问题, `transform` 是数组语法 (`[{ rotate: '45deg' }]`)
6. 盒模型细节: 默认 border-box 行为 (width 含 padding/border), 更符合直觉; margin 不合并
7. 伪响应式: 断点、主题都要在 JS 层做, 社区方案 (Restyle、Unistyles、NativeWind) 把 Tailwind 式类名编译为 RN style 对象

Yoga 引擎:

- Yoga 是 Meta 开源的 C++ 跨平台布局引擎, 实现了一套与 W3C Flexbox 高度一致的布局算法, 并扩展了 `aspectRatio`、各平台一致的 `position: absolute` 等行为
- 工作流程: JS 侧的 style 对象通过 bridge/JSI 同步到原生层的 Yoga 节点树 (每个组件对应一个 Yoga Node) → Yoga 执行 `calculateLayout`, 输入约束 (可用空间) 自顶向下递归计算每个节点的 frame (x, y, width, height) → 结果回写原生视图进行布局与绘制
- 价值: 一份 flexbox 布局代码在 iOS/Android 上像素级一致, 屏蔽了两套原生布局体系 (AutoLayout / Android View 体系) 的差异
- 与 Web 渲染的本质区别: 没有 HTML 解析、没有 CSSOM 层叠、没有 reflow/repaint/合成层的浏览器管线概念; 布局计算是 Yoga 一次性完成并直接落到原生视图, 渲染性能瓶颈更多在 JS↔原生通信与视图层级深度, 而不是浏览器的重排
- RN 新架构 (Fabric + JSI) 让布局可以同步执行, Yoga 与 C++ 渲染管线结合更紧密, 解决了旧桥接异步导致的测量时序问题

总结: RN 的 CSS 是"长得像 CSS 的布局 DSL", Web CSS 是"声明式样式表 + 层叠 + 完整排版引擎"; Yoga 是把这套 DSL 翻译成原生视图 frame 的跨端 Flexbox 计算引擎.

### 51. React/Vue 中有哪些 CSS 方案? 如何选择?

A:

方案全景:

1. 全局 CSS + 命名约定 (BEM/SMACSS): 零工具成本, 靠纪律防冲突; 适合小项目或配合组件库主题
2. CSS Modules: 类名 hash 化局部作用域 (见第 23 题), 零运行时, React/Vue/Svelte 全通用, 是中大型项目的稳妥默认项
3. Vue SFC scoped style: 编译期属性选择器隔离 (见第 52 题), Vue 项目首选
4. css-in-js 运行时流派 (styled-components、emotion): 动态样式与组件共生, 但有运行时性能成本与 React Server Components 不兼容的问题, 新项目谨慎 (见第 23 题)
5. css-in-js 编译时流派 (vanilla-extract、Linaria、Panda CSS): 保留"样式即代码"体验, 产物是静态 CSS, 兼顾性能
6. 原子化框架 (Tailwind CSS、UnoCSS): 工具类拼装, 设计约束内置, 与组件化框架契合度高, 产物体积小
7. 组件库 + 设计 token (CSS 变量主题): 中后台项目的现实主流

选择维度 (回答时给出决策框架比罗列更重要):

- 性能与 SSR/RSC: 静态方案 (Modules/Tailwind/vanilla-extract) 优先, 运行时 css-in-js 在 App Router/RSC 场景基本出局
- 动态性需求: 大量运行时主题/数据驱动样式 → CSS 变量 + 任意静态方案, 而非运行时 css-in-js
- 团队协作与约束: Tailwind 用预设 scale 统一设计决策, BEM/全局 CSS 最依赖人肉规范
- 框架生态: Vue 用 scoped 或 CSS Modules; React 无内置方案, 社区主流是 Tailwind 或 CSS Modules
- 包体积与缓存: 静态 CSS 可长缓存、可并行加载, 运行时方案样式随 JS 走

### 52. Vue 的 scoped CSS 是如何实现样式隔离的?

A:

Vue 单文件组件 `<style scoped>` 的隔离是编译期转换, 分两步:

1. 模板编译: 给组件模板内每个元素添加一个唯一的数据属性, 如 `data-v-7ba5bd90` (hash 来自组件文件内容/路径)
2. 样式编译: 用 PostCSS 重写每条选择器, 在选择器末尾追加属性选择器, 如 `.title { }` → `.title[data-v-7ba5bd90] { }`

于是样式只能命中带该 hash 属性的元素, 实现组件级隔离.

关键细节与延伸:

- 子组件的根节点同时带有父组件的 data-v 属性 (有意设计), 所以父组件的 scoped 样式可以影响子组件的根节点, 便于布局调整
- 深度选择器: 需要影响子组件内部时, 用 `:deep(.child-class)` (旧写法 `::v-deep`、`/deep/`、`>>>` 已废弃/不推荐), 编译后等价于 `[data-v-xxx] .child-class`, 让属性选择器"停"在父级边界
- `:slotted()` 给 `<slot>` 传入的内容设置样式 (插槽内容编译在父组件作用域)
- `:global()` 声明全局规则
- 混用: scoped 与全局 `<style>` 块可以并存; 同一个 SFC 还可以用 `<style module>` 走 CSS Modules
- 与 CSS Modules 的对比: scoped 是属性选择器后缀 (权重 +1, 仍是全局类名, 理论上存在跨组件类名+属性巧合冲突的极小概率), CSS Modules 是直接改写类名为唯一 hash, 隔离更彻底; scoped 写法零心智负担, Modules 需要 `styles.xxx` 引用
- 动态样式: Vue 支持 `v-bind()` 在 CSS 中绑定组件状态, 编译为 CSS 自定义属性, 实现"scoped + 动态"的组合

---

## 现代 CSS 新特性进阶

### 53. CSS 原生嵌套 (CSS Nesting) 与预处理器嵌套有什么区别?

A:

CSS 原生嵌套 (CSS Nesting Module) 已在 2023 年被主流浏览器全部支持, 允许不经编译直接在浏览器里写嵌套规则:

```css
.card {
  padding: 16px;

  &:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .title {
    font-size: 18px;
  }

  @media (min-width: 768px) {
    padding: 24px; /* 媒体查询也可以嵌套在规则内部 */
  }
}
```

与 SCSS 嵌套的关键区别:

- 运行时机: 原生嵌套由浏览器解析, 零构建; SCSS 嵌套在编译期展开为平铺选择器
- `&` 语义: 现行规范中 `&` 直接代表父选择器 (早期草案曾规定嵌套选择器隐式包裹 `:is(父选择器)`, 特异性取父选择器列表中最高者; Chrome 120+ 已按新语义实现) ——父选择器是 `.a, #b` 时, 含 `&` 的分支按两个父选择器各自展开、各自计算特异性, 与 SCSS 文本替换的展开结果一致
- 字符串拼接: SCSS 支持 `&-title` 拼接类名 (BEM 常用), 原生嵌套不支持——`&` 是选择器引用不是字符串, 这是迁移时最大的不兼容点
- 早期语法不允许嵌套选择器直接以元素选择器开头 (需写作 `& div`; 类名/ID 等符号开头的选择器则可省略 `&`), 现行规范已放开, 可直接写元素选择器嵌套

工程建议: 新项目可用原生嵌套逐步替代 SCSS 的嵌套需求; 涉及 BEM 拼接、循环与 mixin 的场景仍需预处理器或 PostCSS 插件降级 (postcss-nesting).

### 54. @property 是什么? CSS Houdini 了解多少?

A:

@property 是 CSS Houdini "Properties & Values API" 的声明式语法, 用于给 CSS 自定义属性注册类型、初始值与继承行为:

```css
@property --progress {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 0%;
}

.bar {
  background: linear-gradient(to right, #1677ff var(--progress), #eee 0);
  transition: --progress 0.3s ease;
}
.bar.done {
  --progress: 100%;
}
```

解决的核心问题: 未注册的自定义属性对浏览器只是无类型的 token 串, 无法插值, 因此不能参与 transition/animation; 注册类型后浏览器知道"这是一个百分比", 就能对它做平滑过渡. 典型应用: 渐变动画 (渐变本身不可过渡, 但驱动渐变的变量可以)、圆环进度条、数字滚动 (配合 counter).

CSS Houdini 是一组开放浏览器渲染引擎底层能力的 API 集合:

- Properties & Values API: 即 @property (JS 侧对应 CSS.registerProperty), 落地最好
- Paint API (CSS.paintWorklet): 用 JS 在 Worklet 中自定义绘制背景/边框, 如 `background: paint(my-ripple)`, Chromium 系支持
- Typed OM: `el.attributeStyleMap.set('width', CSS.px(100))`, 用类型化对象替代字符串读写样式, 减少解析开销
- Layout API / Animation Worklet: 自定义布局算法与脱离主线程的动画, 仍处于实验阶段

要点: Houdini 的价值是"把过去只能靠 JS 模拟或等浏览器实现的能力, 下放为可编程的渲染管线钩子"; 目前生产可用的主要是 @property 与 Typed OM, Paint API 需要按浏览器支持渐进增强.

### 55. View Transitions 与滚动驱动动画是什么?

A:

View Transitions API (视图过渡):

- 解决的问题: DOM 状态切换 (列表排序、页面路由跳转) 是瞬间完成的, 过去做"元素从旧位置平滑飞到新位置"需要 FLIP 手法手工测量. View Transitions 让浏览器自动截图旧状态、更新 DOM、再在新旧快照之间做过渡
- 同文档用法: `document.startViewTransition(() => updateDOM())`; 浏览器生成 `::view-transition-old()` 与 `::view-transition-new()` 伪元素树, 默认做交叉淡入, 可用 CSS 完全自定义
- 共享元素过渡: 给新旧两个元素设置相同的 `view-transition-name`, 浏览器自动补间其位置与尺寸, 实现"缩略图放大为详情图"的原生转场
- 跨文档 (MPA) 过渡: CSS 声明 `@view-transition { navigation: auto; }` 即可让传统多页应用获得 SPA 般的转场; SPA 路由框架 (React Router、Vue Router、Next.js) 已内置集成
- 注意: 过渡期间页面不可交互 (快照是位图); 需要 `@media (prefers-reduced-motion: reduce)` 降级

滚动驱动动画 (Scroll-driven Animations):

- 让 CSS animation 的进度由滚动位置而非时间驱动, 替代 scroll 事件监听 + JS 计算的方案, 且动画运行在合成器线程不阻塞主线程
- `animation-timeline: scroll()`: 进度绑定滚动容器的滚动进度, 典型应用是阅读进度条:

```css
@keyframes grow {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
.progress {
  transform-origin: 0 50%;
  animation: grow auto linear;
  animation-timeline: scroll(root);
}
```

- `animation-timeline: view()`: 进度绑定元素自身在视口中的可见进度, 配合 `animation-range: entry 0% cover 40%` 控制起止区间, 实现元素入场淡入、视差效果, 可替代一部分 IntersectionObserver 用例
- 兼容性: Chromium 115+ 与 Safari 26+ 已支持, Firefox 仍在跟进中, 需 `@supports (animation-timeline: scroll())` 检测并以无动画作为降级

---

## 附: 回答建议

- 先给结论与分类, 再展开机制, 最后给工程实践或权衡, 三段式回答最清晰
- 布局类题目主动说多种方案并给出取舍 (兼容场景 vs 现代方案)
- 原理类题目往渲染管线 (DOM → CSSOM → Render Tree → Layout → Paint → Composite) 上靠, 重排重绘、阻塞、动画性能是同一套底层逻辑的不同切面
- 工程化题目强调"构建期 vs 运行时"这条主线, CSS Modules、Tailwind、PostCSS、编译时 css-in-js 都是构建期方案, 运行时 css-in-js 的所有缺点都源于把样式工作推迟到了浏览器运行时
