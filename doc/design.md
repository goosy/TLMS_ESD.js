# TLMS_ESD 设计说明

> 本文描述系统“怎么做”，即架构、数据结构、算法和内部机制。需求见 [spec.md](spec.md)，Ldata / Ltag 的编程接口见 layout-data 包的 `doc/spec-data-api.md`。

## 1. 模块划分

| 路径 | 职责 |
| --- | --- |
| `src/cli.js` | `tlms` 命令行，解析参数，调用 pm2 或直接 `import('./main.js')`。 |
| `src/main.js` | 进程入口：读取配置，构建控制器，提供按连接复用的真实驱动，启动 Modbus 服务端和扫描。 |
| `src/runtime.js` | `build_runtime`：为控制器创建 Ldata、挂到 `Unit_Map`、调用各 `*_init`，创建扫描调度器并声明全部规则，提供 `start` / `stop`。驱动由调用方经 `get_drivers` 提供。 |
| `src/gcl.js` | YAML 加载器（`yaml` 库，YAML 1.2），保留源码行号信息。 |
| `src/config.js` | 合并多份配置文档，填充默认值，建立名称与 ID 索引，把执行器的 `supported_commands` 转换为命令屏蔽字。 |
| `src/init.js` | `prepare_controller`：为选定的控制器构建运行时对象图。 |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | 执行器（节点）、段、线的初始化（日志处理器、IO 绑定）与规则声明。 |
| `src/action_record.js` | 动作记录：CSV 读写。 |
| `src/action_record_proc.js` | 动作记录的规则：基于 index 浏览记录。 |
| `src/scan.js` | 扫描调度器 `Scheduler`（§5）。 |
| `src/rules.js` | 规则：`derive` / `act` 声明、排序与启动检查、`Ticker`、`on_delay` / `off_delay`（§6）。 |
| `src/drivers/` | `Base_Driver`、`MTClient`（Modbus TCP 客户端）、`S7Client`，以及 IO 绑定 `binding.js`（§4.5）。对上服务端来自 `modbus-emulator` 包（§4.4）。 |
| `layout-data`（外部包） | 数据层（§3）：`Ldata` / `Ltag`、布局编译与校验、变化检测、字节序转换。 |
| `src/layouts.yaml` | LINE、SECTION、NODE、COMMAND、RECORD 的布局描述。 |
| `src/layouts.js` | 编译 `layouts.yaml` 并导出这些布局和业务需要的片段。 |
| `src/layout_types.d.ts` | 由布局生成的类型声明（`pnpm gen:types`）。 |
| `src/util.js` | log4js 日志、`Object.mixin`。 |

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
   - 压力和温度限值缺省时，取量程上下限；
   - 由 `supported_commands` 算出命令屏蔽字 `command_mask`（§14.1）。
4. 全部文档合并后，用名称把线关联到控制器，把段关联到线（对象互相引用）。
5. `prepare_controller(name)`：
   1. 选出控制器（为空或 0 时取第一个）；
   2. 重新生成精简的运行时对象 `line` / `section` / `actuator`；
   3. 执行器的 `driver_info` 携带协议、地址和数据 / 命令区；
   4. 同时按首端、末端、泵站分别放入 `section.begin_nodes` / `end_nodes` / `pump_nodes`。
6. `run_controller`：
   1. 初始化动作记录；
   2. 调用 `build_runtime`（`runtime.js`）：
      1. 把动作记录挂到 `unit_id.action_records`，按 线 → 段 → 执行器 的顺序创建 Ldata 并 `attach_unit`，再调用各自的 `*_init`；执行器的驱动由 `main.js` 的 `get_drivers` 按连接复用提供；
      2. 创建扫描调度器（§5），登记全部 block、执行器的数据 Binding（输入分组为 `data_payload`）和只写的命令 Binding；
      3. 对象图建好后，按执行器 → 段 → 线的顺序调用 `node_rules` / `section_rules` / `line_rules` 声明规则（§7、§8、§9），再声明动作记录的规则（§10）和各执行器的命令屏蔽规则（§14.1），然后 `prepare()` 排序检查；
      4. 登记到调度器的 block，其 `write` 事件接到 `request_scan()`（§3.5）；
   3. 启动 Modbus TCP 服务端并等待其就绪；启动失败（如端口被占用）时记录错误并以退出码 1 退出，由 pm2 重启；
   4. `runtime.start()` 先做一次初始扫描（算出全部派生量），再启动周期 tick（`MAIN_PERIOD = 500`）；规则出错经调度器的 `on_error` 写入日志。

## 3. 数据层（layout-data 包）

Ldata（实例记作 block）与 Ltag 的术语和控制器对它们的要求见规范 §3.6，数据块自身的要求见 layout-data 的规范。数据层的实现在独立的 `layout-data` 包中：结构化、可响应、基于 buffer 的数据块，按名访问 tag，布局编译与校验，变化检测，设备字节序转换；它的规范和设计见该包的 `doc/spec.md`、`doc/spec-data-api.md`（编程接口）和 `doc/design.md`。本节只说明本项目如何使用它。

### 3.1 组件边界

- 本项目通过 `import ... from "modbus-emulator"` 取得 `layout-data` 的接口（`Ldata`、`Ltag`、`register_layout`、`get_layout`、`io_index_table`、`render_types` 及其类型）：modbus-emulator 转发这些接口，本项目不直接依赖 `layout-data`，进程里只有一份（`register_layout` 每个进程只能成功调用一次）；ESLint 禁止直接导入 `layout-data`。不再有 `src/typed_data/`；rolldown 构建时把 modbus-emulator 连同它依赖的 `layout-data` 打进 `main.js`；
- 该包不依赖本项目的配置、业务处理、布局和日志器，出错时抛出异常：`src/layouts.js` 捕获布局错误后写日志并退出；
- 对上服务端（`Unit_Map`、handler、Modbus TCP 服务）在独立的 `modbus-emulator` 包中（§4.4）。

### 3.2 布局定义（`src/layouts.yaml`）

