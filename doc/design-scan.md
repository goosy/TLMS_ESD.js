# 数据层与扫描周期重构设计（草案）

> 本文是一次内部重构的目标设计，描述重构完成后数据层和主循环“怎么做”。现状见 [design.md](design.md)，需求见 [spec.md](spec.md)。
> 重构不改变任何布局、点表和协议，不改变联锁逻辑的判定条件；时序上的变化见第 9 节，需要同步修改的规范条目也列在第 9 节。
> 迁移步骤见 [plan-scan.md](plan-scan.md)。重构完成后，本文内容并入 design.md 的第 3、5、6、7 节，本文删除。
> TData / TTag 对使用者承诺的接口见 [spec-data-api.md](spec-data-api.md)：它们是面向程序员的通用数据对象，任何时候都可以读写值，值变化时发出事件；本文的扫描式数据流只是控制器这个场景的使用方式，不限制它们的能力。

## 1. 目标与总体结构

重构解决现状中的四个问题：

| 问题 | 现状 | 重构后 |
| --- | --- | --- |
| 访问器 | 每个 TData 实例对每个 tag 调用 `defineProperty`；TTag 在 `init()` 中按类型生成闭包，各类型代码大量重复 | 每种结构编译一次，访问器定义在原型上；按类型查编解码表（第 2、3 节） |
| 变化检测 | 依赖每条写入路径主动调用 `check_change`，组合字靠 `coupling` 列表手动联动；TTag 缓存的值可能与 buffer 不一致 | buffer 与快照逐字节比对，所有写入方统一检测，取消 `coupling` 联动和值缓存（第 5 节） |
| 派生量 | 汇总量经事件 + 50 ms 防抖逐层传播，结果取决于定时器与 IO 返回的交错顺序 | 每次扫描按依赖顺序同步求值；扫描由输入到达立即触发，周期 tick 只负责推进计时（第 6、7 节） |
| 职责 | TData 同时承担布局、镜像、驱动绑定和事件 | 拆分为 Layout、TData、Binding、Observer 四层（本节） |

四层的划分：

| 层 | 职责 | 实例数 | 可变性 |
| --- | --- | --- | --- |
| Layout | 由 YAML 布局描述编译而来：各 tag 的字节位置、编解码、字节到 tag 的反查表、原型访问器 | 每种结构一个 | 不可变 |
| TData | 值缓冲区 `buffer`（大端）、按名访问、原始写入方法、`get(name)` 返回的 TTag 句柄 | 每个 tdata 一个 | 可变 |
| Binding | `buffer` 区间与驱动地址的对应、设备字节序、写入单元、`IO_buffer`、分组读写、连接与完成状态 | 每个 tdata 与驱动的一次绑定一个 | 绑定参数不变，状态可变 |
| Observer | 快照比对，发出变化事件，提供上一次扫描结束时的值 | 每个 tdata 一个 | 可变 |

依赖方向：Binding 和 Observer 依赖 TData 与 Layout，TData 只依赖 Layout，Layout 只依赖布局描述。驱动只出现在 Binding 中。扫描调度器（第 6 节）是唯一调用规则的模块；TData 和 Binding 只通过使用方传入的回调（控制器中接到 `request_scan()`）通知它，不知道调度器的存在。

### 1.1 组件边界

Layout、TData（含 TTag 句柄）、Observer 和对上服务端（vector 与 Unit_Map）将来要独立为一个组件，供 Modbus 设备模拟器和本项目这样的控制器共用：组件提供 Modbus TCP 服务端，并通过 TData / TTag 操作其内部状态。本次不独立组件，但代码按组件边界组织：

- 组件代码放在 `src/typed_data/`：`codecs.js`、`structure.js`（结构展开与布局校验）、`layout.js`、`types.js`（类型声明生成）、TData、TTag、Observer，以及迁入的 vector 与 Unit_Map；
- 组件代码不得引入组件以外的模块：不依赖配置（`config.js`）、业务处理（`*_proc.js`）、项目的布局（`src/layouts.yaml`、`src/layouts.js`）和项目的日志器（`util.js`）；
- 组件代码出错时抛出异常，不写日志、不调用 `process.exit`，由调用方决定如何报告和退出；需要报告运行中的非致命情况（如访问未映射的地址）时，经构造参数注入的 logger，缺省不输出；
- 布局描述对组件是外部输入：本项目的 `src/layouts.yaml` 由 `src/layouts.js` 交给组件编译；
- Binding、调度器、规则和 Ticker 不属于组件，可以依赖组件，组件不依赖它们；控制器把 `request_scan()` 作为 `on_write` 回调交给 TData（3.3 节），组件不知道调度器的存在；
- 组件的接口（spec-data-api.md）面向程序员：TData / TTag 任何时候都能读写、值变化时发出事件，组件不因任何使用方的调度方式而限制这些能力。

现有代码中尚不符合边界的部分，在迁移计划中逐步消除（plan-scan.md 第 3 节各步骤）。

## 2. Layout

### 2.1 布局描述（YAML）

布局描述是纯数据，以 YAML 文件给出，不再写在 JS 模块中。这样数据层不依赖任何具体项目的结构定义：本项目的布局随代码发布，将来把数据层独立为组件时，布局就是调用方传入的外部配置。文件格式、条目字段和合法性规则见 spec-data-api.md 第 6 节。

本项目的布局文件为 `src/layouts.yaml`，与入口模块同在 `src/` 下，由 `src/layouts.js` 在加载时编译，导出 `LINE`、`SECTION`、`NODE`、`COMMAND`、`RECORD` 以及业务逻辑需要的片段（如参数块的名称列表）。构建时该文件作为独立文件复制到 `main.js` 同目录（不打进 `main.js`），路径按模块位置解析，所以源码运行和打包运行时它与入口模块的相对位置相同。布局不合法时，逐条写入错误日志并退出，满足“布局违规时拒绝启动”。

### 2.2 编译

- `compile_layout(yaml_path)`：同步读取并解析 YAML，解析片段引用，对每个布局调用 `build_structure` 展开、调用 `validate_structure` 校验；有违规时抛出包含全部违规项的错误。返回 `{ layouts, fragments }`：`layouts` 按布局名索引 Layout，`fragments` 按片段名索引展开后的条目列表。
- `layout_of(data_struct)`：把一个已展开的结构编译为 Layout，按结构对象缓存。`compile_layout` 内部使用它；测试中用 JS 条目构造的结构也经它编译。

Layout 的内容：

- `size`：字节数，即 `data_struct.length >> 3`；
- `entries`：按名称索引的条目表，每个条目包含：
  - `name`、`type`（小写）、`init_value`；
  - `byte`：字节偏移；
  - `size`：字节数（Bool 和单字节类型为 1，16 位类型为 2，32 位类型为 4）；
  - `mask`：Bool 为 `1 << (offset % 8)`，其余为 `0xff`；
  - `codec`：该类型在编解码表中的项；
