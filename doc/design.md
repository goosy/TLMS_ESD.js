# TLMS_ESD 设计说明（初稿）

> 本文根据现有代码（v0.6.1）整理，描述系统“怎么做”，即架构、数据结构、算法和内部机制。需求见 [spec.md](spec.md)。

## 1. 模块划分

| 路径 | 职责 |
| --- | --- |
| `src/cli.js` | `tlms` 命令行，解析参数，调用 pm2 或直接 `import('./main.js')`。 |
| `src/main.js` | 进程入口：校验布局，读取配置，构建控制器，提供按连接复用的真实驱动，启动 Modbus 服务端和主循环。 |
| `src/runtime.js` | `build_runtime`：为控制器创建 TData、挂到 `Unit_Map`、调用各 `*_init`，创建扫描调度器并声明全部规则，提供 `start` / `stop`。驱动由调用方经 `get_drivers` 提供。 |
| `src/gcl.js` | YAML 加载器（`yaml` 库，YAML 1.2），保留源码行号信息。 |
| `src/config.js` | 合并多份配置文档，填充默认值，建立名称与 ID 索引。 |
| `src/init.js` | `prepare_controller`：为选定的控制器构建运行时对象图。 |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | 执行器（节点）、段、线的初始化（事件绑定）、规则声明与周期处理。 |
| `src/action_record.js` | 动作记录：CSV 读写，以及基于 index 的浏览。 |
| `src/drivers/` | `Base_Driver`、`MTClient`（Modbus TCP 客户端）、`S7Client`、`createMTServer`（对上服务端，使用数据层的 vector），以及 IO 绑定 `binding.js`（tdata 与驱动之间的交换区、字节序和分组读写，第 3.4 节；不属于数据层）。 |
| `src/typed_data/` | 数据层（将来的组件，见 design-scan.md 1.1 节）：`TData` / `TTag`（带类型的缓冲区与变化事件）、`observer.js`（变化检测）、`structure.js`（结构展开与布局校验）、`layout.js`（YAML 布局文件的编译）、`codecs.js`（各类型的编解码）、`endian.js`（按条目的字节序转换）、`server.js`（`Unit_Map` 与对上服务端的 vector）、`types.js`（类型声明生成）。 |
| `src/layouts.yaml` | LINE、SECTION、NODE、COMMAND、RECORD 的布局描述。 |
| `src/layouts.js` | 编译 `layouts.yaml` 并导出这些布局。 |
| `src/layout_types.d.ts` | 由布局生成的类型声明（`pnpm gen:types`）。 |
| `src/util.js` | log4js 日志、`debouncify` / `debounce`、`Object.mixin`。 |
| `src/scan.js` / `src/rules.js` | 扫描调度器（`Scheduler`）与规则（`derive` / `act`、排序与启动检查、`Ticker`、`on_delay` / `off_delay`），见 design-scan.md 第 6、7 节；由 `runtime.js` 接入运行流程（第 2 节）。 |

## 2. 启动流程

1. `cli.js` 先 `process.chdir(--path)`，再执行以下之一：
   - `start`：`pm2 delete tlms_esd`，然后 `pm2 start main.js -- <controller>`，并设置 `TLMS=controller`，使日志不输出到控制台；
   - `debug`：改写 `process.argv[2]`，设置 `LOG_LEVEL=debug`，然后动态 import `main.js`。
2. `main.js` 调用 `read_config(process.cwd())`：
   1. `readdir` 列出工作目录下所有 `*.ya?ml`；
   2. 每个文件经 `GCL.load` 解析为 JS 对象；
   3. 每份文档经 `add_conf` 处理。
3. `add_conf` 把每类对象同时存进数组（`push`）和同一数组的属性（`[name]`，线 / 段 / 执行器另有 `[ID<id>]`），因此 `cfg_*` 既能遍历，也能按键查找。执行器的处理：
   - 解析 `pumps` 字符串；
   - 把 `modbus_server` / `s7_server` 规范化为带默认值的 `{data, commands, endian, ...}`；
   - 压力和温度限值缺省时，取量程上下限。
4. 全部文档合并后，用名称把线关联到控制器，把段关联到线（对象互相引用）。
5. `prepare_controller(name)`：
   1. 选出控制器（为空或 0 时取第一个）；
   2. 重新生成精简的运行时对象 `line` / `section` / `actuator`；
   3. 执行器的 `driver_info` 携带协议、地址和数据 / 命令区；
   4. 同时按首端、末端、泵站分别放入 `section.begin_nodes` / `end_nodes` / `pump_nodes`。