- 布局描述的格式（YAML 1.2、片段、`coupling`、`includes`、条目字段、类型、初值规则、Bool 定位规则、布局校验）见 layout-data 的设计文档；本项目的布局文件是 `src/layouts.yaml`，根键 `layouts` 下为 `LINE`、`SECTION`、`NODE`、`COMMAND`、`RECORD`，其余根键是片段（如 `node_commands`、`node_parameters`、`node_status`）。
- `src/layouts.js` 只提供布局来源：导出同目录 `layouts.yaml` 的路径 `layouts_file`（路径按模块位置解析；构建时 rolldown 配置中的复制插件把它作为独立文件输出到 `main.js` 同目录，不打进 `main.js`），并读出参数块条目 `node_parameters` 和命令位条目 `node_commands`（这两个片段的条目列表，供配置和节点规则按名使用）。布局由 modbus-emulator 在创建对上模拟器时注册（`register_layout`，每个进程一次），之后用 `get_layout(名字)` 取得 `LINE`、`SECTION`、`NODE`、`COMMAND`、`RECORD`；布局不合法时，`create_upward` 抛出带 `errors` 的错误，由 `main.js` 逐条写入错误日志并退出。
- coupling 中偏移 8–15 对应寄存器的 bit0–7，偏移 0–7 对应 bit8–15；定义文件按 8–15、0–7 的顺序列出，就是按寄存器 bit0 到 bit15 的顺序排列；字值的第 k 位即寄存器 bit k，命令屏蔽字 `command_mask` 按这个位号计算（§14.1）。
- [spec-modbus.md](spec-modbus.md) 中的点表就是按这些规则从布局计算出来的。
- 组合字的位号完全由偏移编号保证，block 内部的组合字与其他多字节类型一样按大端存放；对上服务端和驱动都不为组合字单独交换字节（layout-data 规范）。
- 这些布局就是 Modbus 寄存器表和执行器数据区的内存映像，修改任何偏移都属于协议变更。
- 写入所有权（规范 §3.6）目前靠人工审查保证：布局中没有标注 Tag 由谁写入，校验不检查这一规则。现有写入路径都符合：命令块的 ID、命令字、参数块和节点 block 的参数块由控制器写入，均按字对齐且连续；节点 block 的其余部分由执行器写入，控制器只读。
- 布局校验由 `register_layout` 对文件中的全部布局执行；`tlms check` 与配置校验的错误一起报告（未实现，见§13）。

主要布局（字节偏移）：

| 结构 | 关键 Tag |
| --- | --- |
| NODE | 0 ID；2 status；4 temperature；8 pressure；12 flowmeter；16 response_code；18 起为参数块 |
| COMMAND | 0 response_code（弃用）；2 overtime（弃用）；6 extra_commands（`has_commands`、`reset_paras`）；16 ID；18 commands；20 起为参数块 |
| SECTION | 0 ID；2 upward_input（保留）；4 status；6 flow_begin；10 flow_end；14 flow_diff；18–34 限值与延时；38 countdown；40 inner_word（内部触发位） |
| LINE | 0 status；2 ID；4 action_section_ID；6 flow_diff（保留） |
| RECORD | 0–10 时间；12 section_ID；14–36 流量与压力；42–48 执行器 ID；50 status；52 index |

### 3.3 访问追踪与类型声明

- 调度器的 `trace_dependencies()` 用 `Ldata.on_access` 订阅所有数据块的 `access` 事件，把规则对 tag 的读写记入“当前规则”的实际读写集合，`untrace_dependencies()` 取消订阅（§6.5）。
- 由布局生成类型声明 `src/layout_types.d.ts`（`pnpm gen:types`，调用 layout-data 的 `render_types`）：每个布局一个接口，tag 为属性，`comment` 作为注释，为按名访问提供编辑器补全；生成物纳入版本库，由测试检查它与布局文件一致。

### 3.4 数据块内容的读写

- block 的字节不作为属性公开，内容只经 Ldata 读写，所以每次写入都经过 Ldata，不会漏检。读写途径任何时候都允许，不论是否在扫描中：

  | 途径 | 使用者 |
  | --- | --- |
  | 按名读写（`data[name]`，`tag.value`） | 任何代码：规则、事件处理器、异步回调、普通程序 |
  | 按 tag 做设备字节序转换：`tag.load(io_buffer, endian)`、`tag.store(io_buffer, endian)` | IO 绑定（§4.5） |
  | 原始读写方法 `read_bytes(offset, length)`、`write_bytes(offset, source)`、`write_bit(offset, mask, value)`，以字节偏移定位 | 对上服务端（§4.4） |

- IO 绑定的装载（§4.5）在扫描的输入阶段进行，把一个分组的全部 tag 放进一个事务，提交时检测一次、发出一次 `write`；输入阶段的 `write` 引起的扫描请求被忽略（§5.2）。
- 功能码 16 请求会在同一个同步调用中连续写多个寄存器。对上服务端对每个寄存器单独写一次，每次写入都检测，跨两个寄存器的 Real 在写完第一个寄存器时会以写了一半的值发出一次 `change` 事件，写完第二个寄存器时再发出完整的值；规则不受影响，因为 `request_scan()` 会合并（§5.2），扫描在整个请求处理完之后才执行。

### 3.5 变化检测与写入通知

变化检测的机制（快照比对、事件顺序、振荡保护）和事务（`transaction(fn)`）见 layout-data 的设计文档：block 在每次写入后立即检测并发出 `change` 事件，再发出 `write` 事件。扫描不是 Ldata 的一部分，“上一次扫描结束时的值”由调度器自己保存（§5.1）。

**写入通知接到扫描请求。** 调度器登记 block（`add_data`）时监听它的 `write` 事件并请求扫描，所以控制器的全部 block（线、段、执行器的 data 和 command、动作记录）的任何写入（规则、事件处理器、HMI、异步回调）在检测之后都请求一次扫描。理由：

- 写入立即生效，规则读到的永远是当前值；`change` 事件只是通知；
- 控制器的联锁和汇总都在规则中，不依赖事件（§6.6）；
- 事件在写入的调用栈中发出，调试时能追溯写入者。

代价只影响事件处理器（日志）：求值阶段规则的写入，其事件在规则执行的中途发出；一次扫描内同一 tag 的多次变化分别发出事件；功能码 16 写跨两个寄存器的值时出现一次中间值（§3.4）。需要把一组写入作为整体对外时，可以用 layout-data 的事务，目前控制器没有这样的需求。