- `tags_at_byte`：长度为 `size` 的数组，第 i 项是覆盖第 i 个字节的全部条目。组合字和它的各个组成位落在同一字节上，会同时出现在对应项中；
- `Data_Class`：该结构专用的 TData 子类（见 2.4 节）；
- 与展开后的结构相同的 `name`、`length`、`items`，因此现有按 `NODE.items` 等方式使用结构的代码不受影响。

`layout_of` 假定结构合法，不重复做布局规则校验，只检查 tag 名不与 TData 成员冲突（冲突时访问器会遮蔽成员）。

### 2.3 编解码表

每种类型在表中有一项，`get(buffer, entry)` 从大端缓冲区解码，`set(buffer, entry, value)` 编码写入：

```js
const CODECS = {
    bool:  { get: (b, e) => (b[e.byte] & e.mask) !== 0,
             set: (b, e, v) => { b[e.byte] = v ? b[e.byte] | e.mask : b[e.byte] & ~e.mask; } },
    byte:  { get: (b, e) => b.readUInt8(e.byte),   set: (b, e, v) => b.writeUInt8(v, e.byte) },
    usint: { get: (b, e) => b.readUInt8(e.byte),   set: (b, e, v) => b.writeUInt8(v, e.byte) },
    sint:  { get: (b, e) => b.readInt8(e.byte),    set: (b, e, v) => b.writeInt8(v, e.byte) },
    int:   { get: (b, e) => b.readInt16BE(e.byte), set: (b, e, v) => b.writeInt16BE(v, e.byte) },
    // uint, word, dint, udint, dword, real follow the same pattern
};
```

TTag 中按类型分支生成闭包的代码全部由这张表取代。设备字节序不在表中处理，只在 Binding 中处理（第 4 节）。

### 2.4 原型访问器

编译时为每种结构生成一个 TData 子类，在其原型上为每个条目定义一次访问器：

```js
class Data_Class extends TData {}
for (const entry of entries) {
    const { get, set } = entry.codec;
    Object.defineProperty(Data_Class.prototype, entry.name, {
        get() { return get(this.buffer, entry); },
        set(value) { set(this.buffer, entry, value); this.after_write(entry); },
        enumerable: true,
    });
}
```

- getter 每次从 `buffer` 解码，不再缓存值，因此不存在缓存与缓冲区不一致的问题。
- setter 写入 `buffer` 后调用 `after_write(entry)`，其行为见 3.2 节。
- 组合字与组成位共用同一块字节，写任何一方，另一方读到的自然是新值，不需要 `check_coupling`。
- 由布局文件生成类型声明 `src/layout_types.d.ts`（每个布局一个接口，tag 为属性，`comment` 作为注释），为按名访问提供编辑器补全；生成物纳入版本库，由测试检查它与布局文件一致。

名称冲突：tag 名不得与 TData 的成员同名，这一规则仍由 `validate_structure` 检查。由于 Binding、Observer 不再挂在 TData 上，TData 的成员只剩 `name`、`layout`、`buffer`、`size`、`get`、`after_write`、`observer` 和 3.2 节的写入方法等少数几个，保留名称表随之缩小。

## 3. TData

### 3.1 创建与访问

- 由 `new layout.Data_Class(name)` 创建：
  1. 分配 `buffer`（`layout.size` 字节）；
  2. 按条目的 `init_value` 依次编码写入。
- 对外接口（完整定义见 spec-data-api.md）：
  - 按名读写：`data.pressure`、`data.pressure = v`；
  - `get(name)`：返回该 tag 的 TTag，名称不存在时返回 `undefined`；
  - 原始写入方法（3.2 节）；
  - `detect()`：检测并报告自上次检测以来的变化（3.3 节）；
  - `buffer`（只读访问）、`size`、`name`、`layout`。
- TTag 是操作单个 tag 的友好接口，不持有值和缓冲区切片：
  - `value` 可读可写：读取从 `buffer` 解码，写入与 `data[name] = v` 完全等价（同一个 setter）；
  - `name`、`type`、`length` 等描述来自 Layout 条目；
  - 事件订阅：`on('change', (old_value, new_value) => ...)`，由 Observer 触发（第 5 节）。

  TTag 按需创建并缓存，没有被 `get` 过的 tag 不创建 TTag。
- 整块的 `change(tagname, old, new)` 事件由 Observer 经 TData 发出。

### 3.2 写入与扫描请求

写 `buffer` 只有两种途径，都经过 TData：

| 途径 | 使用者 | 写入后 |
| --- | --- | --- |
| 按名赋值（`data[name] = v` 或 `tag.value = v`） | 任何代码：规则、事件处理器、异步回调、普通程序 | 按检测模式处理（3.3 节） |
| 原始写入方法 | 对上服务端（Unit_Map） | 按检测模式处理（3.3 节） |

任何时候写入都是允许的，不论是否在扫描中。

原始写入方法以字节偏移定位，供不按 tag 名访问的写入方使用：

- `write_register(offset, value)`：写一个 16 位寄存器（大端）；
- `write_bit(offset, mask, value)`：写一个字节中的一位（线圈）；
- `write_bytes(offset, source)`：写一段字节。

Unit_Map 的 vector 函数 `set_register` / `set_coil`（es-modbus v0.3 的命名）改用 `write_register` / `write_bit`，不再直接调用 `buffer.writeUInt16BE`，也不再自行调用检测，检测由 TData 按检测模式处理。控制器中 TData 使用立即检测模式（3.3 节）：一个功能码 16 请求会在同一个同步调用中连续调用多次 `set_register`，每次写入都立即检测，所以跨两个寄存器的 Real 在写完第一个寄存器时会以写了一半的值发出一次 `change` 事件，写完第二个寄存器时再发出完整的值；规则不受影响，因为 `request_scan()` 会合并（6.2 节），扫描在整个请求处理完之后才执行，规则读到的是完整的值。

Binding 的装载（4.2 节）在扫描的输入阶段直接写 `buffer` 的内容，属于扫描内部，不经过上述方法，也不请求扫描；装载后的变化在本次扫描的发布阶段检测。

除数据层（`src/typed_data/`）和 Binding 外，任何代码不得直接写 `buffer` 的内容；用一个测试检查 `src/` 中其他文件没有对 `.buffer` 的写调用。

### 3.3 检测模式的实现

检测本身由 Observer 完成（第 5 节）：`diff()` 比对 `buffer` 与快照，报告变化。Observer 不区分模式；两种模式（行为见 spec-data-api.md 4.2 节）只决定 TData 在写入之后由谁、何时调用 `diff()`。

