---
title: "CSS 规范与现代能力"
description: "从选择器与层叠、盒模型与格式化上下文, 到 Flex/Grid 布局、响应式与容器查询、自定义属性、动画与渲染性能、样式工程化与现代 CSS 特性的系统梳理"
---

这份文档按"机制而非技巧"的方式梳理 CSS: 先讲选择器与层叠这类决定"哪条声明最终生效"的规则, 再讲盒模型、格式化上下文与定位这类决定"元素如何排布"的规则, 然后覆盖 Flex/Grid、响应式、自定义属性、动画与渲染性能, 最后落到样式工程化与现代特性。它的目标是让你在遇到样式不生效、布局错乱、动画掉帧时, 能定位到具体是哪一层规则在起作用, 而不是靠试错堆叠 `!important`。适合需要系统梳理 CSS 的中高级前端工程师, 也适合想弄清浏览器排版与绘制行为的全栈工程师阅读。文中结论以 CSS 规范与主流浏览器实现为准, 涉及引擎覆盖差异或实验特性时会显式标注。

## 选择器与层叠

### 选择器家族与匹配方向

CSS 选择器可分为几类: 类型选择器 (`div`)、类选择器 (`.btn`)、ID 选择器 (`#app`)、属性选择器 (`[type="text"]`)、伪类 (`:hover`)、伪元素 (`::before`)、通配符 (`*`) 以及后代、子代、相邻兄弟、通用兄弟四种组合器。伪类选中真实存在的元素在特定状态或位置下的情形, 伪元素选中或创建 DOM 树中并不真实存在的部分; 规范用双冒号区分伪元素, 但 `::before`/`::after` 等历史写法单冒号仍被兼容, 新代码应统一双冒号。伪元素不在 DOM 树中, JS 无法直接获取或绑定事件, 只能通过 `getComputedStyle(el, "::before")` 读取其计算样式; 一个选择器只能有一个伪元素且必须位于末尾, 伪类可以叠加。

关系型与逻辑型伪类是现代 CSS 表达力的关键:

| 选择器         | 语义                                                 | 特异性               |
| -------------- | ---------------------------------------------------- | -------------------- |
| `:is(a, b)`    | 匹配参数列表中任一选择器                             | 取参数中特异性最高者 |
| `:where(a, b)` | 同 `:is()`, 但强制零特异性                           | 恒为 0               |
| `:not(a, b)`   | 排除参数列表中的任一选择器                           | 取参数中特异性最高者 |
| `:has(rel)`    | 后代或后续兄弟满足参数时选中自身, 即关系型"父选择器" | 取参数中特异性最高者 |

`:is()` 与 `:where()` 的容错语义也和传统选择器列表不同: 传统列表中有一个无效选择器会导致整条规则被丢弃, 而 `:is()`/`:where()` 会忽略无效参数、保留有效部分, 因此可以安全地写"新特性加降级写法"的组合。

`:has()` 打通了 CSS 长期只能向下、向右选择的限制, 典型场景包括表单校验时按输入状态给外层容器加样式、卡片含图片与否切换布局、用 `h1:has(+ h2)` 描述相邻兄弟关系, 以及用 `ul:has(li:nth-child(6))` 做"超过若干项"的计数式样式。它的限制也很明确: 规范禁止在 `:has()` 内嵌套 `:has()`, 也不允许在参数中使用伪元素 (多数伪元素条件性存在, 查询会引入循环); 由于参数是容错选择器列表, 被禁止的部分会被静默丢弃而不是报错, 容易让人误以为已支持。性能上浏览器为 `:has()` 做了缓存与快照优化, 常规使用无碍, 但在超大 DOM 上写 `:has(*)` 这类宽泛参数仍应避免。

选择器的匹配方向是从右往左, 最右侧的选择器称为关键选择器。引擎为元素找样式时, 先用关键选择器筛出候选元素集合, 再沿每个候选元素向祖先方向验证左侧选择器; 这样绝大多数规则在第一步就被排除。反过来从左往右会退化为在子树中反复遍历, 回溯代价高得多。由此的编码推论是: 关键选择器越精确越好 (`.nav a` 优于 `.nav *`), 嵌套层级不必过深。不过现代引擎用索引结构与规则哈希对匹配做了高度优化, 真实项目中选择器性能极少成为瓶颈, 优先级远低于重排与 JS 开销。`父选择器`长期不存在正是因为匹配方向与反向查询冲突, `:has()` 的实现依赖引擎专门的前向检查优化。

### 优先级与层叠

一条声明最终是否生效由层叠规则决定, 顺序是: 先比来源与重要性, 再比选择器权重 (specificity), 最后比书写顺序。来源与重要性从高到低为:

1. 过渡 (transition) 进行中的声明。
2. 用户代理的 `!important` 声明。
3. 用户样式表的 `!important` 声明。
4. 作者样式的 `!important` 声明。
5. CSS 动画 (`@keyframes`) 运行期间的声明。
6. 作者普通声明。
7. 用户普通声明。
8. 用户代理 (浏览器默认样式表) 的普通声明。

注意 `!important` 反转了来源优先级: 用户代理的 `!important` 高于作者的 `!important`, 这是为可访问性兜底, 让用户能强制覆盖页面样式。另外, 过渡期间的声明优先级高于所有 `!important` 声明, 这正是过渡能平滑接管样式的原因。

同一来源、同一重要性下比较权重。规范把特异性定义为三元组 (ID 数, 类/属性/伪类数, 类型/伪元素数), 行内样式单独处理且高于任何选择器; 工程上常把它记成四元组按位比较。补充规则: 通配符与组合器不增加权重; `:is()`/`:not()`/`:has()` 计入参数中最高者; `:where()` 恒为零, 适合写成可被任意覆盖的基础样式; 权重相同则后书写者生效; 直接命中元素的声明永远高于继承来的值。

```css
/* 传统写法需要重复列举, :is() 合并后特异性仍取最高的类 */
:is(#app, .theme) .btn {
  color: red;
} /* 权重含 ID */
:where(#app, .theme) .btn {
  color: red;
} /* 权重只有类与类型 */
```

`@layer` (层叠层) 在权重之上再引入一层排序:

```css
@layer reset, base, components, utilities; /* 一条语句即可声明顺序 */
@layer utilities {
  .text-red {
    color: red;
  }
}
.title {
  color: blue;
} /* 未分层样式整体高于任何层内样式 */
```

规则是: 层与层之间按声明顺序, 后声明的层优先级高; 未归属任何层的样式整体高于所有层内样式; 同一层内仍按正常权重与书写顺序。`!important` 在层间再次反转, 先声明的层中的 `!important` 更高。因此想要"默认样式容易覆盖"时, 应把它放进最靠前的层; 想要"工具类永远能赢"时, 把它放进最后的层。嵌套层用 `@layer framework.theme` 的路径式命名, 匿名层则写成不带名字的 `@layer { ... }`, 无法被后续代码引用。