### 3.6 字节序转换

设备字节序（`BE`、`LE`、`BEBS`、`LEBS`，没有别名）与内部大端之间的转换由 layout-data 实现（规则见其设计文档）：按 tag 转换用 `tag.load` / `tag.store`，IO 绑定用 `io_index_table` 得到整个 block 的字节映射（§4.5），本包不自己实现转换；测试用 block 的 `load_tag` / `store_tag` 作为对照，核对 Binding 与它们逐字节一致。

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

- 地址换算：配置和 Ldata 中的区域都以字节计，字节起点 `start` 对应保持寄存器 PDU 地址 `start >> 1`（0 基），长度为 `length >> 1` 个寄存器；以 es-modbus 的结构化范围 `[func_code, pdu_addr, length]` 传入，不使用 Modicon 写法。
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

### 4.4 对上服务端（modbus-emulator）

- 数据块的创建和对上服务由独立的 `modbus-emulator` 包提供（规范和设计见该包的 `doc/`）。`src/upward.js#create_upward(controller)` 把控制器对象图描述成模拟器的对象形式描述：`layouts_file` 指向 `src/layouts.yaml`，`blocks` 为全部数据块，`servers` 为监听 `0.0.0.0:<modbus_server.port>` 的一个 TCP 服务。模拟器自身不输出日志：`create_upward` 把构造时的 `warnings` 写入日志，并订阅它转发的服务事件（`server_<name>`：启停、客户端连接与断开、各类错误）和 handler 事件（`unmapped`、`unmapped_limit`、`listener_error`），写入项目日志。
- 数据块（单元号来自 `controller.modbus_server.unit_id`）：动作记录（`RECORD`，字节 0）；每条线（`LINE`）、每个段（`SECTION`）各一个；每个执行器的 data（`NODE`，字节 0）和 command（`COMMAND`，字节 400，即寄存器 200 起）共用执行器的单元。数据块名即线、段、执行器的名称（command 加后缀 ` command`）。
- 数据块名存回对象图（`controller.record_block`、`line.block`、`section.block`、`node.block`、`node.command_block`），`main.js`、`runtime.js` 据此用 `emulator.block(name)` 取回 Ldata；Ldata 的显示名由各 `*_init` 重新设置。
- 写入通知：不经模拟器传递。数据块创建时调度器还不存在，`build_runtime` 把数据块登记到调度器（`add_data`）时，调度器监听该 block 的 `write` 事件，请求扫描；其他需要知道写入的使用方同样各自监听。
- 寄存器和线圈的地址映射、未映射地址的处理、异常应答见 modbus-emulator 的规范；读经 Ldata 的 `read_bytes` / `read_bit`，写经 `write_bytes` / `write_bit`，由 Ldata 在每次写入后检测变化；一个 FC 15 / FC 16 请求在一个事务内写入同一 block。测试经 `emulator.handler` 模拟 HMI 请求。
- `src/layouts.js` 只读出 `layouts.yaml` 里需要按名使用的片段；布局的校验和登记由模拟器按 `layouts_file` 一次完成，动作记录字段等布局元数据从登记后的 `Layout`（`block.layout`、`get_layout`）取得。


### 4.5 IO 绑定（`src/drivers/binding.js`）

IO 绑定不属于数据层：它只通过 Ldata 和 Ltag 的接口按 tag 与设备交换数据。

- `new Binding(data, driver, { start, remote_start, length, endian, on_update }, ...extras)` 把 block 的交换区 `[start, start + length)` 对应到远端 `remote_start` 起的同长度区域；`extras` 原样传给驱动（Modbus 为 `unit_id`，S7 为 `area, db`）。交换区三项参数必须是驱动写入单元 `driver.write_unit`（缺省为 1）的整数倍，否则抛出异常，保证扩展后的写区间不越出交换区，且本地写入单元与远端写入单元对齐。
- Binding 持有按设备字节序存放的 `IO_buffer`（与 block 同长、同下标），驱动读入的数据只写入它。
- 字节映射 `io_index`：创建时由 layout-data 的 `io_index_table(layout, endian)` 为 block 的每个字节算出它在 `IO_buffer` 中的下标（规则：设备字节序以 16 位寄存器和 32 位值为单位生效，见规范 §3.6 和 layout-data 的设计文档）。布局校验保证非 Bool 条目不重叠、Bool 只落在组合字内，所以每个字节的映射唯一。
- `create_group(...names)` 返回一组需要一起与设备同步的 tag（`Binding_Group`）：
  - 名称不存在、tag 落在交换区以外时抛出异常；同一 tag 重复添加时忽略；
  - 创建时一次性取得组内每个 tag 的 Ltag，装载和导出不再按名查找；
  - 写区间：由布局的 `items` 算出组内 tag 占用的字节（Bool 占一个字节），经 `io_index` 映射到 `IO_buffer` 的位置，向外扩展到写入单元，相邻的写入单元合并。
- 装载和导出都是按 tag 的转换，同一字节上属于不同分组的位互不影响：

  ```js
  // load: IO_buffer -> block, one transaction: one detection and one write event
  block.transaction(() => { for (const tag of group.tags) tag.load(IO_buffer, endian); });
  // store: block -> IO_buffer, right before the group areas are written
  for (const tag of group.tags) tag.store(IO_buffer, endian);
  ```
- 装载时变化事件处理器抛出的异常在事务提交之后传出：数据已装载，`fresh` 照常清除，异常由调度器按 Binding 报告（§5.4）。
- 导出在写每个分组的区间之前进行：写区间是异步的，其间可能执行扫描，后面的分组导出的是最新的值。