6. `run_controller`：
   1. 初始化动作记录；
   2. 调用 `build_runtime`（`runtime.js`）：把动作记录挂到 `unit_id.action_records`，按 线 → 段 → 执行器 的顺序创建 TData 并 `attach_unit`，再调用各自的 `*_init`；执行器的驱动由 `main.js` 的 `get_drivers` 按连接复用提供；
   3. 启动 Modbus TCP 服务端并等待其就绪；启动失败（如端口被占用）时记录错误并以退出码 1 退出，由 pm2 重启；
   4. `build_runtime` 创建扫描调度器（design-scan.md 第 6 节），登记全部 tdata、执行器的数据 Binding（输入分组为 `data_payload`）和只写的命令 Binding；对象图建好后，按执行器 → 段 → 线的顺序调用 `node_rules` / `section_rules` / `line_rules` 声明规则（第 5、6、7 节），再声明动作记录的规则（第 8 节）和各执行器的命令屏蔽规则（12.1 节），然后 `prepare()` 排序检查；
   5. 全部 tdata 使用立即检测模式，`on_write` 接到调度器的 `request_scan()`：任何写入（规则、事件处理器、HMI、异步回调）在检测之后都请求一次扫描（design-scan.md 3.3 节）；
   6. `runtime.start()` 先做一次初始扫描（算出全部派生量），再启动周期 tick（`MAIN_PERIOD = 500`）；规则出错经调度器的 `on_error` 写入日志。

## 3. 带类型数据层

TData（实例记作 tdata）与 TTag 的对外要求和术语见规范 3.6 节，本节说明实现。

### 3.1 布局定义（`src/layouts.yaml`）

- 布局描述是一个 YAML 1.2 文件：根键 `layouts` 映射布局名到条目列表；其余根键都是片段（如 `node_commands`、`node_parameters`、`node_status`），由条目按名称引用。
- 每个条目包含 `{ name, type, offset, init_value }`，可选 `length`、`comment`；`offset` 和 `length` 的单位都是位（bit），`length` 省略时由类型决定。
- 组合字与组成位只由一方给出 `init_value`（规范 3.6）：`build_structure` 展开时，组合字未给出则由组成位合成（未给出的位为 false），组合字给出则组成位的值从整字拆出；双方都给出时保留给出的值，由校验报告。现有布局都由组成位给出。
- `type` 取值（大小写不敏感）：`Bool`、`Byte`、`SInt`、`USInt`、`Int`、`UInt`、`Word`、`DInt`、`UDInt`、`DWord`、`Real`。
- `Word` 条目带 `coupling`（片段名或内联列表）时，表示由若干 Bool 组成的状态字或命令字；`is_combined: true` 表示整字与各位双向联动。coupling 内各项的 `offset` 相对于该字的起点。
- `{ includes: <片段名或内联列表>, offset }` 把一组公共条目（如 `node_parameters`）整体偏移后拼接进来，可加 `name_prefix`。
- `src/typed_data/layout.js#compile_layout(yaml_path)` 同步读取文件，解析片段引用（不存在或循环引用时报错），补全省略的 `length`，再对每个布局调用 `structure.js#build_structure` 展开为扁平的 `items`（计算结构总长 `length`，把 coupling 规范为名称数组）并校验，返回 `{ layouts, fragments }`。
- `src/layouts.js` 在加载时编译同目录的 `layouts.yaml`（路径按模块位置解析；构建时 rolldown 配置中的复制插件把它作为独立文件输出到 `main.js` 同目录，不打进 `main.js`），导出 `LINE`、`SECTION`、`NODE`、`COMMAND`、`RECORD` 和参数块条目 `node_parameters`；布局不合法时逐条写入错误日志并退出。
- 每个布局编译为一个 Layout（`layout_of`）：除展开后的 `name`、`length`、`items` 外，还有按名称索引的条目表 `entries`（字节偏移、位掩码、编解码）、字节到 tag 的反查表 `tags_at_byte` 和该结构专用的 TData 子类 `Data_Class`。
- Bool 的定位规则：`byte = offset >> 3`，`bit = offset % 8`。内部缓冲按大端存放，一个字的第一个字节是寄存器的高字节，所以 coupling 中偏移 8–15 对应寄存器的 bit0–7，偏移 0–7 对应 bit8–15。定义文件按 8–15、0–7 的顺序列出，就是按寄存器 bit0 到 bit15 的顺序排列；字值的第 k 位即寄存器 bit k，`0xB1` 掩码按这个位号计算。
- [spec-modbus.md](spec-modbus.md) 中的点表就是按上述规则从这些定义计算出来的。
- 组合字的位号完全由上述偏移编号保证，`buffer` 中组合字与其他多字节类型一样按大端存放；对上服务端和驱动都不为组合字单独交换字节（规范 3.6）。
- 这些布局就是 Modbus 寄存器表和执行器数据区的内存映像，修改任何偏移都属于协议变更。
- 写入所有权（规范 3.6）目前靠人工审查保证：布局中没有标注 TTag 由谁写入，校验不检查这一规则。现有写入路径都符合：命令块的 ID、命令字、参数块和节点 tdata 的参数块由控制器写入，均按字对齐且连续；节点 tdata 的其余部分由执行器写入，控制器只读。

#### 布局校验

规范 3.6 的布局规则在布局阶段集中校验，不分散到 TData、TTag 和 Binding 的运行时：