工程建议是避免 `!important` 与行内样式, 通过合理的类名组织 (BEM、CSS Modules) 或 `@layer`/`:where()` 控制权重冲突; 引入第三方库时用 `@import "lib.css" layer(vendor)` 把整库降到一个低优先级层, 这样业务样式无需提高权重即可覆盖它。

### 继承与全局关键字

继承指子元素未显式声明某属性时取父元素的计算值, 且继承来的值优先级最低 (任意一条命中该元素的声明都能覆盖它)。规律是: 与文字排版相关的属性通常可继承, 如 `font-*`、`color`、`line-height`、`text-align`、`text-indent`、`letter-spacing`、`white-space`、`direction`、`visibility`、`cursor`、`list-style`、`quotes` 等; 盒模型 (`width`/`height`/`margin`/`padding`/`border`)、定位 (`position`/`top`/`z-index`)、`background`、`display`、`float`、`overflow`、`transform` 等不可继承。经典疑问"为什么 `a` 不继承父元素颜色"的答案是 UA 默认样式表直接给 `a` 设了颜色, 直接命中高于继承, 想继承需显式写 `a { color: inherit; }`。

每个属性都接受五个全局关键字: `inherit` 强制继承父元素计算值; `initial` 重置为规范初始值 (注意 `display: initial` 是 `inline` 而不是 `block`); `unset` 对可继承属性表现为 `inherit`、对不可继承属性表现为 `initial`; `revert` 回滚到上一层来源 (作者样式回滚到用户或 UA 样式); `revert-layer` 回滚到上一层叠层中的值。`revert-layer` 在组件库配合 `@layer` 时特别有用, 可以只撤销本层覆盖而不影响全局。

`:root` 与 `html` 在 HTML 文档中通常指向同一元素, 但 `:root` 是伪类、特异性 (0,1,0) 高于 `html` 的 (0,0,1); 在独立 SVG 文档中 `:root` 匹配根 `<svg>` 而 `html` 匹配不到任何元素。定义全局自定义属性用 `:root` 是约定, 设置基础字号与背景等需要被更容易覆盖的场景可用 `html`。

## 盒模型与格式化上下文

### 盒模型与尺寸

两种盒模型的区别在 `width`/`height` 的计量范围, 由 `box-sizing` 控制。`content-box` (默认) 下 `width` 只含内容区, 元素实际占据宽度等于 `width` 加左右 padding 再加左右 border, 因此 `width: 100%` 再加 padding 会撑破父容器; `border-box` 下 `width` 含内容、padding 与 border, padding 与 border 向内挤压内容, 不改变外尺寸。现代做法通常全局重置为 `border-box`, 让"所见即所得"的尺寸更直观 (注意 margin 始终不计入, 也不受 `box-sizing` 影响)。

尺寸计算还需要区分盒子类型: 块级盒子的 `width` 默认撑满包含块, 行内盒子的宽高由内容决定; `min-content`、`max-content`、`fit-content()` 描述了内容驱动的尺寸; 替换元素 (`img`、`video`) 有固有尺寸与宽高比。`aspect-ratio` 直接声明宽高比, 替代了历史上用 `padding-top` 百分比撑高再绝对定位的 hack: 当 `width` 与 `height` 只有一方为确定值 (另一方为 auto 或未设置) 时, 比例参与求解另一维度; 两者都确定时比例不生效。需要注意 min/max 约束优先于比例, 例如同时写 `width: 100%` 与 `max-height` 时, 按比例推算的高度若超过上限就会被截断, 实际宽高比不再是设定值。

单位体系上, `px` 是与设备无关的逻辑像素, 高 DPR 屏上对应多个物理像素; `em` 相对当前元素自身的 `font-size` (用在 `font-size` 属性本身时相对父元素), 嵌套会逐层累积; `rem` 相对根元素字号, 无累积问题, 适合整体可缩放体系; `vw`/`vh` 是视口的百分之一, 移动端地址栏伸缩导致的视口高度变化由 `svh` (小视口)、`lvh` (大视口)、`dvh` (动态视口) 解决; 容器查询单位 `cqw`/`cqh`/`cqi`/`cqb`/`cqmin`/`cqmax` 相对查询容器; 字体相关单位还有 `ch` (数字 0 的宽度, 等宽排版与限制阅读宽度时好用)、`ex`、`lh`/`rlh` (行高)。百分比相对包含块的对应属性, 其中高度百分比要求父链有确定高度才生效, 而 `padding`/`margin` 的百分比一律相对包含块宽度 (包括垂直方向), 这个特性可用来做固定宽高比容器。全屏首屏高度应优先用 `100dvh` 而不是 `100vh`。

### 块级格式化上下文 (BFC)

BFC 是一块内部布局规则与外界隔离的独立渲染区域: 内部的变化不影响外部, 外部也不影响内部。触发方式满足其一即可: 根元素; `float` 不为 `none`; `position` 为 `absolute` 或 `fixed`; `overflow` 不为 `visible`; `display` 取 `inline-block`、`table-cell`、`flow-root` 等; `contain` 取 `layout`/`paint`/`content`/`strict`; 容器查询容器 (`container-type` 非 `normal`)、多列容器等。其中 `display: flow-root` 是现代最纯粹的触发方式, 它只为创建 BFC 而生, 没有 `overflow: hidden` 裁剪内容、`float` 改变布局的副作用。

BFC 内部的布局规则是: 盒子在垂直方向依次排列; 同一 BFC 内相邻盒子的垂直 margin 会合并; BFC 区域不与浮动元素重叠; 计算 BFC 高度时内部浮动元素也参与。这几个规则直接对应三个典型应用: 父元素建立 BFC 后高度计算包含浮动子元素 (清除浮动、解决高度塌陷); 用 BFC 边界隔断父子或兄弟之间的 margin 合并; 左栏浮动、右栏建立 BFC 后不与浮动重叠, 自动占满剩余宽度, 实现两栏自适应。需要精确区分的是: flex 与 grid 容器建立的是独立的 flex/grid 格式化上下文, 效果与 BFC 等价; 而 flex/grid 容器的直接子项会各自建立新的独立格式化上下文, 因此子项之间不会发生 margin 合并。

```css
.parent {
  display: flow-root;
} /* 包含浮动子元素, 且不裁剪内容 */
.left {
  float: left;
  width: 200px;
} /* 经典两栏: 右栏用 flow-root 自适应剩余宽度 */
.right {
  display: flow-root;
}
```

与 BFC 相对的是行内格式化上下文 (IFC), 它决定行内盒子的排版: 行盒高度、`vertical-align` 对齐、`line-height` 与 `font-size` 的关系、`white-space` 对换行与空格的处理都在这一层。文本溢出省略、行内元素垂直对齐异常、`inline-block` 元素之间的空白间隙等问题都源于 IFC 的排版规则。