- 读：`request_read()` 把整个交换区读入 `IO_buffer`，置 `fresh`，调用 `on_update`；正在进行的读取被共享，不重复发起，避免慢设备上请求堆积。`load(group)` 在扫描的输入阶段按掩码只装载本组的位并清除 `fresh`，组外的位（如由控制器维护的 `comm_OK`）保持不变；它只修改 `buffer`，不发事件，不请求扫描。
- 写：`request_write(group)` 登记写请求，同一分组在一次扫描内多次登记只写一次；`flush_writes()` 在扫描的输出阶段按掩码把本组的位导出到 `IO_buffer`，再按写区间逐段调用驱动写入，并把区间长度一并传给驱动。写入是异步的，不阻塞扫描。区间内不属于本组的位取自最近一次读入的值；按写入所有权规则，这些字节也由控制器写入，不会覆盖执行器的数据。
- 驱动未连接时不读不写，写请求保留到连接恢复后的 `flush_writes()`。
- 驱动事件和异步读写结果记录为 Binding 的状态，供规则读取（§6.1），只由 Binding 写入：

  | 状态 | 更新时机 |
  | --- | --- |
  | `connected` | 驱动的 `connect` / `connfailed` 事件 |
  | `read_ok` | 每次读取完成：成功为 true，失败为 false |
  | `write_done(group)` | 某个分组的一次写入完成，记录完成序号和结果，供规则判断“上次请求的写入已完成” |

  新数据到达、状态变化或写入完成时，Binding 调用创建时传入的 `on_update(binding)`，控制器把它接到 `request_scan()`。

## 5. 扫描（`src/scan.js`）

### 5.1 四个阶段

调度器的 `scan(tick)` 全程同步执行：

```js
function scan(tick) {
    // 1 input: take the process image, advance running tickers on periodic ticks
    phase = "input";
    for (const { binding, input_group } of bindings) if (input_group && binding.fresh) binding.load(input_group);
    if (tick) for (const ticker of running_tickers) ticker.count++;
    // 2 evaluate: all rules in one fixed dependency order, each isolated (5.4)
    phase = "evaluate";
    for (const rule of ordered_rules) guarded(() => rule.run(rule.ticker), rule);
    // 3 publish: the end of this scan, the used tags, binding states and variables save their values
    phase = "publish";
    take_scan_snapshots();
    // 4 output: send what was requested, start reads on periodic ticks
    phase = "output";
    for (const { binding, input_group } of bindings) {
        binding.flush_writes().catch(report);
        if (tick && input_group) binding.request_read().catch(report);
    }
    phase = "idle";
}
```

1. **输入**：把有新数据的执行器从 `IO_buffer` 装载进 block，形成本次扫描的过程映像。没有新数据的执行器保持原值，通信异常由 `comm_OK` / `work_OK` 反映。周期 tick 的扫描还要把所有运行中的 ticker 计数加 1（§6.3）。
2. **求值**：按排好的顺序执行全部规则（§6），计算汇总量、触发位、计时、联锁动作，并登记写请求。
3. **发布**：保存本次扫描结束时的值（见下）。变化事件不在这里发出：block 在每次写入后立即检测并发出（§3.5），事件处理器只做日志（§6.6）。
4. **输出**：执行本次登记的写请求；周期 tick 的扫描还发起下一轮读取。读写是异步的，完成时 Binding 的 `on_update` 请求扫描，那时本次扫描已经结束。

“上一次扫描结束时的值”在发布阶段之后保存：本次扫描中规则和事件处理器所做的写入都算在本次扫描内。调度器自己保存三类值：规则用到的（`reads`、`writes`、`reads_previous` 中的）block tag，Binding 状态（`connected`、`read_ok`），以及登记的变量（§6.1）；没有被任何规则使用的 tag 没有上一次扫描的值，取它会报错。调度器据此提供统一的上一次扫描的值和边沿判断：

```js
scheduler.previous(owner, name);  // tag, binding state or variable: saved by the scheduler
scheduler.rose(owner, name);      // !previous && current
scheduler.fell(owner, name);      // previous && !current
scheduler.changed(owner, name);   // previous differs from current (NaN equals NaN)
```

### 5.2 触发

扫描有两类触发：

| 触发 | 来源 | `tick` |
| --- | --- | --- |
| 周期 tick | 每 `MAIN_PERIOD`（500 ms）一次 | true |
| 扫描请求 | `request_scan()`：block 的写入（含 HMI 经 Unit_Map 的写入）、执行器数据读回、Binding 状态变化和写入完成 | false |

- `request_scan()` 用 `setImmediate` 合并：同一轮事件循环中的多次请求只引起一次扫描；周期 tick 到来时若有尚未执行的请求，由 tick 的扫描一并处理。
- 扫描进行中的请求来自本次扫描自己的写入（周期 tick 从不调用 `request_scan()`，外部的回调只能在两次扫描之间运行）：
  - 输入、求值阶段的请求忽略：本次扫描中后面的规则已能读到这些写入；而 derive 规则每次扫描都会写入，如果它们也引起扫描，扫描将不会停止；
  - 发布阶段开始之后的请求安排下一次扫描：这些写入发生在求值之后，规则还没有据此求值。
- 在扫描进行中调用 `scan()` 时（例如在规则或事件处理器中），不嵌套执行，而是排到本次扫描之后。
- 计时只在 `tick` 为真时推进，请求触发的扫描不推进，所以扫描次数不影响计时（§6.3）。

### 5.3 时序

- 执行器数据读回、HMI 写入、连接状态变化后立即扫描：派生状态、联锁动作在这次扫描中完成，产生的命令在这次扫描的输出阶段发出。
- 读取按周期发起，执行器数据的新旧程度受读取周期限制；命令的应答在节点 block 的 `response_code` 中，随周期读取得到。
- 一个周期内会因不同执行器的读回发生多次扫描，段内首端和末端数据的读取时刻可能不同；输差判定有延时确认，不受瞬时不一致影响。
- 控制器不对执行器上报的值做去抖或滤波，信号去抖由执行器完成。

### 5.4 出错隔离

控制器是安全系统，一处缺陷不得让其他联锁停止工作：

- 每条规则单独执行，抛出异常时经调度器创建时注入的 `on_error(error, source)` 报告，然后继续执行后面的规则；`source` 为出错的规则、block 或 Binding；
- 输入阶段每个 Binding 的装载单独隔离，装载时变化事件处理器抛出的异常按该 Binding 报告，其他 Binding 照常装载；
- 输出阶段的异步读写失败同样经 `on_error` 报告；
- 控制器把 `on_error` 接到日志；调度器本身不写日志，未注入时异常被忽略。

### 5.5 调度器接口

