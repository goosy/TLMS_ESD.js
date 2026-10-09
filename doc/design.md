# TLMS_ESD 设计说明（初稿）

> 本文根据现有代码（v0.6.1）整理，描述系统“怎么做”，即架构、数据结构、算法和内部机制。需求见 [spec.md](spec.md)。

## 1. 模块划分

| 路径 | 职责 |
| --- | --- |
| `src/cli.js` | `tlms` 命令行，解析参数，调用 pm2 或直接 `import('./main.js')`。 |
| `src/main.js` | 进程入口：校验布局，读取配置，构建控制器，提供按连接复用的真实驱动，启动 Modbus 服务端和主循环。 |
| `src/runtime.js` | `build_runtime`：为控制器创建 TData、挂到 `Unit_Map`、调用各 `*_init`，并提供主循环的一次迭代 `cycle` 与 `start` / `stop`。驱动由调用方经 `get_drivers(driver_info)` 提供，测试据此注入假驱动。 |
| `src/gcl.js` | YAML 加载器（`yaml` 库，YAML 1.1），保留源码行号信息。 |
| `src/config.js` | 合并多份配置文档，填充默认值，建立名称与 ID 索引。 |
| `src/init.js` | `prepare_controller`：为选定的控制器构建运行时对象图。 |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | 执行器（节点）、段、线的初始化（事件绑定）与周期处理。 |
| `src/action_record.js` | 动作记录：CSV 读写，以及基于 index 的浏览。 |
| `src/drivers/` | `Base_Driver`、`MTClient`（Modbus TCP 客户端）、`S7Client`，以及 `createMTServer` / `create_vector` / `Unit_Map`（对上服务端）。 |
| `src/typed_data/` | `TData` / `TTag` / `TGroup`：带类型的缓冲区与变化事件。 |
| `src/structs/` | LINE、SECTION、NODE、COMMAND、RECORD 的内存布局定义。 |
| `src/util.js` | log4js 日志、`debouncify` / `debounce`、`Object.mixin`。 |

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
   4. `runtime.start()` 用 `setInterval(MAIN_PERIOD = 500)` 执行全部段的 `section_loop` 和全部执行器的 `node_loop`（`line_loop` 为空，未调用）。

## 3. 带类型数据层

TData（实例记作 tdata）与 TTag 的对外要求和术语见规范 3.6 节，本节说明实现。

### 3.1 布局定义（`src/structs/`）

- 每个条目包含 `{ name, type, offset, length, init_value }`，`offset` 和 `length` 的单位都是位（bit）。
- `type` 取值（大小写不敏感）：`Bool`、`Byte`、`SInt`、`USInt`、`Int`、`UInt`、`Word`、`DInt`、`UDInt`、`DWord`、`Real`。
- `Word` 条目带 `coupling` 时，表示由若干 Bool 组成的状态字或命令字；`is_combined: true` 表示整字与各位双向联动。coupling 内各项的 `offset` 相对于该字的起点。
- `{ includes: [...], offset }` 把一组公共条目（如 `node_parameters`）整体偏移后拼接进来。
- `share.js#build_structure` 把条目展开成扁平的 `items`，计算结构总长 `length`，并把 coupling 规范为名称数组。
- Bool 的定位规则：`byte = offset >> 3`，`bit = offset % 8`。内部缓冲按大端存放，一个字的第一个字节是寄存器的高字节，所以 coupling 中偏移 8–15 对应寄存器的 bit0–7，偏移 0–7 对应 bit8–15。定义文件按 8–15、0–7 的顺序列出，就是按寄存器 bit0 到 bit15 的顺序排列；字值的第 k 位即寄存器 bit k，`0xB1` 掩码按这个位号计算。
- [spec-modbus.md](spec-modbus.md) 中的点表就是按上述规则从这些定义计算出来的。
- 组合字的位号完全由上述偏移编号保证，`buffer` 中组合字与其他多字节类型一样按大端存放；对上服务端和驱动都不为组合字单独交换字节（规范 3.6）。
- 这些布局就是 Modbus 寄存器表和执行器数据区的内存映像，修改任何偏移都属于协议变更。
- 写入所有权（规范 3.6）目前靠人工审查保证：布局中没有标注 TTag 由谁写入，校验不检查这一规则。现有写入路径都符合：命令块的 ID、命令字、参数块和节点 tdata 的参数块由控制器写入，均按字对齐且连续；节点 tdata 的其余部分由执行器写入，控制器只读。

#### 布局校验

规范 3.6 的布局规则在布局阶段集中校验，不分散到 TData、TTag 和 TGroup 的运行时：