- 由 `structure.js` 提供 `validate_structure(data_struct)`，对 `build_structure` 展开后的扁平 `items` 做校验，返回违规描述的数组（空数组表示合法），不在发现第一个错误时退出。
- 校验内容：
  - 名称：`items` 中名称重复；名称与 TData 的成员（`TData.prototype` 上的方法、getter，以及 `name` 等实例字段）冲突。
  - 类型与长度：`type` 不在支持的类型中；`length` 与类型不符（Bool 1，Byte / SInt / USInt 8，Int / UInt / Word 16，DInt / UDInt / DWord / Real 32）。
  - 对齐：非 Bool 的 `offset` 必须是 8 的倍数；多字节类型的字节偏移必须是偶数。
  - 重叠：把非 Bool 条目按字节区间排序后检查相邻区间是否相交；Bool 按 `offset` 检查是否重复占用同一位；Bool 落在某个非 Bool 区间内时，要求该 Bool 的 `coupling` 包含这个非 Bool 条目的名称。
  - 组合字：带 `coupling` 的条目，其每个组成位的 `offset` 都在 `[offset, offset + length)` 内。
  - 总长：`length % 16 === 0`。
  - `init_value` 的类型与取值范围与 `type` 相符（Bool 为布尔值，其余为该类型可表示的数）。
  - 组合字与它的组成位都给出了 `init_value`。
- `build_structure` 遇到重名时不再静默跳过，而是保留条目，交给校验报告。
- 调用方：
  - `compile_layout` 对文件中的全部布局调用校验，有违规时抛出包含全部违规项的错误；控制器加载 `src/layouts.js` 时据此逐条写入错误日志并退出；
  - `tlms check` 对全部结构调用校验，与配置校验的错误一起报告（未实现，见第 11 节）。
- 校验通过后，TData、TTag、Binding 不再重复做这些检查；`layout_of` 只保留防御性断言。

主要布局（字节偏移）：

| 结构 | 关键 TTag |
| --- | --- |
| NODE | 0 ID；2 status；4 temperature；8 pressure；12 flowmeter；16 response_code；18 起为参数块 |
| COMMAND | 0 response_code（弃用）；2 overtime（弃用）；6 extra_commands（`has_commands`、`reset_paras`）；16 ID；18 commands；20 起为参数块 |
| SECTION | 0 ID；2 upward_input（保留）；4 status；6 flow_begin；10 flow_end；14 flow_diff；18–34 限值与延时；38 countdown；40 inner_word（内部触发位） |
| LINE | 0 status；2 ID；4 action_section_ID；6 flow_diff（保留） |
| RECORD | 0–10 时间；12 section_ID；14–36 流量与压力；42–48 执行器 ID；50 status；52 index |

### 3.2 TData

- `name` 可写；`layout`、`size`、`buffer` 只读（只有 getter，赋值抛出 `TypeError`），`buffer` 的内容可以读写。
- `buffer`：内部值缓冲区，统一按大端（BE）存放。TData 不再持有与驱动交换的缓冲区，那属于 IO 绑定（3.4 节）。
- 原始写入方法 `write_register(offset, value)`、`write_bit(offset, mask, value)`、`write_bytes(offset, source)` 以字节偏移定位，写入后的处理与按名写入相同（立即模式下先检测，然后调用 `on_write`），供对上服务端使用。
- `new TData(struct, name)` 返回该结构编译出的子类 `Data_Class` 的实例；每个 tag 的访问器只在 `Data_Class.prototype` 上定义一次，同一结构的实例共用：
  - getter 用编解码表直接从 `buffer` 解码；
  - setter 用编解码表写入 `buffer`，再调用 `after_write`：立即检测模式下由 Observer 立即检测变化；然后在两种模式下都调用创建时传入的 `on_write(tdata)`。
- `new TData(struct, name, { detection, on_write })`：`detection` 为 `"immediate"`（默认）或 `"deferred"`（spec-data-api.md 4.2 节）。控制器全部使用立即模式（design-scan.md 3.3 节）。
- 组合字与它的组成位共用同一块字节，写任何一方，另一方读到的自然是新值，不需要额外联动。
- 变化检测由每个 TData 的 Observer（`observer.js`）负责：它持有 `buffer` 的快照，比对时只对变化的字节解码相关 tag（字节反查表 `tags_at_byte`），旧值从快照解码，不缓存任何值；比对后更新快照，再按布局顺序报告变化。
  - 每个变化先由 TData 发出 `change(tagname, old, new)`，再由该 tag 的句柄发出 `change(old, new)`；事件总在新值生效之后发出。业务逻辑通过 `data.get(name).on('change', ...)` 订阅。
  - 事件处理器中再写 tag 时，嵌套的比对只登记，等当前这一轮变化报告完再比对一轮；连续 16 轮仍有新变化时抛出异常，防止振荡。
  - `detect()` 做一次比对；外部直接改写 `buffer`（分组装载、`copy_from`）后由写入方调用，延迟模式下由使用方在需要时调用。
  - `observer.previous(name)` / `take_scan_snapshot()` 供扫描调度器使用（design-scan.md 5.3 节）。
- `set_access_tracer(tracer | null)`（`layout.js`）：设置后，访问器每次读写 tag 都调用 `tracer(tdata, name, "read" | "write")`，供调度器的依赖追踪测试模式使用；未设置时访问器只多一次判断。
- TData 出错时抛出异常（布局冲突、值越界），不写日志、不退出。

### 3.3 TTag 与字节序转换