```js
const scheduler = new Scheduler({ period: MAIN_PERIOD, on_error });
scheduler.add_data(block);                    // every write to it requests a scan
scheduler.add_binding(binding, input_group);  // loaded in the input phase, flushed and read in the output phase
scheduler.add_binding(binding);               // output only: flushed in the output phase, never read nor loaded
scheduler.add_var(owner, name);               // a shared variable: a property of an object (6.1)
scheduler.add_rule(rule);                     // built by derive() / act() (6.2)
scheduler.prepare();                          // order the rules and check them (6.4); throws with every error
scheduler.start();                            // periodic ticks: scan(true) every period
scheduler.request_scan();                     // a coalesced triggered scan: scan(false)
scheduler.stop();
```

- `prepare()` 在第一次扫描之前调用一次：检查并排序全部规则，为每条规则分配一个 ticker，得到固定的执行表；之后不再登记。
- 不带输入分组登记的 Binding 只写不读，用于执行器的命令块：控制器只向执行器写命令，从不读回。
- `scan(tick)` 可以直接调用，供测试驱动扫描。
- `trace_dependencies()` / `untrace_dependencies()`：依赖追踪测试模式（§6.5）。

## 6. 规则（`src/rules.js`）

### 6.1 依赖键

规则读写的对象统一用“依赖键”表示，即 `(owner, name)` 二元组：

- owner 是 Ldata 时，name 是 tag 名，例如 `(section.data, 'comm_OK')`；
- owner 是段、线、执行器等普通对象时，name 是该对象的属性名，例如 `(section, 'press_SD_trigger')`。这样的变量必须用 `add_var` 登记；变量必须是某个对象的属性，裸变量不能作为依赖键；
- owner 是 Binding 时，name 是状态名，例如 `(binding, 'connected')`，只读。

这样 Tag、变量（规范 §3.6）和 Binding 状态按同一套规则排序。

组合字与它的组成位共用同一块数据，但名称不同，按名称建立的依赖看不出它们之间的关系。为此规定：

- 规则只写组成位，不写组合字。整字写入只来自装载和对上服务端，它们是扫描的输入；需要清除若干命令位时（应答握手、命令屏蔽），按名逐位写入；
- `reads` 中的组合字，在排序前展开为读它的全部组成位，之后依赖按名称建立。于是写某一位的规则排在读整字的规则之前；写不同位的两条规则之间没有依赖。

### 6.2 规则的两种类型

| 类型 | 写入约束 | 用途 |
| --- | --- | --- |
| derive（派生） | 是其写入键的唯一写入者，每次扫描完全决定写入键的值 | 汇总、差值、触发位、保护状态、计时、`comm_OK`、`action_F`、`stop_pumps` 等 |
| act（动作） | 写入键可以有多个写入者（包括 HMI、装载和其他 act），可以只在条件成立时写入 | 边沿动作、联锁置位 / 复位、命令收发、参数复制、动作记录、`work_OK` |

每条规则有一个名字 `name`，用于启动检查和出错报告，例如 `section S1 comm_OK`。规则声明的键分三类：

| 字段 | 含义 |
| --- | --- |
| `reads` | 读取本次扫描的值，构成依赖：写入者排在本规则之前 |
| `writes` | 写入的键 |
| `reads_previous` | 读取上一次扫描结束时的值（`scheduler.previous()`），不构成依赖，用于打断环（§6.4） |

规则发起的 IO（`request_write`）只是登记，真正的读写在输出阶段统一执行，不构成依赖，不声明。

规则可以使用两种状态：

| 状态 | 用途 | 上一次扫描的值、边沿判断 |
| --- | --- | --- |
| 依赖键（tag、Binding 状态、登记的变量） | 多条规则共享的状态，参与排序 | 由调度器提供（§5.1） |
| 闭包变量 | 只属于一条规则的状态：锁存、计数、自己需要的“上一次的值”等 | 规则自己保存 |

闭包变量不登记、不参与排序，只能被所属规则读写。计时不用闭包变量自行累加，而是使用调度器分配的 ticker（§6.3）。

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
```

### 6.3 计时（Ticker）

调度器为每条规则分配一个 Ticker，扫描时作为 `run(ticker)` 的参数传入。规则自己决定何时开始、何时停止计时，调度器只负责推进：

- `start()` 从 0 开始计时，运行中调用不起作用，所以持续成立的条件一直计时；`stop()` 停止并清零；`restart()` 先停止再开始；
- `count` 为开始以来的周期 tick 数，`elapsed` 为 `count * MAIN_PERIOD`；
- 推进：tick 扫描的输入阶段，调度器把运行中的 ticker 的 `count` 加 1（§5.1）；请求触发的扫描不推进。只有运行中的 ticker 在集合里，推进开销与正在计时的数量成正比；
- 规则不接收 `tick` 标志，也不自行累加计数，所以扫描次数不影响计时；
- 每条规则只有一个 ticker。需要两个独立计时的逻辑拆成两条规则，例如段的输差警告延时和输差报警延时分属两条 derive 规则。

按值的延时用两个辅助函数表达：

```js
// true once cond has held for longer than delay_ms (as a PLC TON)
function on_delay(ticker, cond, delay_ms) {
    if (cond) ticker.start();
    else ticker.stop();
    return ticker.elapsed > delay_ms;
}