- 由 `share.js` 提供 `validate_structure(data_struct)`，对 `build_structure` 展开后的扁平 `items` 做校验，返回违规描述的数组（空数组表示合法），不在发现第一个错误时退出。
- 校验内容：
  - 名称：`items` 中名称重复；名称与 TData 的成员（`TData.prototype` 上的方法、getter，以及 `name`、`driver`、`IO_read` 等实例字段）冲突。
  - 类型与长度：`type` 不在支持的类型中；`length` 与类型不符（Bool 1，Byte / SInt / USInt 8，Int / UInt / Word 16，DInt / UDInt / DWord / Real 32）。
  - 对齐：非 Bool 的 `offset` 必须是 8 的倍数；多字节类型的字节偏移必须是偶数。
  - 重叠：把非 Bool 条目按字节区间排序后检查相邻区间是否相交；Bool 按 `offset` 检查是否重复占用同一位；Bool 落在某个非 Bool 区间内时，要求该 Bool 的 `coupling` 包含这个非 Bool 条目的名称。
  - 组合字：带 `coupling` 的条目，其每个组成位的 `offset` 都在 `[offset, offset + length)` 内。
  - 总长：`length % 16 === 0`。
  - `init_value` 的类型与取值范围与 `type` 相符（Bool 为布尔值，其余为该类型可表示的数）。
- `build_structure` 遇到重名时不再静默跳过，而是保留条目，交给校验报告。
- 调用方：
  - 控制器启动时（`main.js`，在创建任何 TData 之前）对全部结构调用校验，有违规时逐条写入错误日志并退出；
  - `tlms check` 对全部结构调用校验，与配置校验的错误一起报告。
- 校验通过后，TData、TTag、TGroup 不再重复做这些检查；TTag 的 `validate` 只保留防御性断言。

主要布局（字节偏移）：

| 结构 | 关键 TTag |
| --- | --- |
| NODE | 0 ID；2 status；4 temperature；8 pressure；12 flowmeter；16 response_code；18 起为参数块 |
| COMMAND | 0 response_code（弃用）；2 overtime（弃用）；6 extra_commands（`has_commands`、`reset_paras`）；16 ID；18 commands；20 起为参数块 |
| SECTION | 0 ID；2 upward_input（保留）；4 status；6 flow_begin；10 flow_end；14 flow_diff；18–34 限值与延时；38 countdown；40 inner_word（内部触发位） |
| LINE | 0 status；2 ID；4 action_section_ID；6 flow_diff（保留） |
| RECORD | 0–10 时间；12 section_ID；14–36 流量与压力；42–48 执行器 ID；50 status；52 index |

### 3.2 TData

- 对外暴露两个缓冲区：
  - `buffer`：内部值缓冲区，统一按大端（BE）存放，Modbus 服务端直接按大端读写它；
  - `IO_buffer`：与驱动交换数据用的缓冲区，按设备字节序存放。
- 每个条目生成一个 `TTag`，同时在 TData 上定义同名属性：
  - getter 返回 `tag.value`；
  - setter 调用 `tag.set_value`，再执行 `check_coupling`，让组合字与它的各个位相互刷新。
- 任一 tag 发生变化时，TData 发出 `change(tagname, old, new)`；tag 自身也发出 `change(old, new)`。业务逻辑通过 `data.get(name).on('change', ...)` 订阅。
- 外部直接改写 `buffer`（服务端写入）后，调用 `check_all_tags()` 逐个比较缓存值与缓冲区内容，补发变化事件。
- `set_IO(driver, {remote_start, start, length, endian}, ...extras)` 绑定驱动：
  - 本地 `IO_buffer[start .. start+length)` 对应远端 `remote_start` 起的同长度区域；
  - `extras` 原样传给驱动：Modbus 为 `unit_id`，S7 为 `area, db`；
  - 生成 `IO_read_all`（整段读入 `IO_buffer`）、`IO_write`（按区间写出）以及 `create_tag_group`。

### 3.3 TTag

- 每个 tag 持有 `buffer` 中自己那一段的 subarray，并缓存当前值 `value`。`check_change` 比较缓存值与缓冲区中的值，不同时更新缓存并发出事件，事件总在新值生效之后发出。
- `read_from(IO_buffer, endian)` / `write_to(IO_buffer, endian)` 负责在设备字节序与内部大端之间转换：
  - 2 字节：`BE` 原样复制；`LE` / `little` / `BEBS` 交换两个字节；
  - 4 字节：支持 `BE`、`LE` / `little`、`BEBS`、`LEBS` 四种排列；
  - Bool 和单字节类型（Byte、SInt、USInt）只读写一个字节，不做字节内转换；它在 IO 缓冲区中的下标按 16 位寄存器换算：`LE` / `little` / `BEBS` 时为 `byte_offset ^ 1`，`BE` / `LEBS` 时为 `byte_offset`。Bool 按 `bit_mask` 只改自己的位。