- `data.get(name)` 返回该 tag 的 `TTag`，首次访问时创建并缓存，名称不存在时返回 `undefined`。TTag 不持有值：读 `value` 从 TData 的 `buffer` 解码，写 `value` 与 `data[name] = v` 完全等价；`change` 事件由 Observer 发出。
- `endian.js` 按布局条目实现设备字节序与内部大端之间的转换（`load_entry` / `store_entry` / `io_index` / `io_range`），不检测变化；IO 绑定按字节实现同样的映射（3.4 节），测试用 `endian.js` 作为对照核对两者逐字节一致：
  - 2 字节：`BE` 原样复制；`LE` / `little` / `BEBS` 交换两个字节；
  - 4 字节：支持 `BE`、`LE` / `little`、`BEBS`、`LEBS` 四种排列；
  - Bool 和单字节类型（Byte、SInt、USInt）只读写一个字节，不做字节内转换；它在 IO 缓冲区中的下标按 16 位寄存器换算：`LE` / `little` / `BEBS` 时为 `byte ^ 1`，`BE` / `LEBS` 时为 `byte`。Bool 按位掩码只改自己的位。

### 3.4 IO 绑定（`src/drivers/binding.js`）

- `new Binding(data, driver, { start, remote_start, length, endian, on_update }, ...extras)` 把 tdata 的交换区 `[start, start + length)` 对应到远端 `remote_start` 起的同长度区域；`extras` 原样传给驱动（Modbus 为 `unit_id`，S7 为 `area, db`）。交换区三项参数必须是驱动写入单元 `driver.write_unit` 的整数倍，否则抛出异常，保证扩展后的写区间不越出交换区，且本地写入单元与远端写入单元对齐。
- Binding 持有按设备字节序存放的 `IO_buffer`（与 tdata 同长、同下标），驱动读入的数据只写入它。
- 字节映射 `io_index`：创建时为 tdata 的每个字节算出它在 `IO_buffer` 中的下标。4 字节条目按 `BE`、`LE` / `little`、`BEBS`、`LEBS` 四种排列换算；其余字节按 16 位寄存器换算：`LE` / `little` / `BEBS` 时为 `byte ^ 1`，`BE` / `LEBS` 时不变。
- `create_group(...names)` 返回一组需要一起与设备同步的 tag（`Binding_Group`）：
  - 名称不存在、tag 落在交换区以外时抛出异常；同一 tag 重复添加时忽略；
  - 所有权掩码 `own`：组内每个字节中属于本组的位，非 Bool 条目为整个字节，Bool 只是它自己那一位；
  - 写区间：组内字节在 `IO_buffer` 中的位置向外扩展到写入单元，相邻的写入单元合并。
- 读：`request_read()` 把整个交换区读入 `IO_buffer`，置 `fresh`；正在进行的读取被共享，不重复发起。`load(group)` 按掩码只装载本组的位，组外的位（如由控制器维护的 `comm_OK`）保持不变。
- 写：`request_write(group)` 登记写请求，同一分组多次登记只写一次；`flush_writes()` 按掩码把本组的位导出到 `IO_buffer`，再按写区间逐段调用驱动写入，并把区间长度一并传给驱动。区间内不属于本组的位取自最近一次读入的值；按写入所有权规则，这些字节也由控制器写入，不会覆盖执行器的数据。
- 驱动未连接时不读不写，写请求保留到下一次 `flush_writes()`。
- 状态：`connected`（随驱动的 `connect` / `connfailed` 事件更新）、`read_ok`（最近一次读取是否成功）、`write_done(group)`（每个分组最近一次写入的序号和结果）；新数据到达或状态变化时调用创建时传入的 `on_update(binding)`。目前这些状态只记录，尚未使用。
- 便捷方法（目前只有测试使用）：`group.read()` 读取、装载并立即检测；`group.write()` 登记并立即写出；`group.copy_from(source)` 按同名 tag 复制值，全部复制完后做一次检测，用于在 data 与 command 之间同步参数块。

## 4. 驱动

### 4.1 Base_Driver

- 以 `Object.mixin(this, new Base_Driver())` 的方式混入：只补充子类缺少的属性，判断时包含原型链，因此既不覆盖子类自己定义的 `start_tick` 等，也不遮蔽从驱动库继承的 `connect` / `disconnect`。
- `stop()` 停止定时器并调用库的 `disconnect()`（两个库在显式断开后都不再自动重连）；之后再 `start()` 时先调用 `connect()` 重新连接。
- `start()` 每 `period_time`（1000 ms）执行一次 `start_tick`，已连接时发出 `tick`。
- `emit_io_ok` / `emit_io_error` 包装每次读写的结果：
  - 首次出错时发出 `io_error`，出错后首次成功时发出 `io_ok`（不用 es-modbus 自带的逐事务 `data_error` 事件名，避免与之混淆）；
  - 若 `connfailed_time`（5000 ms）内一直没有成功的读写，就调用 `on_error`，进而发出 `connfailed`；
  - `connfailed` 和 `io_error` 的参数是错误消息字符串（库给出 `Error` 时取其 `message`）。