### margin 合并

margin 合并指垂直方向上两个 margin 相遇时不叠加而合并为较大者, 只发生在块级盒子的垂直方向, 水平方向永不合并。三种典型场景: 相邻兄弟的 `margin-bottom` 与 `margin-top` 合并; 父子元素在父元素没有 border、padding、行内内容、清除浮动或 BFC 隔离时, 子元素的 `margin-top` 会"穿透"父元素表现为父元素整体下移; 空块元素自身的上下 margin 也会合并。不会发生合并的情形包括浮动元素、绝对定位元素、行内块、建立了 BFC 的元素与外部之间, 以及 flex/grid 容器的子项之间。

解决手段对应不同场景: 父子穿透可以给父元素加 padding 或透明 border、建立 BFC (`display: flow-root`), 或直接用 padding 表达间距; 兄弟合并可以统一只用一个方向的 margin, 或用 flex/grid 容器的 `gap` —— gap 不参与合并, 也能自动避免首尾多余间距, 是最现代的做法。理解要点是 margin 合并是规范刻意设计的排版行为 (让段落间距不至于翻倍), 不是 bug。

### 浮动与清除

浮动的原始用途是文字环绕图片: 浮动元素脱离正常文档流, 向左或右移动直到碰到包含块边界或另一个浮动元素, 后续块级盒子忽略其位置但行内内容会环绕。浮动的计算 `display` 会被强制为块级 (`float` 的 `span` 表现为块级), 它会创建独立的格式化上下文, 且不撑开父元素高度 (高度塌陷)。清理方式按现代程度排序: 用 `display: flow-root` 让父元素包含浮动; 用 `::after` 伪元素做 clearfix (设置 `content: ""`、`display: table`、`clear: both`, 用 `table` 而非 `block` 是为了避免产生新的 margin 合并); 直接在末尾加带 `clear` 的元素 (增加无意义节点, 不推荐)。布局场景则应直接用 flex 或 grid 替代浮动, 浮动只保留其原始语义。

### 定位与层叠上下文

`position` 的取值与行为: `static` 是默认值, 处于正常流且 `top`/`left`/`z-index` 无效; `relative` 仍占位, 相对自身原位置偏移, 常用于给绝对定位后代提供定位基准, 同时提升层叠优先级; `absolute` 脱离文档流, 相对最近的已定位祖先的 padding box (其包含块) 定位, 若没有则以初始包含块定位 —— 初始包含块尺寸与视口相同但锚定在文档顶部, 因此会随页面滚动而不是固定在可视区; `fixed` 脱离文档流, 相对视口定位, 滚动不移动; `sticky` 是 relative 与 fixed 的混合体。

`sticky` 在阈值内表现为 relative 随正常流滚动, 一旦滚到设定阈值就粘住, 直到父容器滚出视口; 它始终被限制在最近的滚动祖先与父容器范围内。常见失效原因: 某个祖先设置了 `overflow: hidden`/`scroll`/`auto` 且它并不是实际滚动容器, 改变了粘性参照的滚动盒; 父元素高度与子元素一样高 (如父级 `height: 100%` 或 flex 拉伸) 没有可粘滞的空间; 没有设置任何阈值属性。`fixed` 最常见的坑是包含块被改变: 当祖先存在 `transform`、`filter`、`perspective`、`backdrop-filter`、`will-change` 相关值、`contain: paint` 或非 normal 的 `container-type` 时, 该祖先成为 fixed/absolute 后代的包含块, fixed 不再相对视口, 弹窗与悬浮按钮"跑飞"多半是这个原因。

层叠上下文是三维渲染分组的抽象: 同一上下文内按规则决定谁盖谁; 不同上下文之间只比较两个上下文根元素的层级, 内部元素无法"越狱"。常见创建条件包括: 根元素; `position` 为 absolute/relative 且 `z-index` 非 auto; `position: fixed`/`sticky`; flex/grid 容器的子项且 `z-index` 非 auto; `opacity` 小于 1; `transform`/`filter`/`perspective`/`backdrop-filter` 非 none; `mix-blend-mode` 非 normal; `isolation: isolate`; `will-change` 指向上述属性; `contain: layout`/`paint`/`content`/`strict`。同一上下文内的绘制顺序从下到上为: 根元素的背景与边框, 负 `z-index` 的定位元素, 普通流中的块级盒子, 浮动元素, 普通流中的行内盒子, `z-index` 为 0/auto 的定位元素, 正 `z-index` 的定位元素。

`z-index` "失效"的三类原因: 元素是 `static` 定位 (对非定位元素与未设置 z-index 的 flex/grid 子项无效); 祖先创建了低层级的层叠上下文, 子元素 `z-index: 9999` 也翻不出父级的"天花板", 被其他分支盖住; 同级元素都未设置 z-index, 此时按绘制顺序后者覆盖前者, 看起来像失效。工程解法是全局规划层级区间 (基础、吸顶、抽屉、弹窗、toast 各占一段), 弹窗类组件用 portal 挂到 `body` 下避开祖先层叠上下文, 或直接用原生 `<dialog>` 与 popover —— 它们进入浏览器的 top layer, 渲染在所有常规内容之上, 天然不被任何 `z-index` 遮挡, 也不受祖先层叠上下文约束。

## 布局

### Flexbox: 一维弹性布局

flex 容器一次只处理一个方向 (主轴) 上的排列。容器属性包括: `flex-direction` (主轴方向, 默认 `row`)、`flex-wrap` (默认 `nowrap`)、`justify-content` (主轴对齐)、`align-items` (单行交叉轴对齐, 默认 `stretch`)、`align-content` (多行在交叉轴的分布)、`gap`。现行规范让 `align-content` 同样作用于单行 flex 容器 (单行时 `center` 整体居中, `space-between` 靠起点, 默认 `stretch` 把单行拉伸占满), 主流引擎已随块布局 `align-content` 的统一实现这一行为。

项目属性需要理解其计算过程: `flex-grow` 是放大比例 (默认 0), `flex-shrink` 是缩小比例 (默认 1), `flex-basis` 是主轴上的初始基准尺寸 (默认 `auto`, 取 `width`/`height`), `flex` 缩写默认值是 `0 1 auto`, 而 `flex: 1` 等价于 `flex: 1 1 0%`, 因此常用于均分剩余空间。收缩时实际收缩量按 `flex-shrink × flex-basis` 加权分配, 基准大的缩得多。`align-self` 覆盖单个项目的交叉轴对齐, `order` 改变视觉顺序但不改变 DOM 顺序 (规范明确它不影响 Tab 导航与读屏遍历顺序, 视觉序与键盘序错位本身就是无障碍风险, 不应用于逻辑重排)。