### 3.4 TGroup

- `create_tag_group(...names)` 返回一组需要一起与设备同步的 tag。
- 布局的重叠规则已由布局校验保证（3.1 节），TGroup 不再判断重叠。添加 tag 时：
  - 同一 tag 重复添加时忽略；
  - tag 的字节范围超出 IO 交换区时报错退出；
  - tag 在 IO 缓冲区中实际占用的字节范围（Bool 和单字节类型按 3.3 节换算下标）向外扩展到驱动写入单元 `driver.write_unit` 的整数倍，再并入写区间（`#areas`）；与已有区间相交或相邻时合并，可能一次合并多个区间。
- IO 交换区的 `start`、`remote_start` 和 `length` 必须是写入单元的整数倍，`set_IO` 时检查，否则报错退出，保证扩展后的写区间不越出交换区，且本地写入单元与远端写入单元对齐。
- `read()`：先 `IO_read_all`，再让组内每个 tag `read_from` 并执行 `check_coupling`，从而触发变化事件并刷新组合字与各位。
- `write()`：组内每个 tag 先 `write_to` 到 `IO_buffer`，再按合并后的区间逐段调用 `IO_write`，并把区间长度一并传给驱动。区间内不属于组内 tag 的字节取 `IO_buffer` 中最近一次读入的值；按写入所有权规则，这些字节也由控制器写入，不会覆盖执行器的数据。
- `copy_from(tdata)`：按同名 tag 从另一个 TData 复制值并执行 `check_coupling`，用于在 data 与 command 之间同步参数块。

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

- `create_vector(unit_map)` 生成服务 `Unit_Map` 的 vector，`createMTServer` 用它创建 es-modbus 服务端；测试直接调用 vector 模拟 HMI 请求。

- `Unit_Map.attach_unit(unit_id, tdata, start)` 把 TData 挂到某个单元的字节区间 `[start, start + size)`，一个单元可以挂多个 TData。
  - 执行器单元：data 挂在字节 0，command 挂在字节 400（即寄存器 200 起）。
- 寄存器 `addr` 对应字节 `addr * 2`，按大端读写 `tdata.buffer`；线圈 `addr` 对应字节 `addr >> 3` 的第 `addr % 8` 位。
- 每次写入后调用 `tdata.check_all_tags()`，把 HMI 的写操作转换为 tag 变化事件。
- vector 方法名为 es-modbus 要求的 snake_case：`get_holding_register`、`get_input_register`、`set_register`、`get_coil`（同时用于 FC 1 和 FC 2）、`set_coil`。
- 未映射的地址（例如执行器单元中节点数据区与命令块之间的空档）读为 0 / false，写入被忽略，因此 HMI 跨越空档的整块读取仍能成功。每个（类型、单元、地址）只记录一次警告，避免轮询时刷屏。
- 请求由 es-modbus 先行校验：未登记的单元号应答异常 0x0B，非法功能码、数量或地址越界应答 0x01 / 0x03 / 0x02；vector 抛出异常时应答 0x04，并通过 `vector_error` 事件记录日志。

## 5. 执行器处理（`node_proc.js`）

### 5.1 IO 绑定

- data：
  - 绑定整块结构，远端起点为 `driver_info.data.start`；
  - `data_payload` 包含 ID、状态位、测量值、`response_code` 和参数块（不含 `comm_OK`，它由控制器自己维护）；
  - `data_parameters` 只包含参数块。
- command：
  - 从本地字节 16 开始绑定（跳过 0–15 的本地区），远端起点为 `driver_info.commands.start`；
  - `commands_payload` 包含 ID、commands 和参数块。

### 5.2 周期处理

`node_loop` 每 500 ms 执行一次：

1. 驱动已连接时，执行 `data_payload.read()`。
2. 命令屏蔽：`command.commands &= 0xB1`，对所有执行器统一保留位 0、4、5、7（见第 11、12 节）。
3. `has_commands` 为真的周期数超过 3 时，重新发送命令（`debounce_send_commands`）。

### 5.3 事件