- `reconnect_time` 只表示重连间隔，`connfailed_time` 只表示上面的升级时长，两者分开配置。驱动构造时的第二个参数 `options` 可传入 `period_time`、`reconnect_time`、`connfailed_time`（Modbus 另有 `reconnect_max`）；控制器不传，用默认值。
- 驱动实例按连接参数复用：
  - Modbus 按 `host:port`；
  - S7 按 `host:port rack slot`；
  - 同一驱动多次 `start()` 不会重复建立定时器。

### 4.2 MTClient（es-modbus）

- 地址换算：配置和 TData 中的区域都以字节计，字节起点 `start` 对应保持寄存器 PDU 地址 `start >> 1`（0 基），长度为 `length >> 1` 个寄存器；以 es-modbus 的结构化范围 `[func_code, pdu_addr, length]` 传入，不使用 Modicon 写法。
- es-modbus 对非法参数（范围、数量上限、unit_id）同步抛出；`read` / `write` 捕获后记录错误日志，并按读写失败处理（`emit_io_error`）。
- 只访问保持寄存器：功能码由 MTClient 显式给出，03 读，06（单个寄存器）/ 16（多个寄存器）写。不使用线圈、离散输入和输入寄存器。
- `write_unit = 2`：写入单元为一个寄存器。
- 写入的回显检查：es-modbus 的 `write()` 以“响应是否回显了请求”兑现。回显不符视为写入未确认：记录警告，按读写失败处理（`emit_io_error`），`write` 返回 `false`。
- 断线重连使用 es-modbus 自带的机制，`start_tick` 被重写为只发出 `tick`：
  - 重连间隔从 `reconnect_time`（5000 ms）开始，每次失败加倍，最长 `reconnect_max`（20000 ms），连接稳定后回到初值；
  - 连续 3 次请求超时（es-modbus 的 `max_timeouts` 默认值）视为死链，关闭连接并照常重连；连接断开时所有挂起的请求以 `connection lost` 失败。

### 4.3 S7Client（@st-one-io/nodes7）

- 通过 `readArea` / `writeArea` 读写 `DB` 或 `M` 区，起点与长度都以字节为单位。
- `write_unit = 1`：写入单元为一个字节。
- 由于 `S7Endpoint.connect()` 不完善，暂时使用库自带的自动重连（`autoReconnect`，取 `reconnect_time`，默认 5000 ms，间隔固定），`start_tick` 同样被重写（代码中已标记为临时代码）。

### 4.4 对上服务端（createMTServer + Unit_Map）

- `Unit_Map` 和 `create_vector(unit_map, { logger })` 属于数据层（`src/typed_data/server.js`）。vector 中访问未映射地址的警告经注入的 `logger` 输出，缺省不输出；`createMTServer`（驱动）传入项目的日志器，用 vector 创建 es-modbus 服务端。测试直接调用 vector 模拟 HMI 请求。

- `Unit_Map.attach_unit(unit_id, tdata, start)` 把 TData 挂到某个单元的字节区间 `[start, start + size)`，一个单元可以挂多个 TData。
  - 执行器单元：data 挂在字节 0，command 挂在字节 400（即寄存器 200 起）。
- 寄存器 `addr` 对应字节 `addr * 2`，按大端读 `tdata.buffer`；线圈 `addr` 对应字节 `addr >> 3` 的第 `addr % 8` 位。
- 写入经 TData 的 `write_register` / `write_bit`，由 TData 按检测模式处理（目前为立即检测），vector 不直接改写 `buffer`。
- vector 方法名为 es-modbus 要求的 snake_case：`get_holding_register`、`get_input_register`、`set_register`、`get_coil`（同时用于 FC 1 和 FC 2）、`set_coil`。
- 未映射的地址（例如执行器单元中节点数据区与命令块之间的空档）读为 0 / false，写入被忽略，因此 HMI 跨越空档的整块读取仍能成功。每个（类型、单元、地址）只记录一次警告，避免轮询时刷屏。
- 请求由 es-modbus 先行校验：未登记的单元号应答异常 0x0B，非法功能码、数量或地址越界应答 0x01 / 0x03 / 0x02；vector 抛出异常时应答 0x04，并通过 `vector_error` 事件记录日志。

## 5. 执行器处理（`node_proc.js`）

### 5.1 IO 绑定

每个执行器的 data 和 command 各有一个 Binding（3.4 节），保存在 `actuator.data_binding` / `actuator.command_binding`。

- data：
  - 绑定整块结构，远端起点为 `driver_info.data.start`；
  - `data_payload` 包含 ID、状态位、测量值、`response_code` 和参数块（不含 `comm_OK`，它由控制器自己维护）；
  - `data_parameters` 只包含参数块。
- command：
  - 从本地字节 16 开始绑定（跳过 0–15 的本地区），远端起点为 `driver_info.commands.start`；
  - `commands_payload` 包含 ID、commands 和参数块。

### 5.2 读取与写入

- 执行器数据的读取由扫描完成：周期 tick 的扫描在输出阶段发起读取，数据到达后 Binding 的 `on_update` 请求扫描，在输入阶段装载 `data_payload`，在发布阶段检测变化。
- 命令 Binding 只写不读（design-scan.md 6.5 节）：规则登记写入，扫描的输出阶段写出；写入完成后 `on_update` 请求扫描。驱动未连接时写请求保留，连接恢复后写出。
- 驱动事件只记日志；连接和读取结果由 Binding 记为 `connected` / `read_ok`，供规则读取。