flex 布局有两个高频陷阱。第一, flex 子项的 `min-width`/`min-height` 计算值是 `auto`, 意味着它默认不会收缩到内容尺寸以下, 因此文本省略 (`text-overflow: ellipsis`) 常常不生效, 需要显式给子项加 `min-width: 0`。第二, `margin: auto` 在 flex 容器中会吸收主轴或交叉轴上的剩余空间, 是实现"单个元素推到一端"或"两端分布但间距固定"的简洁手段, 但也容易与 `justify-content` 的效果混淆。

```css
.container {
  display: flex;
}
.side {
  flex: 1 1 0;
  min-width: 0;
} /* min-width: 0 让侧栏能被压缩, 内部文本省略才生效 */
.center {
  flex: 0 0 300px;
} /* 中间固定宽度 */
```

### Grid: 二维轨道布局

grid 同时控制行与列, 适合页面级骨架与严格二维对齐。容器核心属性: `grid-template-columns`/`grid-template-rows` 用轨道列表定义尺寸, 支持 `fr` (剩余空间份数)、`repeat()`、`minmax()`、`auto-fill`/`auto-fit`; `gap` 控制轨道间距; `grid-template-areas` 用命名区域画图, 可读性极强; `justify-items`/`align-items` 控制单元格内对齐, `justify-content`/`align-content` 控制整个网格在容器内的分布; `grid-auto-flow` 与 `grid-auto-rows`/`grid-auto-columns` 控制隐式网格 (自动放置产生的轨道)。项目属性用 `grid-column`/`grid-row` 做基于线的定位 (如 `grid-column: 1 / 3` 跨两列), 或 `grid-area` 引用命名区域。

`auto-fill` 与 `auto-fit` 的区别在容器有剩余空间时显现: `auto-fill` 保留空轨道, `auto-fit` 折叠空轨道让现有项目拉伸填满。因此响应式卡片网格通常用 `auto-fit`。`fr` 与 `auto` 的差别也值得注意: `fr` 分配的是剩余空间, 而 `auto` 会先满足内容尺寸; `minmax(0, 1fr)` 是解决"网格子项被内容撑破"的常用写法, 与 flex 中的 `min-width: 0` 是同一类问题的不同解法。嵌套网格还可以用 `subgrid` 让子网格沿用父网格的轨道线, 使跨组件的行列对齐成为可能。

```css
/* 不写媒体查询即可自适应的卡片网格, 每列严格对齐 */
.list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}
```

### 布局任务与选型

居中是最高频的布局需求, 按子元素尺寸是否已知区分方案:

| 场景               | 方案                                                       | 说明                                                                      |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| 尺寸已知, 绝对定位 | `inset: 0; margin: auto`                                   | 四边归零后 auto margin 均分剩余空间                                       |
| 尺寸未知, 绝对定位 | `top/left: 50%` 加 `transform: translate(-50%, -50%)`      | transform 百分比相对自身尺寸, top/left 百分比相对包含块; 会创建层叠上下文 |
| 尺寸未知, flex     | 父元素 `justify-content: center` 加 `align-items: center`  | 对子元素数量与尺寸变化最健壮, 现代首选                                    |
| 尺寸未知, grid     | 父元素 `place-items: center` 或子元素 `place-self: center` | 语义简洁                                                                  |
| 单行文本           | `line-height` 等于容器高度加 `text-align: center`          | 仅适用于单行                                                              |

flex 与 grid 是互补而非替代关系, 选择取决于布局维度与元素位置的来源: 元素位置由内容决定、单方向排列 (导航栏、按钮组、工具栏、卡片内部) 用 flex; 布局是二维的、元素位置需要由设计稿精确指定、需要重叠或固定行列结构 (页面骨架、仪表盘、画廊、数据表格) 用 grid。实践中二者经常嵌套配合: 外层 grid 划分页面区域, 内层 flex 排列区域内的元素。

单侧自适应加中间固定的三栏布局也有多种实现: flex 用两侧 `flex: 1 1 0` 加中间 `flex: 0 0 300px`; grid 一行 `grid-template-columns: 1fr 300px 1fr`; 传统方案用浮动加 `margin` 避让或绝对定位 (缺点是侧栏过高时无法撑开容器); 圣杯布局与双飞翼布局是浮动时代的经典考题, 通过负 `margin` 与父 padding 实现"中间栏在 DOM 中优先渲染", 理解其对文档流与负 margin 的运用即可, 新项目不再需要。

## 响应式与自适应

### 媒体查询与断点策略

媒体查询按视口或设备特性切换样式, 常用特性包括 `width`/`height` 区间、`orientation`、`hover` 与 `pointer` (触屏与精确指针)、`prefers-color-scheme`、`prefers-reduced-motion`、`prefers-contrast`、`min-resolution` (高分屏)、`scripting` (JS 是否可用)。多个条件用 `and` 连接, 逗号表示"或"。

```css
@media (hover: none) and (pointer: coarse) {
  /* 触屏设备 */
}
@media (prefers-reduced-motion: reduce) {
  /* 用户要求减弱动效 */
}
@media (min-width: 768px) and (max-width: 1023px) {
  /* 区间断点 */
}
```

断点策略上, 移动优先 (基础样式面向小屏, 用 `min-width` 逐级增强) 是主流, 天然渐进增强且代码量小; 桌面优先 (`max-width` 递减) 适合存量 PC 站改造。现代理念是"能不用媒体查询就不用": 优先用内在尺寸 (`min-content` 等)、flex/grid 的自适应性、`clamp()` 与流式布局, 把断点留给真正的结构级变化 (侧栏隐藏、栅格列数、字号阶梯)。完整的响应式方案矩阵包括流式布局、flex/grid 自适应、媒体查询断点、rem/vw 缩放体系、响应式图片 (`srcset`/`sizes`/`<picture>`) 、容器查询与流式排版。

### 容器查询

媒体查询依据视口尺寸, 容器查询依据组件自身容器的尺寸, 解决的是"同一个卡片放在侧栏和放在主区域布局应当不同, 但视口宽度相同"的问题。用法分两步: 先在容器元素上声明 `container-type: inline-size` (只关心行内方向, 通常是宽度) 并可选地用 `container-name` 命名; 再在容器后代上用 `@container` 查询。

```css
.card-host {
  container-type: inline-size;
  container-name: cardhost;
}

@container cardhost (min-width: 400px) {
  .card {
    display: flex;
  } /* 容器够宽时卡片改为横向布局 */
}
@container (min-width: 700px) {
  .card {
    font-size: 18px;
  } /* 不写名字时匹配最近的祖先容器 */
}
```