所有写入路径最后都汇到 TData 的同一个私有方法：

```js
// setter -> after_write -> #written; write_register / write_bit / write_bytes -> #written
#written() {
    if (this.#detection === "immediate") this.#observer.diff();  // detect right now
    this.#on_write?.(this);                                       // then notify the user
}

detect() {
    this.#observer.diff();
}
```

- 立即模式：在写入语句内部同步调用 `diff()`，再调用 `on_write`；
- 延迟模式：只调用 `on_write`，不检测；检测由使用方调用 `detect()` 完成；
- 扫描不是 TData 的一部分：TData 没有阶段、排序和计时，只是在“自己检测”和“交给使用方”之间二选一。

**控制器使用立即模式。** 控制器的全部 tdata（线、段、执行器的 data 和 command、动作记录）始终使用立即检测模式，`on_write` 接到调度器的 `request_scan()`，所以任何写入（规则、事件处理器、HMI、异步回调）在检测之后都请求一次扫描。

选择立即模式的理由：

- 两种模式下值同样及时：写入立即生效，规则读到的永远是当前值；检测模式只决定 `change` 事件何时发出；
- 控制器的联锁和汇总都在规则中，不依赖事件（第 8 节），所以延迟模式对联锁结果没有收益；
- 立即模式下事件在写入的调用栈中发出，调试时能追溯写入者；
- 迁移期间现有事件处理器依赖“赋值后立即收到事件”，始终使用立即模式就不必在迁移末期再切换一次。

已知的代价，只影响事件处理器（主要是日志）：求值阶段规则的写入，其事件在规则执行的中途发出；一次扫描内同一 tag 的多次变化分别发出事件；功能码 16 写跨两个寄存器的值时出现一次中间值（3.2 节）。

## 4. Binding

### 4.1 绑定参数

`new Binding(data, driver, { start, remote_start, length, endian }, ...extras)`：

- `start` / `length`：TData 内交换区 `[start, start + length)`，以字节计；
- `remote_start`：远端起点；`extras` 原样传给驱动（Modbus 为 `unit_id`，S7 为 `area, db`）；
- `endian`：`BE`、`LE`（`little`）、`BEBS`、`LEBS`；
- `write_unit`：取 `driver.write_unit`，缺省为 1；
- 交换区三项参数必须是写入单元的整数倍，否则抛出错误（取代现在的 `process.exit(1)`）；
- Binding 持有 `IO_buffer`（按设备字节序，与交换区同长），驱动读入的数据只写入 `IO_buffer`。

### 4.2 字节映射与所有权掩码

设备字节序以 16 位寄存器和 32 位值为单位生效（规范 3.6）。Binding 为交换区内每个字节预先算出它在 `IO_buffer` 中的下标 `io_index[i]`：

- 2 字节条目：`LE` / `little` / `BEBS` 时两字节互换，`BE` / `LEBS` 时不变；
- 4 字节条目：按 `BE`、`LE`、`BEBS`、`LEBS` 四种排列换算（与现在 `convert_endian_4bytes` 相同）；
- Bool 和单字节条目：`LE` / `little` / `BEBS` 时为 `byte ^ 1`，否则不变；
- 不属于任何条目的字节按 2 字节规则换算。

布局校验保证非 Bool 条目不重叠、Bool 只落在组合字内，所以每个字节的映射是唯一的。

分组（取代 TGroup，接口名 `create_group(...names)` 保持现有用法）编译时为组内每个字节算出**所有权掩码** `own[i]`：

- 非 Bool 条目覆盖的字节为 `0xff`；
- Bool 条目只置其 `mask` 对应的位；
- 同一字节上的多个组内条目取“或”。

于是分组的装载和导出都是一个紧凑的逐字节循环：

```js
// load: IO_buffer -> buffer, only the bits owned by the group
for (const i of group.bytes) {
    const m = group.own[i];
    buffer[i] = (buffer[i] & ~m) | (IO_buffer[io_index[i]] & m);
}
// store: buffer -> IO_buffer, before writing the group areas
for (const i of group.bytes) {
    const j = io_index[i];
    const m = group.own[i];
    IO_buffer[j] = (IO_buffer[j] & ~m) | (buffer[i] & m);
}
```

装载只改写组内条目所占的位，例如节点状态字中的 `comm_OK` 由控制器维护、不在 `data_payload` 中，装载时保持不变，与现在逐 tag `read_from` 的结果一致。写区间的计算（按写入单元扩展、合并相交或相邻区间）沿用 design.md 3.4 节，只是从 TGroup 移到分组编译阶段。

### 4.3 读写

- `request_read()`：发起一次整段读取，完成后把数据复制到 `IO_buffer`，置 `fresh = true`，并调用 `request_scan()`。上一次读取尚未完成时不再发起新的读取，避免慢设备上请求堆积。
- `load(group)`：在扫描的输入阶段执行 4.2 节的装载并清除 `fresh`；只修改 `buffer`，不发事件，不请求扫描。
- `request_write(group)`：登记一次写请求，同一分组在一次扫描内多次登记只写一次。
- `flush_writes()`：在扫描的输出阶段，对已登记的分组执行导出，再按写区间调用驱动写入。写入是异步的，不阻塞扫描。
- 驱动未连接时，`request_read` 和 `flush_writes` 直接跳过并保留写请求，与现在 `check_driver` 返回 false 的行为一致。

### 4.4 连接与完成状态

驱动事件和异步读写结果不再由回调直接改写 tag，而是记录为 Binding 的状态，供规则读取：

| 状态 | 更新时机 |
| --- | --- |
| `connected` | 驱动的 `connect` / `connfailed` 事件 |
| `read_ok` | 每次读取完成：成功为 true，失败（对应现在驱动的 `io_error`）为 false |
| `write_done(group)` | 某个分组的一次写入完成，记录完成序号和结果，供规则判断“上次请求的写入已完成” |

每次状态变化后 Binding 调用 `request_scan()`。这些状态是规则的依赖键（7.1 节），属于输入，只由 Binding 写入。

## 5. Observer

### 5.1 快照比对

每个 TData 配一个 Observer，持有与 `buffer` 等长的快照 `snapshot`，创建时复制 `buffer`（即 `init_value` 的编码结果）。`diff()` 的算法：

```js
diff() {
    const { buffer, snapshot, layout } = this;
    const seen = new Set();
    for (let i = 0; i < layout.size; i++) {
        if (buffer[i] === snapshot[i]) continue;
        for (const entry of layout.tags_at_byte[i]) {
            if (seen.has(entry)) continue;
            seen.add(entry);
            const old_value = entry.codec.get(snapshot, entry);
            const new_value = entry.codec.get(buffer, entry);
            if (!same_value(old_value, new_value)) this.changes.push([entry, old_value, new_value]);
        }
    }
    buffer.copy(snapshot);
    this.emit_changes();
}
```