// true while cond holds, and for delay_ms after it drops (as a PLC TOF)
function off_delay(ticker, cond, delay_ms) {
    return !on_delay(ticker, !cond, delay_ms);
}
```

`off_delay` 的条件从一开始就不成立时，输出在启动后保持 `delay_ms` 再变为 false，与 TOF 的输出在输入为假时的表现一致。

按边沿启动的计时（事件发生后经过一段时间执行动作，中途可由规则自行中止）由 act 规则直接操作 ticker。边沿判断只在发生边沿的那一次扫描为真，检查计时必须放在边沿判断之外：

```js
act({
    reads: [[binding, 'connected']],
    writes: [[command, 'temperature_zero_raw'] /* ... all parameter tags */],
    run: (ticker) => {
        if (scheduler.rose(binding, 'connected')) ticker.restart();
        if (!binding.connected) ticker.stop();             // aborted by the rule itself
        if (ticker.running && ticker.elapsed >= 2000) {
            ticker.stop();
            copy_parameters();
        }
    },
});
```

计时语义：

- 条件消失或规则调用 `stop()` 时立即生效，不必等下一次 tick。例如倒计时期间人工挂起：HMI 写入段或线的 `flow_override` 触发扫描，`protect_F`、`pre_stop_notice` 在这次扫描中变为 false，倒计时规则停止 ticker，输差动作不会发生；
- 在两次 tick 之间启动的 ticker，下一次 tick 时 `count` 为 1：条件成立后，`on_delay` 在其后的第 `floor(delay / MAIN_PERIOD) + 1` 次 tick 输出 true；
- 在 tick 扫描中启动的 ticker，本次扫描 `count` 为 0，从下一次 tick 开始计数；
- 两次 tick 之间条件出现又消失，ticker 停止并清零，不影响计时；
- 请求触发的扫描中 `count` 不变，依赖计时结果的规则重复执行不会产生新的边沿；
- 计时值需要对外显示的（如 `countdown`），由规则在每次扫描中从 `elapsed` 换算，两次 tick 之间数值不变。

### 6.4 排序与检查

`prepare()` 对全部规则做一次拓扑排序（Kahn 算法），得到固定的执行顺序：

- 有向边：写入键 K 的规则 → 读取键 K 的规则；同一个键的多个写入者全部排在它的读取者之前；
- 一条规则读取自己也写入的键（读改写，例如 `line_action_source &&= line.autoStopCmd` 所在的规则），这次读取不构成依赖边；
- `reads_previous` 中的键不构成依赖边；
- 同一个键的多个写入者之间、以及没有依赖关系的规则之间，按声明顺序排列，保证结果可重复。

规则在整个对象图（全部 block、Binding 和变量）建好之后声明，因为上层的规则要引用下层的 block，下层的规则也会引用上层的 block（例如段的 `pre_stop_notice` 读线的 `pump_run`）。声明顺序为执行器 → 段 → 线，同类对象按配置顺序，然后是动作记录的规则，最后是各执行器的命令屏蔽规则（§14.1）。

例如段的 `pre_stop_notice` 读线的 `pump_run`，线的 `pump_run` 汇总各段的 `pump_run`，线的 `pre_stop_notice` 又汇总各段的 `pre_stop_notice`。按层级（段 → 线）无法给出正确顺序，按键排序得到：

```
node.pump_run -> section.pump_run -> line.pump_run
  -> section.pre_stop_notice -> line.pre_stop_notice