需要理解 `container-type: inline-size` 的代价: 它对容器施加布局、样式与行内尺寸包含, 容器的行内尺寸不再由内容撑开, 因此在浮动、inline-block、绝对定位等收缩尺寸场景下可能塌成 0, 使用时要确保容器有确定的宽度来源。完整的尺寸包含由 `container-type: size` 提供, 代价更高。容器查询只能影响容器的后代而不能查询自身。配套的容器查询单位 `cqw`/`cqh`/`cqmin`/`cqmax`/`cqi`/`cqb` 让字号、圆角等可以直接随容器缩放 (如 `font-size: 5cqw`)。与媒体查询的关系是互补: 页面整体布局仍由媒体查询驱动, 组件内部自适应交给容器查询。主流浏览器自 2023 年起已支持。

### 数学函数与流式排版

`calc()` 允许混合不同单位参与计算, `min()`/`max()` 取边界, `clamp(min, preferred, max)` 一次表达区间约束 (等价于 `max(min, min(preferred, max))`)。使用时要注意 `+` 与 `-` 两侧必须有空格, `*` 与 `/` 则不必; 函数可以嵌套, 也可以与自定义属性配合。

```css
.content {
  width: min(90%, 1200px); /* 小屏占满, 大屏限宽 */
  margin-inline: auto;
}
h1 {
  font-size: clamp(16px, 2.5vw, 24px);
} /* 流式字号 */
:root {
  --space-md: clamp(16px, 2vw, 24px);
}
```

`clamp()` 驱动的流式字号与间距能显著减少媒体查询数量。需要注意的是它仍然依赖视口或容器单位作为中间值, 在极端窄屏或宽屏下应由上下界兜住。`repeat(auto-fit, minmax(min(100%, 300px), 1fr))` 是网格场景里比较常见的组合, 用内层 `min()` 保证在低于最小列宽时列宽退化为可用宽度的 100%。

### 深色模式

跟随系统偏好用 `prefers-color-scheme`, 现代做法是配合 `color-scheme` 属性与 `light-dark()` 函数:

```css
:root {
  color-scheme: light dark;
}
body {
  background: light-dark(#fff, #141414);
  color: light-dark(#1f2329, #e8e8e8);
}
```

`color-scheme` 必须设置, 它告诉浏览器页面支持哪些配色方案, 浏览器据此把表单控件、滚动条、自动填充底色切换为对应风格; 不设置则暗色环境下输入框仍是亮色, 体验割裂。手动切换与系统跟随并存的方案通常用 `data-theme` 属性加自定义属性: 默认变量与 `[data-theme="dark"]` 各定义一套, 再用 `@media (prefers-color-scheme: dark)` 对未显式指定主题的情况生效。主题判定脚本必须内联在文档头部同步执行, 否则暗色用户会先看到一帧亮色。图片在暗色下可用 `<source media="(prefers-color-scheme: dark)">` 换版本; 阴影在暗色下几乎不可见, 应改用更亮的描边或发光。

## 自定义属性、层叠与现代特性

### 自定义属性与 @property

CSS 自定义属性 (常称 CSS 变量) 是运行时的值, 真实存在于计算样式中: `el.style.setProperty("--brand", "red")` 立即生效并联动所有引用处。它遵循层叠与继承规则, 可以在任意选择器、媒体查询、伪类中重新定义实现局部覆盖, 因而能做运行时主题切换、用户自定义皮肤与响应式变量。`var(--x, fallback)` 的第二参数是回退值。一个容易踩的边界是自定义属性对浏览器只是无类型的 token 串: 未注册时无法插值, 因此不能参与 `transition`/`animation`, 并且当替换后的值在计算值阶段无效时, 该属性会表现为"无效值"而不是让整条规则失效。自定义属性也不能用于媒体查询条件 (`@media (min-width: var(--x))` 无效)。

`@property` 解决类型与插值问题:

```css
@property --progress {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 0%;
}
.bar {
  background: linear-gradient(to right, #1677ff var(--progress), #eee 0);
  transition: --progress 0.3s ease; /* 注册类型后变量才可过渡 */
}
.bar.done {
  --progress: 100%;
}
```

注册后浏览器知道"这是一个百分比", 就能对它做平滑过渡。典型应用包括渐变动画 (渐变本身不可过渡, 但驱动渐变的变量可以)、圆环进度条、数字滚动。`@property` 目前主流引擎覆盖良好, 是最成熟的 Houdini 能力; 同一套能力在 JS 侧对应 `CSS.registerProperty`。

与预处理器变量相比, 自定义属性是运行时、可被层叠与继承影响、可被 JS 读写; 预处理器变量 (如 SCSS 的 `$brand`) 在编译期被静态替换为字面量, 产物中不存在, 无法运行时修改, 但可以参与编译期运算、循环与 mixin 参数。工程上通常用预处理器变量管理设计 token 的"事实来源", 编译输出为自定义属性供运行时使用。

### 原生嵌套

CSS 原生嵌套允许不经编译直接在浏览器里写嵌套规则, 媒体查询也可以嵌套在规则内部。它与预处理器嵌套的关键差异: 原生嵌套由浏览器解析, 零构建; `&` 是父选择器的引用而不是字符串, 因此不支持 `&-title` 这类拼接 (BEM 依赖的正是这种拼接); 父选择器是列表时, 含 `&` 的分支会按每个父选择器各自展开并各自计算特异性。嵌套选择器可以直接以元素选择器开头, `&` 只在需要显式引用父选择器时使用。

```css
.card {
  padding: 16px;
  &:hover {
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.1);
  }
  .title {
    font-size: 18px;
  }
  @media (min-width: 768px) {
    padding: 24px;
  }
}
```

### 层叠层、特性查询与现代交互特性

`@supports` 是渐进增强的核心工具, 条件语法与媒体查询类似, 支持 `not`、`and`、`or` 与括号分组; 除了 `(property: value)` 形式的属性值对, 还支持 `selector()` 检测选择器支持、`font-tech()`/`font-format()` 检测字体技术。JS 侧对应 `CSS.supports()`。注意 `@supports (display: grid)` 这类写法检测的是"解析器是否认识该声明", 对于语法合法但行为有差异的旧实现, 需要更精确的条件。

`scroll-snap` 让滚动容器在释放后自动吸附到预定义位置: 容器设 `scroll-snap-type` (方向加 `mandatory` 或 `proximity` 强度), 子元素设 `scroll-snap-align` (`start`/`end`/`center`) 与 `scroll-snap-stop: always` (快速滑动时也不能跳过), 必要时用 `scroll-padding` 为吸附留出内边距。它适合轮播、全屏分页与画廊, 原生支持触摸、惯性滚动与键盘导航, 但不内含自动播放、指示器与无限循环。部分引擎还提供 `scrollsnapchange`/`scrollsnapchanging` 事件用于感知吸附变化, 使用前应特性检测。

```css
.carousel {
  display: flex;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
}
.carousel > * {
  flex: 0 0 100%;
  scroll-snap-align: center;
}
```