- 旧值从快照解码，不需要缓存。
- `same_value` 把两个 NaN 视为相同，与现在 `check_change` 一致。
- 先完成比对和快照更新，再按布局顺序统一发出事件：每个变化先发整块的 `change(name, old, new)`，再发 TTag 的 `change(old, new)`（与原来由 TTag 转发整块事件时的顺序一致），事件总在新值生效之后发出。
- 一次检测内多次写入合并为一个事件，旧值是上次检测时的值；值改变后又恢复的，不发事件。
- 报告变化时处理器又写入的，再比对一轮；连续 16 轮仍有新变化时抛出异常，防止振荡。
- 基准测试（NODE 结构，74 个 tag、146 字节）：无变化和少量变化时比现有逐 tag 检查快 9 到 16 倍，全部变化时快约 2 倍。

### 5.2 检测与响应

- 检测完整：无论写入来自哪里，变化都会在下一次检测（立即模式为写入后，延迟模式为扫描的发布阶段）被比对出来，不会遗漏。
- 响应及时：经 TData 原始写入方法和 Binding 的写入会立即请求扫描（3.2、4.3、4.4 节）；万一有写入绕过了它们，变化也最迟在下一次周期 tick 的扫描中被处理，只是变慢，不会丢失。

### 5.3 上一次扫描的值

Observer 提供 `previous(name)`，返回上一次扫描结束时的值：它从扫描快照 `scan_snapshot` 解码，调度器在每次扫描结束时调用 `take_scan_snapshot()` 更新它。延迟模式下扫描快照与检测快照在每次扫描后相同；立即模式下检测快照在扫描之间不断刷新，所以两者分开保存。

Binding 状态（4.4 节）和登记的变量（7.1 节）没有 Observer，由调度器在每次扫描结束时各保存一份值。调度器据此提供统一的上一次扫描的值和边沿判断（6.5 节）：

```js
scheduler.previous(owner, name);  // data block: observer.previous(name); binding state or variable: saved by the scheduler
scheduler.rose(owner, name);      // !previous && current
scheduler.fell(owner, name);      // previous && !current
scheduler.changed(owner, name);   // previous differs from current (NaN equals NaN)
```

## 6. 扫描

### 6.1 四个阶段

调度器的 `scan(tick)` 全程同步执行：

```js
function scan(tick) {
    // 1 input: take the process image, advance running tickers on periodic ticks
    phase = "input";
    for (const { binding, input_group } of bindings) if (binding.fresh) binding.load(input_group);
    if (tick) for (const ticker of running_tickers) ticker.count++;
    // 2 evaluate: all rules in one fixed dependency order, each isolated (6.4)
    phase = "evaluate";
    for (const rule of ordered_rules) guarded(() => rule.run(rule.ticker), rule);
    // 3 publish: detect every change since the last scan, emit change events
    phase = "publish";
    for (const data of data_blocks) guarded(() => data.detect(), data);
    // the end of this scan: data blocks, binding states and variables save their values
    take_scan_snapshots();
    // 4 output: send what was requested, start reads on periodic ticks
    phase = "output";
    for (const { binding } of bindings) binding.flush_writes().catch(report);
    if (tick) for (const { binding } of bindings) binding.request_read().catch(report);
    phase = "idle";
}
```

1. **输入**：把有新数据的执行器从 `IO_buffer` 装载进 `buffer`，形成本次扫描的过程映像。没有新数据的执行器保持原值，通信异常由 `comm_OK` / `work_OK` 反映（与现在相同）。周期 tick 的扫描还要把所有运行中的 ticker 计数加 1（7.3 节）。
2. **求值**：按第 7 节排好的顺序执行全部规则，计算汇总量、触发位、计时、联锁动作，并登记写请求。
3. **发布**：所有 Observer 比对快照，发出变化事件。事件处理器只做日志（第 8 节）。
4. **输出**：执行本次登记的写请求；周期 tick 的扫描还发起下一轮读取。读写是异步的，完成时 Binding 的 `on_update` 请求扫描，那时本次扫描已经结束。

“上一次扫描结束时的值”在发布阶段之后保存：本次扫描中规则和事件处理器所做的写入都算在本次扫描内。

### 6.2 触发

扫描有两类触发：

| 触发 | 来源 | `tick` |
| --- | --- | --- |
| 周期 tick | 每 `MAIN_PERIOD`（500 ms）一次 | true |
| 扫描请求 | `request_scan()`：HMI 经 Unit_Map 写入（3.2 节）、执行器数据读回（4.3 节）、Binding 状态变化（4.4 节） | false |

- `request_scan()` 用 `setImmediate` 合并：同一轮事件循环中的多次请求只引起一次扫描；周期 tick 到来时若有尚未执行的请求，由 tick 的扫描一并处理。
- 扫描进行中的请求来自本次扫描自己的写入（周期 tick 从不调用 `request_scan()`，外部的回调只能在两次扫描之间运行）：
  - 输入、求值阶段的请求忽略：本次扫描中后面的规则已能读到这些写入，它们的变化也已检测；而 derive 规则每次扫描都会写入，如果它们也引起扫描，扫描将不会停止；
  - 发布阶段开始之后的请求安排下一次扫描：事件处理器写入的 tdata 可能在本次发布中已经检测过。
- 扫描之外的写入照常允许（事件处理器、异步回调、对上服务端）：控制器的 TData 的 `on_write` 接到 `request_scan()`（3.3 节），所以任何写入都会引起一次扫描。
- 计时只在 `tick` 为真时推进：调度器在 tick 扫描的输入阶段推进全部运行中的 ticker，请求触发的扫描不推进，所以扫描次数不影响计时。规则不接收 `tick` 标志，也不自行累加计数（7.3 节）。

### 6.3 时序

- 执行器数据读回、HMI 写入、连接状态变化后，立即扫描：派生状态、联锁动作在这次扫描中完成，产生的命令在这次扫描的输出阶段发出。
- 读取仍按周期发起，执行器数据的新旧程度受读取周期限制，与现在相同。
- 一个周期内会因不同执行器的读回发生多次扫描，段内首端和末端数据的读取时刻可能不同。这与现在相同（执行器本来就不是同时读取的），输差判定有延时确认，不受瞬时不一致影响。
- 不再有状态汇总防抖和命令发送防抖；`debouncify` / `debounce` 在迁移完成后删除。
- 控制器不对执行器上报的值做去抖或滤波，信号去抖由执行器完成。

与现状的时延对比：