```

同一次扫描内一次算对。

启动时检查以下错误，发现时报告全部错误并拒绝启动：

- 依赖成环：报告环上的规则和键，并提示可以用 `reads_previous` 打断；
- `reads_previous` 中的键取不到上一次扫描的值：只有 tag、Binding 的 `connected` / `read_ok` 和登记的变量有上一次扫描的值；
- 一个键有 derive 写入者，同时还有其他规则写入者；
- 规则写入了只读的 Binding 状态；
- 规则写入了组合字；
- 规则声明了不存在的 tag 名或 Binding 状态名；
- 规则声明了未用 `add_var` 登记的变量；
- 规则没有名字，或两条规则同名。

**环的打断。** 规则之间的依赖必须是无环的。业务上确实需要环时，由规则作者在环上选一处，改为读取上一次扫描结束时的值，即在声明中把这个键放进 `reads_previous`，并在 `run` 中用 `scheduler.previous()` 读取。这相当于控制系统中的单位延迟：该量总是比环上其他量晚一个扫描周期，语义固定。执行器参数的复制就是一例（§7.3）。

```js
derive({
    name: 'line B',
    reads_previous: [[section.data, 'A']],
    writes: [[line.data, 'B']],
    run: () => { line.data.B = g(scheduler.previous(section.data, 'A')); },
});
```

调度器不自动选择打断点，也不在一次扫描内反复求值直到稳定：收敛与否取决于规则中的函数，而不是依赖图的结构，一般无法判定；即使收敛，结果也可能随打断点或初值不同而不同。打断在哪里是业务判断，留给规则作者显式写出，便于审查。

### 6.5 依赖声明的核对

依赖靠显式声明，漏写读取键会导致排序错误而不报错。为此提供测试模式下的核对：

- 调度器的 `trace_dependencies()` 设置数据层的访问追踪钩子（§3.3），把访问记入“当前规则”的实际读写集合；测试运行若干次扫描后，实际访问了但没有声明的 tag 视为错误；读组合字按展开后的组成位比较（§6.1），写组合字本身就是错误；
- `scheduler.previous()` 从调度器保存的值取，不经过访问器，所以一个只在 `reads_previous` 中声明的 tag 被直接读取时，也报为错误（读到的是本次扫描的值）；
- 钩子只能追踪 tag，Binding 状态和变量不经过访问器，不在核对范围内；
- 规则的写入在规则执行中就发出事件，事件处理器中的访问会记在该规则名下；按§6.6的约定，事件处理器只写日志，所需的值取自事件参数，不产生额外的访问；
- 系统测试的夹具在每个测试中都打开核对，要求没有未声明的访问。

运行时不设置钩子。没有采用“运行一遍自动推断依赖”的方式，因为 `&&`、`||` 短路和条件分支会使一次运行看不到全部读取。

### 6.6 事件处理器的编码约定

这是控制器代码的约定，不是 Ldata / Ltag 的限制：Ldata / Ltag 不阻止任何写入。

- 联锁、汇总等派生逻辑写成规则，不写在事件处理器中，以保证同一次扫描基于同一份输入、结果与事件顺序无关；
- 事件处理器用于日志；处理器中写 tag 是允许的，写入会请求一次扫描，在下一次扫描中被规则读到；
- 需要异步操作的逻辑写成 act 规则：规则登记请求，Binding 记录完成状态并请求扫描，后续处理由规则读取完成状态完成（§4.5）。

## 7. 执行器处理（`node_proc.js`）

### 7.1 IO 绑定

每个执行器的 data 和 command 各有一个 Binding（§4.5），保存在 `actuator.data_binding` / `actuator.command_binding`。

- data：
  - 绑定整块结构，远端起点为 `driver_info.data.start`；
  - `data_payload` 包含 ID、状态位、测量值、`response_code` 和参数块（不含 `comm_OK`，它由控制器自己维护）；
  - `data_parameters` 只包含参数块。
- command：
  - 从本地字节 16 开始绑定（跳过 0–15 的本地区），远端起点为 `driver_info.commands.start`；
  - `commands_payload` 包含 ID、commands 和参数块。

### 7.2 读取与写入

- 执行器数据的读取由扫描完成：周期 tick 的扫描在输出阶段发起读取，数据到达后 Binding 的 `on_update` 请求扫描，在输入阶段装载 `data_payload`，在发布阶段检测变化。
- 命令 Binding 只写不读（§5.5）：规则登记写入，扫描的输出阶段写出；写入完成后 `on_update` 请求扫描。驱动未连接时写请求保留，连接恢复后写出。
- 驱动事件只记日志；连接和读取结果由 Binding 记为 `connected` / `read_ok`，供规则读取。

### 7.3 规则（`node_rules`）

| 规则 | 处理 |
| --- | --- |
| `comm_OK`（derive） | `off_delay(connected, delay_protect_time)`：已连接时为 true，断开后保持 `delay_protect_time` 再变为 false；从未连上时，启动后保持同样时长 |
| `work_OK` | `off_delay(read_ok, delay_protect_time)` 为 false，即读取持续失败超过 `delay_protect_time` 时置 false；读取成功后由装载恢复执行器上报的值 |
| 参数刷新 | `connected` 上升沿开始计时，满 2 s 时把节点 block 的参数复制到命令块；其间断开则停止 |
| `stop_pumps` 收回（带泵执行器） | `pump_run` 下降沿时清除命令块的 `stop_pumps` |
| 应答握手 | `response_code` 变化且不为 0 时，`response_code` 中置 1 的位，命令块中同名的命令位逐位清除，并清除 `executing` |
| `pressure_SD_F` | 变化时清除对应的允许或禁止命令位 |
| `read_paras` | 上升沿时把节点 block 的参数复制到命令块，并复位该位 |
| `write_paras` | 上升沿时把命令块的参数复制到节点 block，登记写入 `data_parameters`；写入完成（`write_done` 的序号到达）后复位该位 |
| `has_commands`（derive） | `commands` 不为 0 |
| 发送 | `commands` 变化时，或 `response_code` 变化且不为 0 时（让执行器看到已应答的位被清除），登记写入 `commands_payload` |
| 重发 | `has_commands` 持续超过 3 个 tick 后，每个 tick 再登记一次写入；每个执行器单独计时 |

- `write_paras` 把命令块的参数写入节点 block，而参数刷新、`read_paras` 把节点 block 的参数复制到命令块，`comm_OK` / `work_OK` 读节点 block 的 `delay_protect_time`，形成环。后者读节点参数在上一次扫描结束时的值（`reads_previous`，§6.4）打断这个环：节点参数来自执行器，晚一次扫描没有影响；`write_paras` 则必须读本次扫描的命令参数，HMI 常在同一请求中先写参数、再写 `write_paras`。
- 规则只写命令位，不写 `commands` 整字（§6.1）。
- `pump_run` 以执行器上报的值为准（执行器已对各泵的状态做“或”运算），控制器不另行计算。
- 状态变化只记日志；向段的汇总由段的规则完成（§8）。

## 8. 段处理（`section_proc.js`）

### 8.1 事件处理（`section_init`）

- 写入段的 ID、名称和输差参数（`flow_diff_WH` 等、`action_time`）。
- 状态变化（`action_F`、报警、挂起、`pre_stop_notice` 等）只记日志。

### 8.2 规则（`section_rules`）

段的变量和规则在对象图建好之后声明（§6.4）。段对象上的变量（不是 Tag，见规范 §3.6）用 `add_var` 登记：

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
| `pre_stop_notice` | `flow_alarm_F && line.pump_run && protect_F`：泵运行条件取线的（规范 §5.2），`stop_pumps` 和压力动作仍取本段的 |
| 倒计时 | `pre_stop_notice` 为真时计时，`countdown = (action_time - elapsed) / 1000`；结果小于 0 时 `countdown` 置 0，`countdown_expired` 为真 |
| `action_F` | `press_action \|\| flow_action` |
| `stop_pumps` | `(段 auto/man \|\| 线 auto/man) && pump_run` |

`pre_stop_notice` 读线的 `pump_run`，线的 `pump_run` 又汇总各段的 `pump_run`；排序后它们在同一次扫描中依次算出，不再需要线的变化事件补算。

### 8.3 联锁动作

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

v0.7.0 调整段的布局时，计划把 `press_action` / `flow_action` 升级为 Tag，届时动作记录改由它们的变化事件触发，不再在动作记录规则中判断上升沿。

## 9. 线处理（`line_proc.js`）

- 规则（`line_rules`，derive）：
  - `pump_run`、`pre_stop_notice`：取各段同名属性的“或”；
  - `alarm_F`：取各段 `flow_alarm_F` 与 `press_alarm_F` 的“或”。
- 线的 `flow_override` 只记日志，不改写任何段；其作用在段的 `protect_F` 规则中以与运算体现（见§8.2）。
- act 规则：`pump_run` 下降沿时，清除线的 `autoStopCmd` / `manStopCmd`。

## 10. 动作记录（`action_record.js`）

- CSV 列取自 RECORD 中除 Word 类型和 `index` 以外的 Tag。
- 启动时：
  1. 文件不存在就写入表头；
  2. 流式读取全部行，用 `unshift` 保留最近 `records_size` 条，最新的在前；
  3. 对各列做类型还原。
- `update_record(fields)`：按 Tag 名写入记录字段，再调用 `add_record()`；字段与段的对应关系不在动作记录中。
- `add_record()`：
  1. 写入当前时间；
  2. 把记录放到内存列表头部；
  3. 设置 `index = 0`；
  4. 用 `appendFile` 追加一行。
- `index` 由一条 act 规则处理（`action_record_proc.js` 的 `action_record_rule`），在全部段的规则之后声明；规则在闭包中记住当前显示的记录：
  - `index` 与当前显示的不同时：为 -1 时清空时间 Tag；否则把对应记录装载到 data，越界时恢复为原值。
- 记录内容由段的 `add_action_record()` 通过 `update_record()` 在压力动作或输差动作发生时填写（见§8.3）；`press_action` / `flow_action` 取段的动作变量；执行器位置的对应规则见§13。

## 11. 日志

- log4js 有两个 category：
  - `default`：写入 `logs/info.log` 和 `logs/error.log`（按天滚动，单文件上限 10 MB，压缩）；`TLMS !== 'controller'` 时还输出到控制台；
  - `console`：只输出到控制台。
- `logger` 是一个可切换 category 的包装对象。

## 12. 运行环境、依赖与构建

### 12.1 运行环境与进程管理

- 运行环境：Node.js，源码为 ES 模块（使用 `import ... with { type: 'json' }`、`import.meta.dirname`）。
- 后台运行借助 pm2（peer 依赖）：
  - `tlms start` 先执行 `pm2 delete tlms_esd`，再用固定进程名 `tlms_esd` 执行 `pm2 start`，因此同一时间只有一个实例；
  - `stop`、`list`、`log`、`flush` 分别对应 `pm2 delete`、`pm2 list`、`pm2 log`、`pm2 flush`；
  - pm2 启动时设置 `TLMS=controller`，日志模块据此关闭控制台输出。

### 12.2 依赖库

| 库 | 用途 |
| --- | --- |
| `es-modbus` | Modbus TCP 客户端（连接执行器）和服务端（对 HMI） |
| `@st-one-io/nodes7` | S7 客户端（连接执行器） |
| `yaml` | 配置与布局解析（YAML 1.2） |
| `csv-parser` | 读取动作记录 CSV |
| `log4js` | 日志 |
| `mri` | 命令行参数解析 |

### 12.3 开发工具

- 包管理：pnpm。
- 测试：`node --test`。
- 代码检查：ESLint 加 `@stylistic/eslint-plugin`（`eslint.config.js`，`pnpm lint`），JS 用 tab 缩进。ESLint 查找代码问题，@stylistic 只规范空白、引号、分号等，不重新折行，手工对齐的布局表得以保留。不使用会重新折行的格式化工具（Biome、Prettier）。另外禁止使用与 `Number` 命名空间等价的全局量（`isNaN`、`isFinite`、`parseInt`、`parseFloat`、`NaN`、`Infinity`），改用 `Number.isNaN` 等。

### 12.4 构建与发布

- `rolldown.config.js` 生成两个 ES 模块包：
  - `src/main.js` → `./main.js`；
  - `src/cli.js` → `./cli.js`，其中 `./main.js` 设为 external，所以 `cli.js` 运行时 import 的是同目录下的打包产物。
- `package.json` 的 `prepare` 脚本会触发构建；`bin.tlms` 指向 `cli.js`。

## 13. 未实现项

规范已有要求、但当前代码尚未实现的内容：

| 项 | 规范要求 | 代码现状 | 涉及位置 |
| --- | --- | --- | --- |
| ID 唯一性校验 | 线、段、执行器的 ID 全局互不相同（跨类型），同一对象的多个 block 共用 ID（规范 §4.1） | `config.js` 只校验执行器 `id` 为非零数字；线、段、执行器各自按 `ID<id>` 建索引，重复或跨类型相同都不报错，同类型重复时后者静默覆盖前者 | `config.js` 的 `add_conf` |
| ID 作为对上单元号 | 线、段、执行器的 Modbus 单元号直接取各自的 ID（不小于 1），动作记录固定为单元号 0，控制器配置中不再有 `unit_id`（规范 §4.1、5.5） | `build_runtime` 按名称从 `controller.modbus_server.unit_id[name]` 查单元号（动作记录查 `unit_id.action_records`），每个对象都要在控制器配置中逐项列出 | `runtime.js` 的 `build_runtime` |
| 配置检查命令 | `tlms check` 读取并校验配置和全部布局（§3.2 `validate_structure`）、报告全部错误，不启动控制器（规范 §3.6、§5.6） | 无此命令；配置错误只在启动时发现，且多数直接退出或崩溃；布局校验已在启动时执行（`main.js`），尚未接入命令行 | `cli.js`；`config.js` 需拆出可单独调用、收集全部错误的校验函数 |
| 动作记录按位置对应执行器（现有代码有缺陷） | 节点 1–4 按先首端、后末端的顺序依次对应动作段的执行器，每个位置的压力、ID、泵运行状态取自同一个执行器（规范 §5.4） | 节点 1–3 固定取 `begin_nodes[0..2]`，节点 4 固定取 `end_nodes[0]`；`node1..3_pump_run` 取自 `pump_nodes[0..2]`（只含带泵执行器，与节点位置可能错位），`node4_pump_run` 从不赋值 | `section_proc.js` 的 `add_action_record` |

## 14. 命令处理

所有命令都走§7.3的通用握手（发送命令字，收到 `response_code` 后清除对应位）；部分命令另有控制器本地处理：

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

### 14.1 命令屏蔽

依据各执行器配置的 `supported_commands` 屏蔽命令（规范 §5.1）：

- 解析：`config.js` 解析执行器时，把 `supported_commands` 数组转换为一个 16 位屏蔽字 `command_mask`。数组中每个命令名按命令枚举（`node_commands`）查出命令字位号 k，屏蔽字的第 k 位置 1；位号与寄存器 bit 一致（见§3.2）。
- 校验：数组中出现命令枚举以外的名称时，视为配置错误，启动时报错退出，与执行器 `id` 的校验方式一致。
- 省略字段时视为支持全部命令，`command_mask` 取命令枚举的全部位 0–13，即 `0x3FFF`。
- 使用：`command_mask` 随执行器对象带入运行时。每个执行器有一条屏蔽规则，每次扫描对 `command_mask` 中为 0 的命令位按名逐位复位；位 14（`reserve`）和位 15（`executing`）不是命令，不受影响。
- 屏蔽规则在全部规则之后声明：同一个命令位的多个写入者按声明顺序排列，所以它排在其他写命令位的规则之后；它写命令位，所以排在读 `commands` 的发送规则之前，不支持的命令位不会发出。