View Transitions 把"DOM 状态切换时元素从旧位置平滑飞到新位置"交给浏览器: `document.startViewTransition(() => updateDOM())` 会捕获旧状态快照、执行 DOM 更新、再在新旧快照间做过渡, 默认交叉淡入, 可通过 `::view-transition-old()`/`::view-transition-new()`/`::view-transition-group()` 等伪元素完全自定义; 给新旧两个元素设置相同的 `view-transition-name` 即可实现共享元素过渡。跨文档 (MPA) 场景用 `@view-transition { navigation: auto; }` 声明即可获得类似 SPA 的转场。需要注意过渡进行时被捕获元素的真实渲染与命中测试会被挂起, 页面由快照呈现, 因此过渡期间不要依赖页面交互, 过渡要短, 并用 `prefers-reduced-motion` 降级。同文档过渡在三大主流引擎上均已可用, 跨文档过渡目前由 Chromium 与 Safari 实现, 使用前应检测 `document.startViewTransition` 与 `@view-transition` 的支持情况。

滚动驱动动画让动画进度由滚动位置而不是时间驱动, 运行在合成器线程不阻塞主线程。`animation-timeline: scroll()` 绑定容器滚动进度 (如阅读进度条), `animation-timeline: view()` 绑定元素自身在视口中的可见进度并配合 `animation-range` 控制起止区间 (如入场淡入、视差), 可替代一部分 `IntersectionObserver` 用例。该能力在 Chromium 系与较新 Safari 上可用, 其余引擎覆盖仍不完整, 生产使用前应通过 `@supports (animation-timeline: scroll())` 检测并以无动画作为降级。

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

## 动画与变换

### transition 与 animation

| 维度       | transition                               | animation                                                                 |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| 触发方式   | 被动, 属性值变化时发生, 从 A 到 B 走一遍 | 主动, 绑定即按 `@keyframes` 运行                                          |
| 关键帧     | 只有起点与终点                           | 任意多个关键帧                                                            |
| 循环与方向 | 一次性                                   | 支持 `iteration-count`、`direction: alternate`、`play-state`              |
| 填充模式   | 无                                       | `animation-fill-mode` 控制前后定格帧 (不加 `forwards` 结束会跳回初始状态) |
| 步进       | 支持 `steps()`                           | 支持 `steps()`, 可做逐帧动画与打字机效果                                  |

`animation-timing-function` 决定插值曲线, 除 `ease`/`linear` 等关键字外可用 `cubic-bezier()` 自定义; `steps(n, jump-term)` 用于离散分帧。`transition-property: all` 会监听所有可过渡属性, 带来不必要的计算, 生产上应显式列举。

两个高频"过渡失效"问题的现代解法: `display: none` 与 `block` 之间无法插值, 因为元素进出渲染树没有中间状态, 新方案是 `transition-behavior: allow-discrete` 配合 `@starting-style` 定义入场前样式 (允许离散属性参与过渡), 或改用 `opacity`/`visibility`; `height: auto` 不是可插值数值, 方案包括用 JS 测量 `scrollHeight` 后赋值、用 grid 的 `grid-template-rows: 0fr` 到 `1fr` 技巧, 或使用 `interpolate-size: allow-keywords` 与 `calc-size()`。后两组新特性按引擎逐步落地, 使用前应通过 `@supports` 检测并以无动画作为降级。

### transform 与动画性能

`transform` 与 `position` 都能改变视觉位置, 但走的渲染阶段不同:

| 维度       | transform                | position                                                    |
| ---------- | ------------------------ | ----------------------------------------------------------- |
| 影响布局   | 不影响, 元素仍占据原位置 | `absolute`/`fixed` 脱离文档流, 影响布局                     |
| 渲染阶段   | 可只在合成阶段生效       | 布局阶段                                                    |
| 百分比参照 | 元素自身尺寸             | 包含块尺寸                                                  |
| 层叠上下文 | 非 none 即创建           | fixed/sticky 总是创建, absolute/relative 需 z-index 非 auto |

修改 `top`/`left`/`width`/`margin` 会触发重排、重绘再到合成, 每帧走完整管线且运行在主线程, 主线程一被长任务占用动画帧就被挤掉。修改 `transform`/`opacity` 时, 若元素已被提升为合成层, 变化由合成器线程直接对 GPU 纹理做矩阵变换或透明度混合, 完全跳过布局与绘制; 即便未提升, `transform` 也不会引发重排。因此动画属性白名单就是 `transform` 与 `opacity` (视情况加 `filter`), 位移用 `translate`、缩放用 `scale`、旋转用 `rotate` 等效替代布局属性。

```text
top/left 动画:   JS → Style → Layout → Paint → Composite   (每帧全套, 主线程)
transform 动画:  JS → Style → Composite                    (每帧合成, 合成线程)
```

这与 FLIP (First Last Invert Play) 动画技术的思路一致: 用 `transform` 模拟布局变化, 把昂贵的布局动画换算成便宜的合成动画。需要注意的是 `transform` 会创建层叠上下文并成为 fixed/absolute 后代的包含块, 可能引入定位问题; 缩放类动画后位图放大也可能模糊, 需要重新栅格化或调整策略。

### will-change 与合成层

`will-change` 提前告知浏览器元素将发生何种变化, 让它有时机准备资源 (如创建合成层、分配 GPU 资源)。提升为合成层的常见条件还包括 3D transform、正在对 `transform`/`opacity` 做动画或过渡、`video`/`canvas` 元素、`filter`/`backdrop-filter`、部分内核下的 `position: fixed`, 以及与已有层重叠时的隐式提升。

正确用法是在动画即将开始时添加、结束后立即移除, 例如在 `mouseenter` 时设 `element.style.willChange = "transform"`, 在 `animationend` 时恢复 `auto`。注意事项: 每个合成层都是一份独立纹理, 过度提升尤其隐式合成引发的层爆炸会暴涨 GPU 内存, 低端设备反而掉帧; `will-change` 只对能走合成路径的属性有效, 改 `width`/`height` 之类的布局属性仍然重排; 长期挂在大量元素上是反模式; 它还会创建层叠上下文并可能改变包含块。相比 `transform: translateZ(0)` 这类 hack, `will-change` 语义更明确且可以声明 `scroll-position`、`contents` 等多种变化类型。

## 渲染性能与 CSS 交付

### 阻塞行为与渲染管线

CSS 是渲染阻塞资源: 浏览器必须等 CSSOM 构建完成才能合成渲染树并首次绘制, 否则会出现无样式闪烁。它不阻塞 HTML 解析 (预加载扫描器会在解析 HTML 的同时并行下载 CSS), 但会阻塞其后脚本的执行, 因为脚本可能通过 `getComputedStyle` 读取样式, 而脚本又阻塞 HTML 解析, 于是"慢 CSS"会间接冻结整页解析:

```text
CSSOM 未就绪 → 后面的 <script> 无法执行 → HTML 解析暂停 → DOM 与首屏延后
```

例外是媒体查询当前不匹配的样式表 (`media="print"` 或屏幕条件不满足), 它们不阻塞渲染但仍会下载。优化实践: 关键 CSS 内联进 HTML, 非关键样式异步加载 (`rel="preload" as="style"` 配合 onload 切换, 或用 `media="print"` 切换法并配 `noscript` 兜底); 按路由拆分 CSS; `<link>` 尽量靠前放让扫描器尽早发现; 脚本用 `defer`/`async` 解除对解析的阻塞 (注意 `defer` 脚本同样要等 CSSOM, 这是规范行为)。

渲染页面的完整管线是: 解析 HTML 得 DOM, 解析 CSS 得 CSSOM, 合并为只含可见节点的渲染树, 布局计算几何, 绘制生成指令并分块光栅化, 合成线程按 `transform`/`opacity`/层序合成最终帧。关键渲染路径的优化都围绕这条链: 减少关键资源数量与体积、缩短关键路径长度、减少重排重绘。

### 重排重绘与 contain

重排 (reflow/layout) 由几何变化触发, 重绘 (repaint) 只重跑绘制阶段, `transform`/`opacity` 则可能只需合成。关系是重排必然引发重绘与合成, 重绘必然引发合成。强制同步布局 (layout thrashing) 是最典型的性能杀手: 写入使布局失效后立刻读取 `offsetWidth`、`getBoundingClientRect()` 等几何属性, 浏览器被迫立即同步布局才能返回正确值, 循环中交替读写会把一次布局放大成多次。优化手段包括批量修改、读写分离、动画只用 `transform`/`opacity`、用绝对或固定定位缩小重排范围、用 `requestAnimationFrame` 合并每帧的写操作。

`contain` 与 `content-visibility` 属于 CSS Containment 体系, 核心思想是开发者向浏览器承诺"某子树与外界互不影响", 浏览器据此跳过子树的样式计算、布局与绘制。`contain` 的取值: `layout` 表示内部布局独立, 内部变化不引发外部重排, 反之亦然; `paint` 表示后代不绘制到元素边界外; `size` 表示元素尺寸不依赖内容 (需要开发者给出确定的尺寸, 否则会塌陷); `style` 表示计数器等样式影响不逸出子树; 组合值 `strict` 等于 layout 加 paint 加 size 加 style, `content` 等于 layout 加 paint 加 style。

`content-visibility: visible` 是默认值; `hidden` 跳过内容渲染 (不进入渲染树、不暴露给无障碍树、页内查找也不命中), 但与 `display: none` 不同, 浏览器保留其最后的渲染状态, 恢复时无需从零重建; `auto` 是最常用的值: 视口外的内容跳过渲染, 滚动到附近才开始渲染, 由浏览器自动管理。

```css
.card-list > li {
  content-visibility: auto;
  contain-intrinsic-size: auto 200px; /* 未渲染时的预估占位高度, 防滚动条跳动 */
}
```

`contain-intrinsic-size` 提供预估尺寸, 避免未渲染内容高度为 0 导致滚动条位置漂移; 它与虚拟列表互补 —— 虚拟列表解决 DOM 节点数, `content-visibility` 解决渲染成本, 简单场景甚至可以直接替代虚拟列表。注意点是预估尺寸不准会有轻微滚动抖动, 以及 `auto` 下浏览器查找与锚点跳转对未渲染区域的行为差异。

## 样式组织与工程化

### 方案对比

四种主流方案解决的都是"样式组织与作用域", 但实现时机完全不同:

| 维度       | 原子化 (Tailwind 等)     | CSS Modules            | 运行时 css-in-js         | 编译时 css-in-js     |
| ---------- | ------------------------ | ---------------------- | ------------------------ | -------------------- |
| 作用域     | 预定义工具类按约定组合   | 编译期哈希类名         | 运行时生成唯一类名       | 编译期抽取为静态类名 |
| 运行时开销 | 无, 产物是静态 CSS       | 无                     | 有序列化与样式注入开销   | 无                   |
| 动态样式   | 有限, 靠变体与 CSS 变量  | 需配合内联样式或变量   | 表达力最强               | 通过 CSS 变量传值    |
| 首屏样式   | 静态 CSS 可并行加载      | 同左                   | 必须等 JS 执行后才存在   | 同静态方案           |
| 典型问题   | 类名冗长, 需统一设计约束 | 类名是哈希, 调试不直观 | 与并发渲染、SSR 存在张力 | 工具链依赖重         |

原子化方案的思想是每个类只做一个声明, 通过组合拼装 UI; 构建期扫描源码提取类名 token, 按需生成对应规则, 未使用的类不进入产物, 因此产物体积随项目变大很快收敛。Tailwind v4 采用 CSS-first 配置: 入口样式表只需 `@import "tailwindcss"`, 默认自动探测源文件, 设计 token 用 `@theme` 声明 (声明 `--color-brand` 会自动派生出 `bg-brand`、`text-brand` 等工具类), 插件用 `@plugin` 加载; 暗色主题的常见做法是用 `.dark` 选择器覆盖同名的自定义属性, 这也说明原子化与 CSS 变量是配合而非竞争关系。变体前缀 (`hover:`、`md:`、`dark:`) 编译为伪类或媒体查询包裹的规则, 动态值通过 CSS 变量注入。

CSS Modules 在构建期把每个类名改写为带哈希的唯一名, 并导出"原名到混淆名"的映射给 JS 使用; 配套的 `:global()` 声明全局类, `composes` 在模块间组合复用。它保留了写原生 CSS 的习惯, 产物是纯静态 CSS, 是 React/Vue/Svelte 通用的稳妥默认项。

运行时 css-in-js 性能差的原因值得单独说明: 一是序列化开销, 每次渲染都要把 props 插值进模板并序列化成 CSS 字符串再做哈希查缓存, 列表场景每项样式不同会完全失去缓存; 二是样式注入会触发受影响子树的样式重算; 三是样式必须等 JS 下载、解析、执行、组件渲染后才存在, 首屏样式可用时间显著延后, SSR 下还要额外做样式收集与注水; 四是动态类名无法像静态文件那样长缓存。这不是说它一无是处, 强主题化、强动态的组件仍有其适用场景, 但性能敏感、SSR 与大体积项目应优先选择静态方案, 这也是社区整体转向静态方案的原因。

### 预处理器、PostCSS 与样式交付