### 5.3 规则（`node_rules`）

| 规则 | 处理 |
| --- | --- |
| `comm_OK`（derive） | `off_delay(connected, delay_protect_time)`：已连接时为 true，断开后保持 `delay_protect_time` 再变为 false；从未连上时，启动后保持同样时长 |
| `work_OK` | `off_delay(read_ok, delay_protect_time)` 为 false，即读取持续失败超过 `delay_protect_time` 时置 false；读取成功后由装载恢复执行器上报的值 |
| 参数刷新 | `connected` 上升沿开始计时，满 2 s 时把节点 tdata 的参数复制到命令块；其间断开则停止 |
| `stop_pumps` 收回（带泵执行器） | `pump_run` 下降沿时清除命令块的 `stop_pumps` |
| 应答握手 | `response_code` 变化且不为 0 时，`response_code` 中置 1 的位，命令块中同名的命令位逐位清除，并清除 `executing` |
| `pressure_SD_F` | 变化时清除对应的允许或禁止命令位 |
| `read_paras` | 上升沿时把节点 tdata 的参数复制到命令块，并复位该位 |
| `write_paras` | 上升沿时把命令块的参数复制到节点 tdata，登记写入 `data_parameters`；写入完成（`write_done` 的序号到达）后复位该位 |
| `has_commands`（derive） | `commands` 不为 0 |
| 发送 | `commands` 变化时，或 `response_code` 变化且不为 0 时（让执行器看到已应答的位被清除），登记写入 `commands_payload` |
| 重发 | `has_commands` 持续超过 3 个 tick 后，每个 tick 再登记一次写入；每个执行器单独计时 |

- `write_paras` 把命令块的参数写入节点 tdata，而参数刷新、`read_paras` 把节点 tdata 的参数复制到命令块，`comm_OK` / `work_OK` 读节点 tdata 的 `delay_protect_time`，形成环。后者读节点参数在上一次扫描结束时的值（`reads_previous`）打断这个环：节点参数来自执行器，晚一次扫描没有影响；`write_paras` 则必须读本次扫描的命令参数，HMI 常在同一请求中先写参数、再写 `write_paras`。
- 规则只写命令位，不写 `commands` 整字（design-scan.md 7.1 节）。
- `pump_run` 以执行器上报的值为准（执行器已对各泵的状态做“或”运算），控制器不再计算。
- 状态变化只记日志；向段的汇总由段的规则完成（第 6 节）。

## 6. 段处理（`section_proc.js`）

### 6.1 事件处理（`section_init`）

- 写入段的 ID、名称和输差参数（`flow_diff_WH` 等、`action_time`）。
- 状态变化（`action_F`、报警、挂起、`pre_stop_notice` 等）只记日志。

### 6.2 规则（`section_rules`）

段的变量和规则在对象图建好之后声明（design-scan.md 7.4 节）。段对象上的变量（不是 TTag，见规范 3.6）用 `add_var` 登记：

- `press_SD_trigger`：压力联锁条件；
- `countdown_expired`：倒计时结束；
- `press_action` / `flow_action`：压力动作和输差动作。

derive 规则，每次扫描都执行，规则之间的顺序由排序决定：

| 规则 | 计算 |
| --- | --- |
| `comm_OK`、`work_OK` | 首末端全部执行器的“与” |
| `press_warning_F` / `press_alarm_F` | 首末端执行器 `pressure_WH_F` / `pressure_AH_F` 的“或” |
| `pump_run`、`pump_change_F` | 带泵执行器同名属性的“或” |
| `flow_begin` / `flow_end` | 首端 / 末端执行器 `flowmeter` 之和 |
| `flow_diff` | `flow_begin - flow_end` |
| 触发位 | `flow_warning_trigger = flow_diff > flow_diff_WH`，`flow_alarm_trigger` 同理 |
| `press_SD_trigger` | 首末端执行器 `pressure_AH_F && pressure_SD_F` 的“或”，变化时记日志 |
| 保护状态 | `protect_prereq = comm_OK && work_OK && !pump_change_F`；`protect_F = protect_prereq && !flow_override && !line.flow_override`，即本段与所属线的 `flow_override` 任一为真则不保护；`hangon_AF = !protect_prereq` |
| `flow_warning_F` / `flow_alarm_F` | 各一条规则：`on_delay(ticker, 触发位, *_delay)` |
| `pre_stop_notice` | `flow_alarm_F && line.pump_run && protect_F`：泵运行条件取线的（规范 5.2），`stop_pumps` 和压力动作仍取本段的 |
| 倒计时 | `pre_stop_notice` 为真时计时，`countdown = (action_time - elapsed) / 1000`；结果小于 0 时 `countdown` 置 0，`countdown_expired` 为真 |
| `action_F` | `press_action \|\| flow_action` |
| `stop_pumps` | `(段 auto/man \|\| 线 auto/man) && pump_run` |

`pre_stop_notice` 读线的 `pump_run`，线的 `pump_run` 又汇总各段的 `pump_run`；排序后它们在同一次扫描中依次算出，不再需要线的变化事件补算。