| 路径 | 现在 | 重构后 |
| --- | --- | --- |
| HMI `manStopCmd` → 下发停泵命令 | 最长 500 ms（等 `section_loop`）+ 100 ms 防抖 + IO | 立即 + IO |
| HMI 写段或线的 `flow_override` → 中断倒计时 | 最长 500 ms | 立即 |
| HMI 命令（如 `horn`）→ 发出 | 100 ms 防抖 + IO | 立即 + IO |
| 执行器应答 → 清除命令位 | 读取周期 + 100 ms 防抖 | 随周期读取读回，读回即处理 |
| 流量变化 → 输差触发位 | 读回 + 两级 50 ms 防抖，下一周期计数 | 读回即处理，下一次 tick 计数 |

### 6.4 出错隔离

控制器是安全系统，一处缺陷不得让其他联锁停止工作：

- 每条规则单独执行，抛出异常时经调度器创建时注入的 `on_error(error, source)` 报告，然后继续执行后面的规则；`source` 为出错的规则、tdata 或 Binding；
- 发布阶段每个 tdata 的检测（含事件处理器）单独隔离；
- 输出阶段的异步读写失败同样经 `on_error` 报告；
- 控制器把 `on_error` 接到日志；调度器本身不写日志，未注入时异常被忽略。

### 6.5 调度器接口

```js
const scheduler = new Scheduler({ period: MAIN_PERIOD, on_error });
scheduler.add_data(tdata);                    // detected in the publish phase, snapshot at the end of a scan
scheduler.add_binding(binding, input_group);  // loaded in the input phase, flushed and read in the output phase
scheduler.add_binding(binding);               // output only: flushed in the output phase, never read nor loaded
scheduler.add_var(owner, name);               // a shared variable: a property of an object (7.1)
scheduler.add_rule(rule);                     // built by derive() / act() (7.2)
scheduler.prepare();                          // order the rules and check them (7.4); throws with every error
scheduler.start();                            // periodic ticks: scan(true) every period
scheduler.request_scan();                     // a coalesced triggered scan: scan(false)
scheduler.stop();
```

- `prepare()` 在第一次扫描之前调用一次；之后不再登记。
- 不带输入分组登记的 Binding 只写不读，用于执行器的命令块：控制器只向执行器写命令，从不读回；命令的应答在节点 tdata 的 `response_code` 中，随周期读取得到。
- `scan(tick)` 可以直接调用，供测试驱动扫描；在扫描进行中被调用时（例如规则或事件处理器中），不嵌套执行，而是排到本次扫描之后。
- tdata 的 `on_write` 和 Binding 的 `on_update` 由使用方接到 `request_scan()`（步骤 5 接入运行流程时完成）。

## 7. 规则

### 7.1 依赖键

规则读写的对象统一用“依赖键”表示，即 `(owner, name)` 二元组：

- owner 是 TData 时，name 是 tag 名，例如 `(section.data, 'comm_OK')`；
- owner 是段、线、执行器等普通对象时，name 是该对象的属性名，例如 `(section, 'press_SD_trigger')`。这样的变量必须用 `add_var` 登记；变量必须是某个对象的属性，裸变量不能作为依赖键；
- owner 是 Binding 时，name 是状态名，例如 `(binding, 'connected')`，只读。

这样 TTag、变量（规范 3.6）和 Binding 状态按同一套规则排序，不需要把变量升级为 TTag。

组合字与它的组成位共用同一块数据，但名称不同，按名称建立的依赖看不出它们之间的关系。为此规定：

- 规则只写组成位，不写组合字。数据流中没有既写字又写位的需求：整字写入只来自装载和对上服务端，它们是扫描的输入；需要清除若干命令位时（应答握手、命令屏蔽），按名逐位写入；
- `reads` 中的组合字，在排序前展开为读它的全部组成位，之后依赖按名称建立。于是写某一位的规则排在读整字的规则之前；写不同位的两条规则之间没有依赖。

### 7.2 规则的两种类型

| 类型 | 写入约束 | 用途 |
| --- | --- | --- |
| derive（派生） | 是其写入键的唯一写入者，每次扫描完全决定写入键的值 | 汇总、差值、触发位、保护状态、计时、`action_F`、`stop_pumps` 等 |
| act（动作） | 写入键可以有多个写入者（包括 HMI 和其他 act），可以只在条件成立时写入 | 边沿动作、联锁置位 / 复位、命令收发、参数复制、动作记录、按连接状态改写 `comm_OK` / `work_OK` |

每条规则有一个名字 `name`，用于启动检查和出错报告，例如 `section S1 comm_OK`。规则声明的键分三类：

| 字段 | 含义 |
| --- | --- |
| `reads` | 读取本次扫描的值，构成依赖：写入者排在本规则之前 |
| `writes` | 写入的键 |
| `reads_previous` | 读取上一次扫描结束时的值（`scheduler.previous()`），不构成依赖，用于打断环（7.4 节） |

规则可以使用两种状态：

| 状态 | 用途 | 上一次扫描的值、边沿判断 |
| --- | --- | --- |
| 依赖键（tag、Binding 状态、登记的变量） | 多条规则共享的状态，参与排序 | 由调度器提供（5.3 节） |
| 闭包变量 | 只属于一条规则的状态：锁存、计数、自己需要的“上一次的值”等 | 规则自己保存 |

闭包变量不登记、不参与排序，只能被所属规则读写。计时不用闭包变量自行累加，而是使用调度器分配的 ticker（7.3 节）。

```js
derive({
    name: `section ${section.name} comm_OK`,
    reads: all_nodes.map(node => [node.data, 'comm_OK']),
    writes: [[section.data, 'comm_OK']],
    run: () => { section.data.comm_OK = all_nodes.every(node => node.data.comm_OK); },
});

act({
    name: `section ${section.name} stop commands reset`,
    reads: [[section.data, 'pump_run']],
    writes: [[section.data, 'autoStopCmd'], [section.data, 'manStopCmd']],
    run: () => {
        if (!scheduler.fell(section.data, 'pump_run')) return;
        section.data.autoStopCmd = false;
        section.data.manStopCmd = false;
    },
});

// a private state in a closure variable, here the previous value for an edge
let was_high = false;
act({
    name: 'example closure edge',
    reads: [[node.data, 'pressure']],
    writes: [[node.command, 'horn']],
    run: () => {
        const high = node.data.pressure > LIMIT;
        if (high && !was_high) node.command.horn = true;
        was_high = high;
    },
});
```

### 7.3 计时（Ticker）

编排规则时，调度器为每条规则生成一个 Ticker，扫描时作为 `run(ticker)` 的参数传入。规则自己决定何时开始、何时停止计时，调度器只负责推进：