- 驱动事件：
  - `connfailed`：延时 `delay_protect_time` 后置 `comm_OK = false`；
  - `connect`：置 `comm_OK = true`，2 s 后执行 `reset_parameters`（command 参数块 ← data）；
  - `io_error`：延时后置 `work_OK = false`。
- `response_code` 变化（应答握手）：
  1. `commands &= ~response_code`，清除已应答的命令位；
  2. `executing = false`；
  3. 若 `response_code` 仍不为 0，再发送一次命令（执行器据此看到命令位已清除）。
- `commands` 变化：更新 `has_commands`，并以 100 ms 防抖调用 `commands_payload.write()`。
- `read_paras`：把 data 中的参数复制到 command，然后在 nextTick 中复位该位。
- `write_paras`：
  1. 把 command 中的参数复制到 `data_parameters`；
  2. 写入执行器 data 区的参数块；
  3. 写入完成后复位该位。
- `pressure_SD_F` 变化：清除对应的允许或禁止命令位，并发送命令；同时调用 `section.update_press_SD_trigger()`。
- 状态变化向上汇总：
  - `comm_OK`、`work_OK`、`pump_run`、`pump_change_F`、`pressure_WH_F`、`pressure_AH_F` 变化时，调用 `section.update_*`；`pressure_AH_F` 变化时还调用 `section.update_press_SD_trigger()`；
  - `flowmeter` 变化时，按执行器在段中的首 / 末端角色调用 `update_flow_begin` / `update_flow_end`；
  - `pump_run_1..4` 变化时，`pump_run` 取它们的“或”；`pump_run` 变为 false 时，清除该执行器的 `stop_pumps` 命令。

## 6. 段处理（`section_proc.js`）

### 6.1 汇总函数

`get_update_fn(op, ...)` 生成按 AND / OR / ADD 汇总执行器属性的函数，并用 `debouncify(key, fn, 50)` 包装。`debouncify` 的定时器保存在模块级表中，以字符串 key 区分，所以 key 必须全局唯一（形如 `section<name>_<prop>_update`）。

### 6.2 事件驱动部分（`section_init`）

- 段对象上的变量（不是 TTag，见规范 3.6）：
  - `press_SD_trigger`：压力联锁条件，由 `update_press_SD_trigger()` 计算，即段内各执行器 `pressure_AH_F && pressure_SD_F` 的“或”，带 50 ms 防抖，变化时记日志；
  - `press_action` / `flow_action`：压力动作和输差动作，由 `section_loop` 置位和复位（见 6.3 节）。
- `flow_begin` / `flow_end` 变化时，重新计算 `flow_diff`。
- `flow_diff` 变化时，计算触发位：
  - `flow_warning_trigger = flow_diff > flow_diff_WH`；
  - `flow_alarm_trigger = flow_diff > flow_diff_AH`。
- `flow_alarm_F`、`protect_F`、`pump_run` 变化时，更新 `pre_stop_notice = flow_alarm_F && line.data.pump_run && protect_F`：
  - 泵运行条件取线的 `pump_run`（规范 5.2），线的 `pump_run` 变化时也会触发这次更新（见第 7 节）；
  - 本段 `pump_run` 变化时，这次计算可能读到线的旧值，随后线的变化事件会再算一次；线的 `pre_stop_notice` 只汇总各段的结果，不参与段的计算，所以不会形成循环；
  - `stop_pumps` 和压力动作仍取本段的 `pump_run`。
- `pre_stop_notice` 变化时，更新线的 `pre_stop_notice`。
- `flow_alarm_F`、`press_alarm_F` 变化时，同时更新线的 `alarm_F`。
- `stop_pumps` 变化：
  - 为真时，对每个带泵执行器设置 `command.stop_pumps = node.data.pump_run`；
  - 为假时，设置 `stop_pumps = false` 和 `cancel_stop = true`。
- `action_F` 变化：只记日志。
- `pump_run` 变化：
  - 下降沿：清除段的 `autoStopCmd` / `manStopCmd`；
  - 两种情况都会更新本段的 `pre_stop_notice` 和线的 `pump_run`。

### 6.3 周期部分（`section_loop`）

每 500 ms 执行一次：

1. 计算保护状态：
   - `protect_prereq = comm_OK && work_OK && !pump_change_F`；
   - `protect_F = protect_prereq && !flow_override && !line.flow_override`，即本段与所属线的 `flow_override` 任一为真则不保护；
   - `hangon_AF = !protect_prereq`。