### 6.3 联锁动作

act 规则，每次扫描都执行：

1. 停泵命令复位：`pump_run` 下降沿时清除段的 `autoStopCmd` / `manStopCmd`。它在压力动作之前声明，两者都写 `autoStopCmd`，按声明顺序排列。
2. 压力动作（变量 `press_action`）：
   - `press_SD_trigger && pump_run` 时置位，同时置位段的 `autoStopCmd`。不检查 `protect_F`，所以不受挂起约束；
   - 否则在 `pump_run && !autoStopCmd` 时复位：本段泵在运行（必然是停泵后重新启动的），联锁条件已消失。
3. 输差动作（变量 `flow_action`）：
   - `countdown_expired` 时置位，同时置位线的 `autoStopCmd` 和本段的 `line_action_source`；
   - 否则先执行 `line_action_source &&= line.autoStopCmd`，再在 `line.pump_run && !flow_alarm_F && !line_action_source` 时复位。泵运行条件取线的，与停泵预告一致，否则没有泵的段永远无法复位。
4. 复位条件每次扫描都判断，不锁存；停泵期间两个泵运行条件都不成立，所以动作状态保留到泵重新运行。
5. 动作记录：任一动作变量出现上升沿时，把线的 `action_section_ID` 设为本段 ID，并调用 `add_action_record()` 生成一条记录；同一次扫描两者同时发生只生成一条。两个动作变量都为 false 且线的 `action_section_ID` 等于本段 ID 时，把它清零，避免抹掉其他段的动作。
6. 泵命令：段的 `stop_pumps` 变化时，为真则对每个带泵执行器设置 `command.stop_pumps = node.data.pump_run`；为假则设置 `stop_pumps = false` 和 `cancel_stop = true`。

v0.7.0 调整段的布局时，计划把 `press_action` / `flow_action` 升级为 TTag，届时动作记录改由它们的变化事件触发，不再在动作记录规则中判断上升沿。

## 7. 线处理（`line_proc.js`）

- 规则（`line_rules`，derive）：
  - `pump_run`、`pre_stop_notice`：取各段同名属性的“或”；
  - `alarm_F`：取各段 `flow_alarm_F` 与 `press_alarm_F` 的“或”。
- 线的 `flow_override` 只记日志，不改写任何段；其作用在段的 `protect_F` 规则中以与运算体现（见 6.2 节）。
- act 规则：`pump_run` 下降沿时，清除线的 `autoStopCmd` / `manStopCmd`。

## 8. 动作记录（`action_record.js`）

- CSV 列取自 RECORD 中除 Word 类型和 `index` 以外的 TTag。
- 启动时：
  1. 文件不存在就写入表头；
  2. 流式读取全部行，用 `unshift` 保留最近 `records_size` 条，最新的在前；
  3. 对各列做类型还原。
- `add_record()`：
  1. 写入当前时间；
  2. 把记录放到内存列表头部；
  3. 设置 `index = 0`；
  4. 用 `appendFile` 追加一行。
- `index` 由一条 act 规则处理（`action_record_rule`），在全部段的规则之后声明；规则在闭包中记住当前显示的记录：
  - `index` 与当前显示的不同时：为 -1 时清空时间 TTag；否则把对应记录装载到 data，越界时恢复为原值。
- 记录内容由段的 `add_action_record()` 在压力动作或输差动作发生时填写（见 6.3 节）；`press_action` / `flow_action` 取段的动作变量；执行器位置的对应规则见第 11 节。

## 9. 日志

- log4js 有两个 category：
  - `default`：写入 `logs/info.log` 和 `logs/error.log`（按天滚动，单文件上限 10 MB，压缩）；`TLMS !== 'controller'` 时还输出到控制台；
  - `console`：只输出到控制台。
- `logger` 是一个可切换 category 的包装对象。

## 10. 运行环境、依赖与构建

### 10.1 运行环境与进程管理

- 运行环境：Node.js，源码为 ES 模块（使用 `import ... with { type: 'json' }`、`import.meta.dirname`）。
- 后台运行借助 pm2（peer 依赖）：
  - `tlms start` 先执行 `pm2 delete tlms_esd`，再用固定进程名 `tlms_esd` 执行 `pm2 start`，因此同一时间只有一个实例；
  - `stop`、`list`、`log`、`flush` 分别对应 `pm2 delete`、`pm2 list`、`pm2 log`、`pm2 flush`；
  - pm2 启动时设置 `TLMS=controller`，日志模块据此关闭控制台输出。

### 10.2 依赖库

| 库 | 用途 |
| --- | --- |
| `es-modbus` | Modbus TCP 客户端（连接执行器）和服务端（对 HMI） |
| `@st-one-io/nodes7` | S7 客户端（连接执行器） |
| `yaml` | 配置与布局解析（YAML 1.2） |
| `csv-parser` | 读取动作记录 CSV |
| `log4js` | 日志 |
| `mri` | 命令行参数解析 |

### 10.3 开发工具