```js
class Ticker {
    count = 0;          // periodic ticks since start
    running = false;
    constructor(running_set) { this.running_set = running_set; }
    get elapsed() { return this.count * MAIN_PERIOD; }
    // no-op while running, so a held condition keeps counting
    start() {
        if (this.running) return;
        this.running = true;
        this.count = 0;
        this.running_set.add(this);
    }
    stop() {
        this.running = false;
        this.count = 0;
        this.running_set.delete(this);
    }
    restart() {
        this.stop();
        this.start();
    }
}
```

- 推进：tick 扫描的输入阶段，调度器把 `running_tickers` 中每个 ticker 的 `count` 加 1（6.1 节）；请求触发的扫描不推进。只有运行中的 ticker 在集合里，推进开销与正在计时的数量成正比。
- 规则不接收 `tick` 标志，也不自行累加计数，所以扫描次数不影响计时。
- 每条规则只有一个 ticker。需要两个独立计时的逻辑拆成两条规则，例如段的输差警告延时和输差报警延时分属两条 derive 规则。

**按值的条件延时**（条件持续成立一段时间后输出，语义同 PLC 的 TON）用一个辅助函数表达：

```js
// true once cond has held for longer than delay_ms
function on_delay(ticker, cond, delay_ms) {
    if (cond) ticker.start();
    else ticker.stop();
    return ticker.elapsed > delay_ms;
}

derive({
    reads: [[section.data, 'flow_alarm_trigger'], [section.data, 'flow_diff_AH_delay']],
    writes: [[section.data, 'flow_alarm_F']],
    run: (ticker) => {
        const { data } = section;
        data.flow_alarm_F = on_delay(ticker, data.flow_alarm_trigger, data.flow_diff_AH_delay);
    },
});
```

**按值的断开延时**（条件成立时立即输出，条件消失后再保持一段时间，语义同 PLC 的 TOF）是它的对偶：

```js
// true while cond holds, and for delay_ms after it drops
function off_delay(ticker, cond, delay_ms) {
    return !on_delay(ticker, !cond, delay_ms);
}
```

计时语义与 `on_delay` 相同。条件从一开始就不成立时，输出在启动后保持 `delay_ms` 再变为 false，与 TOF 的输出在输入为假时的表现一致。

**边沿启动的计时**（事件发生后经过一段时间执行动作，中途可由规则自行中止）由 act 规则直接操作 ticker。注意边沿判断只在发生边沿的那一次扫描为真，检查计时必须放在边沿判断之外：

```js
act({
    reads: [[binding, 'connected']],
    writes: [[command, 'temperature_zero_raw'] /* ... all parameter tags */],
    run: (ticker) => {
        if (scheduler.rose(binding, 'connected')) ticker.restart();
        if (!binding.connected) ticker.stop();             // aborted by the rule itself
        if (ticker.running && ticker.elapsed >= 2000) {
            ticker.stop();
            reset_parameters();
        }
    },
});
```

计时语义：

- 条件消失或规则调用 `stop()` 时立即生效，不必等下一次 tick。例如倒计时期间人工挂起：HMI 写入段或线的 `flow_override` 触发扫描，`protect_F`、`pre_stop_notice` 在这次扫描中变为 false，倒计时规则停止 ticker，输差动作不会发生；
- 在两次 tick 之间启动的 ticker，下一次 tick 时 `count` 为 1。现在的延时条件（如 `flow_alarm_trigger`）都由事件在两次 `section_loop` 之间置位，下一次 `section_loop` 累加 500 ms，两者完全相同：条件成立后，`on_delay` 在其后的第 `floor(delay / MAIN_PERIOD) + 1` 次 tick 输出 true；
- 在 tick 扫描中启动的 ticker，本次扫描 `count` 为 0，从下一次 tick 开始计数，比现在的写法晚一个周期。重构后数据读回触发的是请求扫描，不是 tick 扫描，这种情况只在 tick 扫描恰好装载了新数据时出现；
- 两次 tick 之间条件出现又消失，ticker 停止并清零，不影响计时；
- 请求触发的扫描中 `count` 不变，依赖计时结果的规则重复执行不会产生新的边沿；
- 计时值需要对外显示的（如 `countdown`），由规则在每次扫描中从 `elapsed` 换算，两次 tick 之间数值不变。

7.5 节中所有“按 tick 计数”的处理都使用 ticker。

### 7.4 排序

启动时（构建对象图之后、第一次扫描之前）对全部规则做一次拓扑排序，得到 `ordered_rules`：

- 有向边：写入键 K 的规则 → 读取键 K 的规则；
- 同一个键的多个写入者全部排在它的读取者之前；
- 一条规则读取自己也写入的键（读改写，例如 `line_action_source &&= line.autoStopCmd` 所在的规则），这次读取不构成依赖边；
- `reads_previous` 中的键不构成依赖边；
- 同一个键的多个写入者之间、以及没有依赖关系的规则之间，按声明顺序排列，保证结果可重复；
- 声明顺序与现在的处理顺序一致：执行器 → 段 → 线，同类对象按配置顺序。

规则在整个对象图（全部 tdata、Binding 和变量）建好之后声明，因为上层的规则要引用下层的 tdata，下层的规则也会引用上层的 tdata（例如段的 `pre_stop_notice` 读线的 `pump_run`）。各层的规则由各自的声明函数（执行器、段、线各一个）给出，运行时在对象图建好后按执行器 → 段 → 线的顺序调用它们，再调用 `prepare()`。

启动时检查以下错误，发现时报告全部错误并拒绝启动：

- 依赖成环：报告环上的规则和键，并提示可以用 `reads_previous` 打断；
- `reads_previous` 中的键取不到上一次扫描的值：只有 tag、Binding 的 `connected` / `read_ok` 和登记的变量有上一次扫描的值；
- 一个键有 derive 写入者，同时还有其他规则写入者；
- 规则写入了只读的 Binding 状态；
- 规则写入了组合字；
- 规则声明了不存在的 tag 名或 Binding 状态名；
- 规则声明了未用 `add_var` 登记的变量；
- 规则没有名字，或两条规则同名。

示例：现有逻辑中 `section.pre_stop_notice` 读取 `line.pump_run`，`line.pump_run` 汇总各段的 `pump_run`，`line.pre_stop_notice` 又汇总各段的 `pre_stop_notice`。按层级（段 → 线）无法给出正确顺序，按键排序得到：

```
node.pump_run -> section.pump_run -> line.pump_run
  -> section.pre_stop_notice -> line.pre_stop_notice
```

现在由于各段可能读到线的旧值，需要依靠线的变化事件补算一次（design.md 6.2 节）；排序后同一次扫描内一次算对。