预处理器 (Sass/SCSS、Less) 提供变量、嵌套、mixin、继承、函数与控制指令。其中 mixin 与 `@extend` 的区别需要分清: mixin 把声明复制到每个调用处、支持参数, 产物体积可能膨胀; `@extend` (配合占位选择器 `%placeholder`) 把选择器合并到同一组声明, 产物更精简但不能传参, 且会改变选择器的位置、可能引入意外的层叠顺序。带参复用选 mixin, 纯静态公共样式选占位选择器。模块化用 `@use` 与 `@forward` 取代会重复引入并污染全局的 `@import`。CSS 原生变量与原生嵌套普及后, 预处理器在这两方面的需求在弱化, 但 mixin、循环、函数与构建期逻辑仍是其不可替代的部分, 常与 PostCSS 串联使用。

PostCSS 是"CSS 到 CSS"的转换平台: 把源码解析成 AST, 由插件遍历修改后重新序列化, 本身不做任何事。它与预处理器的关系是串联而非互斥 (先编译 SCSS, 再跑 PostCSS)。代表插件包括 autoprefixer (基于目标浏览器配置自动增删厂商前缀)、postcss-preset-env (把新语法按目标浏览器降级)、cssnano (压缩优化)、postcss-pxtorem/postcss-px-to-viewport (移动端单位换算)、postcss-modules (CSS Modules 的实现之一)。

样式交付上有两个必须掌握的结论。其一, 用 `<link>` 而不是 `@import`: 多个 link 可被预加载扫描器在 HTML 解析早期并行发现, 而 `@import` 必须等包含它的 CSS 下载解析后才能发现下一层 URL, 形成串行瀑布; link 还支持 media、disabled、`rel="preload"` 且能被 JS 操作。其二, 真正的按需加载需要 JS 动态插入 link (或构建期按路由拆分); `media` 属性不会阻止 CSS 下载, 只是不匹配时不阻塞渲染。Critical CSS 的思路是把首屏所需样式内联进 HTML, 其余样式异步加载, 并用工具自动提取与压缩首屏关键样式。

### 组件级隔离: Shadow DOM 与 Vue scoped

Shadow DOM 的隔离依赖影子树独立的样式作用域: 外部文档的选择器无法选中影子树内部节点, 内部样式也不会泄漏到外部。穿透通道有两类: 可继承属性 (color、font 等) 会照常继承进影子树, CSS 自定义属性能无视边界, 因此外部定义 `--card-color`、内部用 `var(--card-color)` 是官方推荐的主题定制方式。主动开放的接口包括 `:host` (在影子树内选中宿主)、`::slotted()` (只作用于插槽的直接子节点, 不能深入)、`::part()` 配合 `part`/`exportparts` (受控暴露内部元素供外部定制)。Constructable Stylesheets (`new CSSStyleSheet()` 加 `adoptedStyleSheets`) 可在多个实例间共享同一份样式表, 避免每个实例内联重复样式, 是性能最佳实践。需要注意全局 reset 不会命中影子树内部节点, 组件需自带样式或通过 adoptedStyleSheets 注入; `@font-face` 按规范是文档级全局的, 在组件内声明兼容性不佳。

Vue 的 `<style scoped>` 是编译期转换: 模板编译时给每个元素添加唯一数据属性 (如 `data-v-xxx`), 样式编译时用 PostCSS 给每条选择器末尾追加属性选择器, 于是样式只命中带该属性的元素。细节上: 子组件的根节点同时带有父组件的属性, 因此父组件的 scoped 样式可以影响子组件根节点; 需要影响子组件内部时用 `:deep(.child-class)`; `:slotted()` 给插槽内容设置样式; `:global()` 声明全局规则。与 CSS Modules 相比, scoped 是给类名追加属性选择器 (权重加一, 类名本身仍是全局的), Modules 是直接把类名改写为唯一哈希, 隔离更彻底。

### 跨端样式: React Native 与 Yoga

React Native 没有浏览器、没有 DOM、没有 CSSOM, 所谓"RN 里的 CSS"只是借用 CSS 属性命名与 Flexbox 语义的 JS 对象, 最终由原生视图渲染。差异清单: 样式是 JS 对象且属性名驼峰化, 没有选择器、样式表文件与层叠; 继承极弱, 只有文本组件嵌套时继承部分文字属性, 所有文本必须包在文本组件里; 数值是无单位逻辑像素, 由系统按 DPR 换算, 不支持 em/rem/vw; 默认布局是 Flexbox 且主轴为纵向 (Web 默认横向), 没有 float、没有 grid, `position` 基本只有 relative/absolute; 没有伪类、伪元素与媒体查询 (响应式靠窗口尺寸钩子与平台选择), `transform` 用数组语法。Yoga 是 Meta 开源的跨平台 C++ 布局引擎, 实现了与 W3C Flexbox 高度一致的算法并扩展了宽高比等行为: JS 侧样式同步到原生层构建 Yoga 节点树, Yoga 依据可用空间自顶向下递归计算每个节点的几何框架并回写原生视图。它的价值是让一份 Flexbox 布局代码在 iOS 与 Android 上像素级一致, 屏蔽两套原生布局体系的差异; 与 Web 渲染的本质区别在于没有 CSSOM 层叠、没有重排重绘与合成层的浏览器管线, 布局一次算完直接落到原生视图, 性能瓶颈更多在 JS 与原生的通信和视图层级深度上。

## 适用场景与小结

CSS 的知识可以按"决定层"来组织, 复习与排查时按这个顺序思考效率最高:

- 样式不生效: 先看层叠 (来源与 `!important`)、再看权重与 `@layer`、最后看继承与初始值; 权重战争的正解是用 `:where()` 降低基础样式权重或用 `@layer` 排序, 而不是继续叠加选择器。
- 布局错乱: 先确认盒子类型与格式化上下文 (块级、行内、flex/grid 子项的行为完全不同), 再看 margin 合并与包含块; 浮动时代的方案应优先被 flex/grid 与 `display: flow-root` 替代。
- 组件复用困难: 页面级自适应用媒体查询与内在尺寸, 组件级自适应用容器查询; 主题与动态值用自定义属性承载, 需要过渡时再上 `@property`。
- 动画掉帧: 确认动画属性是否在合成白名单 (`transform`/`opacity`), 是否有强制同步布局, 是否需要 `will-change` 与层提升, 并警惕层爆炸的内存代价。
- 首屏变慢: 确认 CSS 的阻塞链与体积 (关键 CSS 内联、非关键异步、避免 `@import` 串行瀑布), 长页面用 `content-visibility` 降低渲染成本。

选型上的取舍也很清晰: 样式作用域优先用 CSS Modules 或原子化这类静态方案, 它们零运行时、对 SSR 与缓存友好; 需要运行时主题与设计 token 时, 用自定义属性把动态部分从编译期搬到运行时, 而不是把整条样式链搬进 JS; 预处理器与 PostCSS 负责构建期能力 (复用、降级、前缀、单位换算), 与静态方案并不冲突。与语言和浏览器机制的衔接见 [JavaScript、DOM、浏览器与网络](fe), 框架侧的样式集成见 [React](react) 与 [Next.js](next)。