2. 延时计数：触发位为真时，对应计数器每周期加 500 ms，否则清零；计数超过 `*_delay` 时置位 `flow_warning_F` / `flow_alarm_F`。
3. 倒计时：
   - `pre_stop_notice` 为真时 `action_count` 累加，`countdown = (action_time - action_count) / 1000`；
   - 计算结果小于 0 时，`countdown` 置 0，记为倒计时结束（`countdown_expired`）。
4. 压力动作（变量 `press_action`）：
   - `press_SD_trigger && pump_run` 时置位，同时置位段的 `autoStopCmd`。不检查 `protect_F`，所以不受挂起约束；
   - 否则在 `pump_run && !autoStopCmd` 时复位：本段泵在运行（必然是停泵后重新启动的），联锁条件已消失。
5. 输差动作（变量 `flow_action`）：
   - 倒计时结束时置位，同时置位线的 `autoStopCmd` 和本段的 `line_action_source`；
   - 否则先执行 `line_action_source &&= line.autoStopCmd`，再在 `line.pump_run && !flow_alarm_F && !line_action_source` 时复位。泵运行条件取线的，与停泵预告一致，否则没有泵的段永远无法复位。
6. 复位条件每周期判断，不锁存；停泵期间两个泵运行条件都不成立，所以动作状态保留到泵重新运行。
7. 动作汇总：
   - 任一动作变量由 false 变为 true 时，把线的 `action_section_ID` 设为本段 ID，并调用 `add_action_record()` 生成一条记录；同一周期两者同时发生只生成一条；
   - `action_F = press_action || flow_action`；结果为 false 且线的 `action_section_ID` 等于本段 ID 时，把它清零，避免抹掉其他段的动作。
8. 计算停泵命令：`stop_pumps = (段 auto/man || 线 auto/man) && pump_run`。

v0.7.0 调整段的布局时，计划把 `press_action` / `flow_action` 升级为 TTag，届时动作记录改由它们的变化事件触发，不再在 `section_loop` 中比较新旧值。

## 7. 线处理（`line_proc.js`）

- 汇总规则：
  - `pump_run`、`pre_stop_notice`：取各段同名属性的“或”；
  - `alarm_F`：取各段 `flow_alarm_F` 与 `press_alarm_F` 的“或”；
  - 均带 50 ms 防抖。
- 线的 `flow_override` 只记日志，不改写任何段；其作用在段的 `protect_F` 计算中以与运算体现（见 6.3）。
- `pump_run` 变化时，对线内每个段调用 `update_pre_stop_notice()`；下降沿时，还要清除线的 `autoStopCmd` / `manStopCmd`。

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
- `index` 变化：
  - 为 -1 时清空时间 TTag；
  - 否则把对应记录装载到 data；越界时恢复为原值。
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
| `yaml` | 配置解析（YAML 1.1，支持合并键） |
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
| 按执行器配置屏蔽命令 | 每个执行器在配置中用 `supported_commands` 列出支持的命令，控制器只发送支持的命令，其余命令位直接复位（规范 5.1）；实现方式见 12.1 节 | 配置中没有该字段；`node_loop` 对所有执行器统一执行 `command.commands &= 0xB1`，只保留位 0、4、5、7（`stop_pumps`、`enable_pressure_SD`、`disable_pressure_SD`、`write_paras`），`cancel_stop` 也因此被复位 | `config.js` 的执行器解析；`node_proc.js` 的 `node_loop` |
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

按规范，依据各执行器配置的 `supported_commands` 屏蔽命令：

- 解析：`config.js` 解析执行器时，把 `supported_commands` 数组转换为一个 16 位屏蔽字 `command_mask`。数组中每个命令名按命令枚举（`node_commands`）查出命令字位号 k，屏蔽字的第 k 位置 1；位号与寄存器 bit 一致（见 3.1 节）。
- 校验：数组中出现命令枚举以外的名称时，视为配置错误，启动时报错退出，与执行器 `id` 的校验方式一致。
- 省略字段时视为支持全部命令，`command_mask` 取命令枚举的全部位 0–13，即 `0x3FFF`。
- 位 14（`reserve`）和位 15（`executing`）不是命令，不受屏蔽字影响：实际过滤时用 `commands & (command_mask | 0xC000)`，避免误清 `executing`。
- 使用：`command_mask` 随执行器对象带入运行时。发送命令前先执行 `commands & command_mask`，不支持的命令位直接复位，不进入发送；取代现在 `node_loop` 中统一的 `& 0xB1`。
- 注意：现在的统一掩码在 `node_loop` 中每 500 ms 执行一次，而命令发送有 100 ms 防抖，被屏蔽的命令位仍可能在复位前被发送；按执行器屏蔽时应在发送路径上过滤，不能只靠周期复位。