**环的打断。** 规则之间的依赖必须是无环的。业务上确实需要环时（例如两个量互相依赖），由规则作者在环上选一处，改为读取上一次扫描结束时的值，即在声明中把这个键放进 `reads_previous`，并在 `run` 中用 `scheduler.previous()` 读取。这相当于控制系统中的单位延迟：该量总是比环上其他量晚一个扫描周期，语义固定。

```js
derive({
    name: 'line B',
    reads_previous: [[section.data, 'A']],
    writes: [[line.data, 'B']],
    run: () => { line.data.B = g(scheduler.previous(section.data, 'A')); },
});
```

调度器不自动选择打断点，也不在一次扫描内反复求值直到稳定：收敛与否取决于规则中的函数，而不是依赖图的结构，一般无法判定；即使收敛，结果也可能随打断点或初值不同而不同。打断在哪里是业务判断，留给规则作者显式写出，便于审查。

### 7.5 现有处理到规则的对应

| 现有处理 | 规则类型 |
| --- | --- |
| `connfailed` 后延时 `delay_protect_time` 置 `comm_OK = false`，`connect` 时置 true | derive：`comm_OK = off_delay(ticker, connected, delay_protect_time)`；`comm_OK` 不在装载的分组中，只由这条规则写入 |
| `io_error` 后延时置 `work_OK = false` | act：`off_delay(ticker, read_ok, delay_protect_time)` 为 false 时置 `work_OK = false`；读取成功后由装载恢复执行器上报的值（装载也写 `work_OK`，所以是 act） |
| `connect` 后 2 s 执行 `reset_parameters` | act，按边沿：`connected` 上升沿开始按 tick 计时，满 2 s 时把 data 的参数复制到 command；其间断开则停止 |
| 执行器 `pump_run` = `pump_run_1..4` 的“或” | 删除：执行器已上报“或”运算后的 `pump_run`，以上报值为准；它和 `pump_run_1..4` 一样是装载的输入 |
| 执行器 `pump_run` 下降沿收回 `stop_pumps` 命令 | act |
| `response_code` 应答握手（清命令位、`executing`、再次发送） | act：`response_code` 变化且不为 0 时，逐位清除已应答的命令位，复位 `executing`；发送由发送规则完成 |
| `pressure_SD_F` 变化时清除允许 / 禁止命令位并发送 | act |
| `read_paras` 本地处理 | act：上升沿复制参数并复位该位 |
| `write_paras` 本地处理 | act：上升沿复制参数并登记写入；读 `write_done(data_parameters)`，写入完成后复位该位 |
| `commands` 变化：`has_commands` | derive |
| `commands` 变化：发送命令 | act，`commands` 变化时，或 `response_code` 变化且不为 0 时（让执行器看到已应答的位被清除），登记 `request_write(commands_payload)`，取代 100 ms 防抖 |
| 连续 3 个周期无应答时重发 | act，每个执行器单独按 tick 计时：`has_commands` 持续超过 3 个 tick 后，每个 tick 重发一次 |
| 命令屏蔽（现为对全部执行器统一的 `& 0xB1`） | act：按执行器配置的 `command_mask`（design.md 12.1 节），每次扫描逐位复位不支持的命令位。它在全部规则之后声明，同一个命令位的多个写入者按声明顺序排列，所以它排在其他写命令位的规则之后；它写命令位，所以排在读 `commands` 的发送规则之前，不支持的命令不会发出 |
| 段的 `comm_OK`、`work_OK`、`press_warning_F`、`press_alarm_F`、`pump_run`、`pump_change_F`、`flow_begin`、`flow_end`、`flow_diff` | derive |
| 段的 `flow_warning_trigger` / `flow_alarm_trigger`、变量 `press_SD_trigger`、`pre_stop_notice` | derive |
| 段的 `protect_F` / `hangon_AF` | derive：读段和所属线的 `flow_override`，线的是总闸，不改写段的 |
| 段的延时计数与 `flow_warning_F` / `flow_alarm_F`、倒计时 `countdown` | derive，按 tick 计数 |
| 压力动作、输差动作及其置位的 `autoStopCmd`、线的 `autoStopCmd`、`line_action_source`、线的 `action_section_ID`、生成动作记录 | act |
| 段的 `action_F`、`stop_pumps` | derive |
| 段的 `stop_pumps` 变化时向带泵执行器下发 `stop_pumps` / `cancel_stop` | act |
| 段、线的 `pump_run` 下降沿清除 `autoStopCmd` / `manStopCmd` | act |
| 线的 `pump_run`、`alarm_F`、`pre_stop_notice` | derive |
| 动作记录 `index` 变化时装载对应记录（为 -1 时清空时间，越界时恢复原值） | act |
| 各种状态变化的日志 | 事件处理器（第 8 节） |

`section_loop` 现在的处理顺序本身就是扫描式的，拆分为上表中的若干规则后，规则之间的顺序由排序决定，规则内部的判定条件不变。

拆分后在规则之间传递、又不属于 tdata 的中间量，登记为段的变量（7.1 节）：

| 变量 | 写入者 | 读取者 |
| --- | --- | --- |
| `press_SD_trigger` | 压力联锁触发的 derive 规则 | 压力动作 |
| `countdown_expired` | 倒计时的 derive 规则：`pre_stop_notice` 成立且计时超过 `action_time` | 输差动作 |
| `press_action` / `flow_action` | 压力动作 / 输差动作 | `action_F` 的 derive 规则、动作记录 |

执行器的参数在两个方向上复制：`write_paras` 把命令块的参数复制到节点 tdata 再写入执行器；连接后的参数刷新和 `read_paras` 把节点 tdata 的参数复制到命令块；`comm_OK` / `work_OK` 还读节点 tdata 的 `delay_protect_time`。这构成环，由读节点参数的一方用 `reads_previous` 打断（7.4 节）：节点参数来自执行器，读上一次扫描结束时的值只晚一次扫描；`write_paras` 必须读本次扫描的命令参数，因为 HMI 常在同一请求中先写参数、再写 `write_paras`。

与现状有差异、需要在迁移时确认的两点：

- 延时改为按 tick 计数后，`delay_protect_time` 的实际延时以 `MAIN_PERIOD` 为步长，最多比现在的 `setTimeout` 晚一个周期。
- 现在 `io_error` 的延时定时器不会被取消，即使读取在延时内恢复，到期后仍会置一次 `work_OK = false`，再被下一次读取覆盖；改为计数后，读取恢复即清零计数，不再出现这次短暂的 false。

### 7.6 依赖声明的核对

依赖靠显式声明，漏写读取键会导致排序错误而不报错。为此提供测试模式下的核对：