- 包管理：pnpm。
- 测试：`node --test`。
- 代码检查：ESLint 加 `@stylistic/eslint-plugin`（`eslint.config.js`，`pnpm lint`），JS 用 tab 缩进。ESLint 查找代码问题，@stylistic 只规范空白、引号、分号等，不重新折行，手工对齐的布局表得以保留。不使用会重新折行的格式化工具（Biome、Prettier）。另外禁止使用与 `Number` 命名空间等价的全局量（`isNaN`、`isFinite`、`parseInt`、`parseFloat`、`NaN`、`Infinity`），改用 `Number.isNaN` 等。

### 10.4 构建与发布

- `rolldown.config.js` 生成两个 ES 模块包：
  - `src/main.js` → `./main.js`；
  - `src/cli.js` → `./cli.js`，其中 `./main.js` 设为 external，所以 `cli.js` 运行时 import 的是同目录下的打包产物。
- `package.json` 的 `prepare` 脚本会触发构建；`bin.tlms` 指向 `cli.js`。

## 11. 未实现项

规范已有要求、但当前代码尚未实现的内容：

| 项 | 规范要求 | 代码现状 | 涉及位置 |
| --- | --- | --- | --- |
| ID 唯一性校验 | 线、段、执行器的 ID 全局互不相同（跨类型），同一对象的多个 tdata 共用 ID（规范 4.1） | `config.js` 只校验执行器 `id` 为非零数字；线、段、执行器各自按 `ID<id>` 建索引，重复或跨类型相同都不报错，同类型重复时后者静默覆盖前者 | `config.js` 的 `add_conf` |
| ID 作为对上单元号 | 线、段、执行器的 Modbus 单元号直接取各自的 ID（不小于 1），动作记录固定为单元号 0，控制器配置中不再有 `unit_id`（规范 4.1、5.5） | `build_runtime` 按名称从 `controller.modbus_server.unit_id[name]` 查单元号（动作记录查 `unit_id.action_records`），每个对象都要在控制器配置中逐项列出 | `runtime.js` 的 `build_runtime` |
| 配置检查命令 | `tlms check` 读取并校验配置和全部布局（3.1 节 `validate_structure`）、报告全部错误，不启动控制器（规范 3.6、5.6） | 无此命令；配置错误只在启动时发现，且多数直接退出或崩溃；布局校验已在启动时执行（`main.js`），尚未接入命令行 | `cli.js`；`config.js` 需拆出可单独调用、收集全部错误的校验函数 |
| 动作记录按位置对应执行器（现有代码有缺陷） | 节点 1–4 按先首端、后末端的顺序依次对应动作段的执行器，每个位置的压力、ID、泵运行状态取自同一个执行器（规范 5.4） | 节点 1–3 固定取 `begin_nodes[0..2]`，节点 4 固定取 `end_nodes[0]`；`node1..3_pump_run` 取自 `pump_nodes[0..2]`（只含带泵执行器，与节点位置可能错位），`node4_pump_run` 从不赋值 | `section_proc.js` 的 `add_action_record` |

## 12. 命令处理

所有命令都走 5.3 节的通用握手（发送命令字，收到 `response_code` 后清除对应位）；部分命令另有控制器本地处理：

| 命令 | 命令字位 | 控制器处理 |
| --- | --- | --- |
| `stop_pumps` | 0 | 由段的 `stop_pumps` 置位；执行器泵运行状态变为 false 时收回 |
| `cancel_stop` | 1 | 段的 `stop_pumps` 撤销时置位，让执行器解除停泵输出 |
| `horn` / `reset_horn` | 2 / 3 | 通用握手 |
| `enable_pressure_SD` / `disable_pressure_SD` | 4 / 5 | 通用握手，另在 `pressure_SD_F` 变化时清除 |
| `read_paras` | 6 | 本地处理（执行器参数复制到命令块），不需要发送 |
| `write_paras` | 7 | 本地处理：把参数直接写入执行器数据区，完成后复位 |
| `enable_pressure_alarm` / `disable_pressure_alarm` | 8 / 9 | 通用握手 |
| `enable` / `disable` | 10 / 11 | 通用握手 |
| `reset_CPU` / `reset_conn` | 12 / 13 | 通用握手 |

### 12.1 命令屏蔽

依据各执行器配置的 `supported_commands` 屏蔽命令（规范 5.1）：

- 解析：`config.js` 解析执行器时，把 `supported_commands` 数组转换为一个 16 位屏蔽字 `command_mask`。数组中每个命令名按命令枚举（`node_commands`）查出命令字位号 k，屏蔽字的第 k 位置 1；位号与寄存器 bit 一致（见 3.1 节）。
- 校验：数组中出现命令枚举以外的名称时，视为配置错误，启动时报错退出，与执行器 `id` 的校验方式一致。
- 省略字段时视为支持全部命令，`command_mask` 取命令枚举的全部位 0–13，即 `0x3FFF`。
- 使用：`command_mask` 随执行器对象带入运行时。每个执行器有一条屏蔽规则，每次扫描对 `command_mask` 中为 0 的命令位按名逐位复位；位 14（`reserve`）和位 15（`executing`）不是命令，不受影响。
- 屏蔽规则在全部规则之后声明：同一个命令位的多个写入者按声明顺序排列，所以它排在其他写命令位的规则之后；它写命令位，所以排在读 `commands` 的发送规则之前，不支持的命令位不会发出。