- 数据层提供通用的访问追踪钩子 `set_access_tracer(tracer | null)`：设置后，原型访问器的 getter / setter 每次访问都调用 `tracer(tdata, name, "read" | "write")`；数据层只知道有这个钩子，不知道规则的存在；
- 调度器的测试模式设置钩子，把访问记入“当前规则”的实际读写集合；测试用例运行若干次扫描后，比较实际读写与声明：实际访问了但没有声明的 tag 视为错误；读组合字按展开后的组成位比较（7.1 节），写组合字本身就是错误。`scheduler.previous()` 从快照取值，不经过访问器，所以一个只在 `reads_previous` 中声明的 tag 被直接读取时，也报为错误（读到的是本次扫描的值）；
- 钩子只能追踪 tag，Binding 状态和变量不经过访问器，不在核对范围内；
- 立即检测模式下，规则的写入在规则执行中就发出事件，事件处理器中的访问会记在该规则名下。按第 8 节的约定，最终的事件处理器只写日志，所需的值取自事件参数，不产生额外的访问；迁移期间尚未改写的处理器见 10.2 节。

运行时不设置钩子，访问器只多一次判断。没有采用“运行一遍自动推断依赖”的方式，因为 `&&`、`||` 短路和条件分支会使一次运行看不到全部读取。

## 8. 控制器中事件处理器的编码约定

这是控制器代码的约定，不是 TData / TTag 的限制：TData / TTag 不阻止任何写入。

- 联锁、汇总等派生逻辑写成规则，不写在事件处理器中，以保证同一次扫描基于同一份输入、结果与事件顺序无关；
- 事件处理器主要用于日志；处理器中写 tag 是允许的，写入会请求一次扫描，在下一次扫描中被规则读到；
- 需要异步操作的逻辑写成 act 规则：规则登记请求，Binding 记录完成状态并请求扫描，后续处理由规则读取完成状态完成（4.4 节）。

## 9. 规范需同步修改的条目

| 位置 | 现在 | 改为 |
| --- | --- | --- |
| 3.4 判断与保护的分工 | 无 | 新增一行：输入信号去抖由执行器完成；控制器不对执行器上报的值做去抖或滤波，按收到的值处理 |
| 3.6 按名访问、变化事件 | 程序按名称读写 TTag 的值；无论来自执行器读入、HMI 写入还是程序赋值，都发出变化事件，事件在新值生效后发出；业务逻辑通过订阅事件实现联动 | 读写与事件保持不变，并指向 spec-data-api.md：任何时候都可以按名读写，值变化时发出事件，不受控制器调度方式限制。删去“业务逻辑通过订阅事件实现联动”，改为：控制器的汇总与联锁在每次处理中基于同一份输入求值，结果与事件到达顺序无关 |
| 3.6 组合字联动 | 与其中各位双向联动 | 不变（组合字与各位共用同一块数据，联动自然成立） |
| 5.5 对上接口 | HMI 的写入会立即触发相应的状态变化处理 | 不变 |
| 6 性能与时序 | 状态汇总带 50 ms 防抖，命令发送带 100 ms 防抖 | 删除该条；改为：执行器数据读回、HMI 写入和通信状态变化后立即处理，由此产生的命令立即发出，不设防抖；延时、倒计时和通信中断延时按主循环周期累计 |

## 10. 过渡形态

迁移分多步进行，每一步结束时测试全部通过、对外行为不变或只有第 9 节所列的时序变化。为此控制器在迁移期间采用以下过渡方式，迁移完成后结束。

### 10.1 立即检测模式下的迁移

控制器始终使用立即检测模式（3.3 节）。在派生逻辑全部改为规则之前，现有事件处理器依赖“赋值后立即收到事件”，立即模式正好满足：

- 按名赋值、Unit_Map 经原始写入方法写入后，都立即检测；Binding 装载后，在扫描的发布阶段检测；
- tdata 的 `on_write` 接到 `request_scan()`，所以立即模式下的写入（包括 HMI 写入）在检测之后也请求一次扫描，派生量改为规则后，规则随之重新计算；
- 处理器在事件中再次赋值时，嵌套的检测只登记，等当前一轮报告完再比对一轮，直到没有新变化；连续 16 轮仍有新变化时抛出异常，防止振荡；
- 规则中的边沿判断使用扫描快照（5.3 节）。

立即检测模式下的事件顺序与原来相比有两处差异，确认项 0.2 已确认没有处理器依赖它们：

- 原来写入哪一方，哪一方的事件先发出，另一方随后由 `check_coupling` 补发；现在按布局顺序发出，组合字在前、组成位在后；
- 原来处理器中再写 tag 时，嵌套的事件立即发出；现在在当前一轮变化报告完之后发出。

迁移完成后，控制器仍使用立即检测模式，不切换为延迟模式。

### 10.2 规则与事件处理器共存

扫描调度器和规则排序先于业务迁移上线。迁移期间：

- 已改写的派生量由规则计算，对应的事件订阅和 `debouncify` 包装同时删除；
- 尚未改写的仍由事件处理器计算，在立即检测模式下照常工作；
- 驱动事件回调和 `setTimeout` 延时在对应规则（7.5 节前三行）上线前保持现状；
- `section_loop` / `node_loop` 先作为粗粒度的 act 规则按现有顺序执行（不声明键，所以不参与排序检查，按声明顺序先段后执行器），拆分完成后删除；
- `section_loop` 的派生部分拆为规则后，剩下的动作部分与拆出的规则之间有先后要求：它读取输差报警标志和 `countdown_expired`，而 `action_F`、`stop_pumps` 读取它写的动作标志和 `autoStopCmd`。从这时起，剩下的粗粒度规则都声明读写的键，参与排序和检查；
- 尚未改写的事件处理器若由规则的写入引起（例如 `stop_pumps` 变化时向执行器下发命令），它们的访问会记在该规则名下（7.6 节）。依赖核对把这些访问列为已知例外，处理器改为规则时随之删除；
- 粗粒度规则只在周期 tick 的扫描中执行：原来的主循环每调用一次就按 `MAIN_PERIOD` 计时，在触发扫描中执行会使计时变快。规则用自己的 ticker 判断新的 tick（计数变化才执行）；为此启动时先做一次初始扫描，启动这些 ticker，第一次周期 tick 时它们即开始执行，与原来的 `setInterval` 时机相同。

## 11. 不在本次范围内

- 布局、点表、协议均不变。
- 驱动的连接建立与重连机制（`Base_Driver` 的 tick、`reconnect_time`、`connfailed_time`、各驱动库的自动重连）不变；只是连接事件不再直接改写 tag，而是记录为 Binding 状态（4.4 节）。
- design.md 第 11 节列出的未实现项不在本次处理（按执行器配置的命令屏蔽除外，见 7.5 节），但新结构需为其留出位置：`tlms check` 可直接调用规则排序检查。
