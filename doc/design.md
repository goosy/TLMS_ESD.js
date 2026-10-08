# TLMS_ESD 设计说明（初稿）

> 本文根据现有代码（v0.6.1）整理，描述系统“怎么做”，即架构、数据结构、算法和内部机制。需求见 [spec.md](spec.md)。

## 1. 模块划分

| 路径 | 职责 |
| --- | --- |
| `src/cli.js` | `tlms` 命令行，解析参数，调用 pm2 或直接 `import('./main.js')`。 |
| `src/main.js` | 进程入口：读取配置，构建控制器，创建 TData 并挂载到 Modbus 服务端，启动主循环。 |
| `src/gcl.js` | YAML 加载器（`yaml` 库，YAML 1.1），保留源码行号信息。 |
| `src/config.js` | 合并多份配置文档，填充默认值，建立名称与 ID 索引。 |
| `src/init.js` | `prepare_controller`：为选定的控制器构建运行时对象图。 |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | 执行器（节点）、段、线的初始化（事件绑定）与周期处理。 |
| `src/action_record.js` | 动作记录：CSV 读写，以及基于 index 的浏览。 |
| `src/drivers/` | `Base_Driver`、`MTClient`（Modbus TCP 客户端）、`S7Client`，以及 `createMTServer` / `Unit_Map`（对上服务端）。 |
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
   1. 初始化动作记录，挂到 `unit_id.action_records`；
   2. 按 线 → 段 → 执行器 的顺序创建 TData 并 `attach_unit`，再调用各自的 `*_init`；
   3. 启动 Modbus TCP 服务端；
   4. 用 `setInterval(MAIN_PERIOD = 500)` 执行全部段的 `section_loop` 和全部执行器的 `node_loop`（`line_loop` 为空，未调用）。

## 3. 带类型数据层

### 3.1 布局定义（`src/structs/`）

- 每个条目包含 `{ name, type, offset, length, init_value }`，`offset` 和 `length` 的单位都是位（bit）。
- `type` 取值（大小写不敏感）：`Bool`、`Byte`、`SInt`、`USInt`、`Int`、`UInt`、`Word`、`DInt`、`UDInt`、`DWord`、`Real`。
- `Word` 条目带 `coupling` 时，表示由若干 Bool 组成的状态字或命令字；`is_combined: true` 表示整字与各位双向联动。coupling 内各项的 `offset` 相对于该字的起点。
- `{ includes: [...], offset }` 把一组公共条目（如 `node_parameters`）整体偏移后拼接进来。
- `share.js#build_structure` 把条目展开成扁平的 `items`，计算结构总长 `length`，并把 coupling 规范为名称数组。
- Bool 的定位规则：`byte = offset >> 3`，`bit = offset % 8`。内部缓冲按大端存放，一个字的第一个字节是寄存器的高字节，所以 coupling 中偏移 8–15 对应寄存器的 bit0–7，偏移 0–7 对应 bit8–15。定义文件按 8–15、0–7 的顺序列出，就是按寄存器 bit0 到 bit15 的顺序排列；字值的第 k 位即寄存器 bit k，`0xB1` 掩码按这个位号计算。
- [spec-modbus.md](spec-modbus.md) 中的点表就是按上述规则从这些定义计算出来的。
- 非 Bool / Byte 的条目必须按字对齐（偶数字节），否则启动时报错并退出。
- 这些布局就是 Modbus 寄存器表和执行器数据区的内存映像，修改任何偏移都属于协议变更。

主要布局（字节偏移）：

| 结构 | 关键字段 |
| --- | --- |
| NODE | 0 ID；2 status；4 temperature；8 pressure；12 flowmeter；16 response_code；18 起为参数块 |
| COMMAND | 0 response_code（弃用）；2 overtime（弃用）；6 extra_commands（`has_commands`、`reset_paras`）；16 ID；18 commands；20 起为参数块 |
| SECTION | 0 ID；2 bypass_word；4 status；6 flow_begin；10 flow_end；14 flow_diff；18–34 限值与延时；38 countdown；40 inner_word（内部触发位） |
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
  - Bool 按位读写，Byte 不做转换。

### 3.4 TGroup

- `create_tag_group(...names)` 返回一组需要一起与设备同步的 tag。
- 添加 tag 时，用二分查找把各 tag 的字节区间合并成连续的写区间（`#areas`），相邻区间会自动拼接。区间重叠时：
  - Bool 允许落在已有区间内；
  - 其他类型的重叠视为配置错误，程序退出。
- `read()`：先 `IO_read_all`，再让组内每个 tag `read_from`，从而触发变化事件。
- `write()`：组内每个 tag 先 `write_to` 到 `IO_buffer`，再按合并后的区间逐段调用 `IO_write`。
- `copy_from(tdata)`：按同名 tag 从另一个 TData 复制值，用于在 data 与 command 之间同步参数块。

## 4. 驱动

### 4.1 Base_Driver

- 以 `Object.mixin(this, new Base_Driver())` 的方式混入：只补充子类缺少的属性，不覆盖子类自己定义的 `start_tick` 等。
- `start()` 每 `period_time`（1000 ms）执行一次 `start_tick`，已连接时发出 `tick`。
- `emit_data_ok` / `emit_data_error` 包装每次读写的结果：
  - 首次出错时发出 `data_error`；
  - 若 `reconnect_time`（5000 ms）内一直没有成功的读写，就调用 `on_error`，进而发出 `connfailed`。
- 驱动实例按连接参数复用：
  - Modbus 按 `host:port`；
  - S7 按 `host:port rack slot`；
  - 同一驱动多次 `start()` 不会重复建立定时器。

### 4.2 MTClient（es-modbus）

- 地址换算：配置和 TData 中的区域都以字节计，字节起点 `start` 对应保持寄存器 `40000 + (start >> 1) + 1`，长度为 `length >> 1` 个寄存器。
- 断线重连使用 es-modbus 自带的机制，`start_tick` 被重写为只发出 `tick`。

### 4.3 S7Client（@st-one-io/nodes7）

- 通过 `readArea` / `writeArea` 读写 `DB` 或 `M` 区，起点与长度都以字节为单位。
- 由于 `S7Endpoint.connect()` 不完善，暂时使用库自带的 `autoReconnect = 5000`，`start_tick` 同样被重写（代码中已标记为临时代码）。

### 4.4 对上服务端（createMTServer + Unit_Map）

- `Unit_Map.attach_unit(unit_id, tdata, start)` 把 TData 挂到某个单元的字节区间 `[start, start + size)`，一个单元可以挂多个 TData。
  - 执行器单元：data 挂在字节 0，command 挂在字节 400（即寄存器 200 起）。
- 寄存器 `addr` 对应字节 `addr * 2`，按大端读写 `tdata.buffer`；线圈 `addr` 对应字节 `addr >> 3` 的第 `addr % 8` 位。
- 每次写入后调用 `tdata.check_all_tags()`，把 HMI 的写操作转换为 tag 变化事件。
- 访问未映射的地址时记录错误日志，读操作返回 0 或 false。

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
  - `data_error`：延时后置 `work_OK = false`。
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
- `pressure_SD_F` 变化：清除对应的允许或禁止命令位，并发送命令。
- 状态变化向上汇总：
  - `comm_OK`、`work_OK`、`pump_run`、`pump_change_F`、`pressure_WH_F`、`pressure_AH_F` 变化时，调用 `section.update_*`；
  - `flowmeter` 变化时，按执行器在段中的首 / 末端角色调用 `update_flow_begin` / `update_flow_end`；
  - `pump_run_1..4` 变化时，`pump_run` 取它们的“或”；`pump_run` 变为 false 时，清除该执行器的 `stop_pumps` 命令。

## 6. 段处理（`section_proc.js`）

### 6.1 汇总函数

`get_update_fn(op, ...)` 生成按 AND / OR / ADD 汇总执行器属性的函数，并用 `debouncify(key, fn, 50)` 包装。`debouncify` 的定时器保存在模块级表中，以字符串 key 区分，所以 key 必须全局唯一（形如 `section<name>_<prop>_update`）。

### 6.2 事件驱动部分（`section_init`）

- `flow_begin` / `flow_end` 变化时，重新计算 `flow_diff`。
- `flow_diff` 变化时，计算触发位：
  - `flow_warning_trigger = flow_diff > flow_diff_WH && !bypass`；
  - `flow_alarm_trigger = flow_diff > flow_diff_AH && !bypass`。
- `flow_alarm_F`、`protect_F`、`pump_run` 变化时，更新 `pre_stop_notice = flow_alarm_F && pump_run && protect_F`；`flow_alarm_F`、`press_alarm_F` 变化时，同时更新线的 `alarm_F`。
- `stop_pumps` 变化：
  - 为真时，对每个带泵执行器设置 `command.stop_pumps = node.data.pump_run`；
  - 为假时，设置 `stop_pumps = false` 和 `cancel_stop = true`。
- `action_F` 上升沿：填写 `Action_Record.data` 后调用 `add_record()`。
- `pump_run` 变化：
  - 下降沿：清除段的 `autoStopCmd` / `manStopCmd`；
  - 上升沿：若流量和压力报警都已消失、`action_F` 为真、且没有 `autoStopCmd` 和 `line_action_source`，则清除 `action_F` 和线的 `action_section_ID`；
  - 两种情况都会更新本段的 `pre_stop_notice` 和线的 `pump_run`。

### 6.3 周期部分（`section_loop`）

每 500 ms 执行一次：

1. 计算保护状态：
   - `protect_prereq = comm_OK && work_OK && !pump_change_F && !bypass`；
   - `protect_F = protect_prereq && !hangon_MF`；
   - `hangon_AF = !protect_prereq`。
2. 延时计数：触发位为真时，对应计数器每周期加 500 ms，否则清零；计数超过 `*_delay` 时置位 `flow_warning_F` / `flow_alarm_F`。
3. 倒计时：
   - `pre_stop_notice` 为真时 `action_count` 累加，`countdown = (action_time - action_count) / 1000`；
   - 计算结果小于 0 时，`countdown` 置 0，并产生 `flow_action`。
4. 压力动作：`press_alarm_F && pump_run` 时，置 `action_F`、线的 `action_section_ID` 和段的 `autoStopCmd`。不检查 `protect_F`，所以不受挂起约束；目前也不检查执行器的 `pressure_SD_F`（见第 11 节）。
5. 流量动作：置 `action_F`、线的 `action_section_ID`、线的 `autoStopCmd` 和 `line_action_source`；没有流量动作时，`line_action_source &&= line.autoStopCmd`。
6. 计算停泵命令：`stop_pumps = (段 auto/man || 线 auto/man) && pump_run`。

## 7. 线处理（`line_proc.js`）

- 汇总规则：
  - `pump_run`、`pre_stop_notice`：取各段同名属性的“或”；
  - `alarm_F`：取各段 `flow_alarm_F` 与 `press_alarm_F` 的“或”；
  - 均带 50 ms 防抖。
- `bypass` 变化时，写入所有段的 `bypass`。
- `pump_run` 下降沿时，清除线的 `autoStopCmd` / `manStopCmd`。

## 8. 动作记录（`action_record.js`）

- CSV 列取自 RECORD 中除 Word 类型和 `index` 以外的字段。
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
  - 为 -1 时清空时间字段；
  - 否则把对应记录装载到 data；越界时恢复为原值。
- 记录内容由段在 `action_F` 上升沿填写（见 6.2 节）；执行器位置的对应规则见第 11 节。

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
- 代码检查：Biome。

### 10.4 构建与发布

- `rolldown.config.js` 生成两个 ES 模块包：
  - `src/main.js` → `./main.js`；
  - `src/cli.js` → `./cli.js`，其中 `./main.js` 设为 external，所以 `cli.js` 运行时 import 的是同目录下的打包产物。
- `package.json` 的 `prepare` 脚本会触发构建；`bin.tlms` 指向 `cli.js`。

## 11. 未实现项

规范已有要求、但当前代码尚未实现的内容：

| 项 | 规范要求 | 代码现状 | 涉及位置 |
| --- | --- | --- | --- |
| 压力联锁按 `pressure_SD_F` 触发 | 只有 `pressure_SD_F` 为真的执行器压力报警时才触发压力停泵（规范 5.2） | 段的压力动作只判断 `press_alarm_F && pump_run`，`press_alarm_F` 汇总全部执行器的 `pressure_AH_F`；`pressure_SD_F` 只用于清除 `enable_pressure_SD` / `disable_pressure_SD` 命令位 | `section_proc.js` 的 `section_loop`、`update_press_alarm_F`；`node_proc.js` 的 `pressure_SD_F` 事件 |
| 按执行器配置屏蔽命令 | 每个执行器在配置中用 `supported_commands` 列出支持的命令，控制器只发送支持的命令，其余命令位直接复位（规范 5.1）；实现方式见 12.1 节 | 配置中没有该字段；`node_loop` 对所有执行器统一执行 `command.commands &= 0xB1`，只保留位 0、4、5、7（`stop_pumps`、`enable_pressure_SD`、`disable_pressure_SD`、`write_paras`），`cancel_stop` 也因此被复位 | `config.js` 的执行器解析；`node_proc.js` 的 `node_loop` |
| 动作记录按位置对应执行器（现有代码有缺陷） | 节点 1–4 按先首端、后末端的顺序依次对应动作段的执行器，每个位置的压力、ID、泵运行状态取自同一个执行器（规范 5.4） | 节点 1–3 固定取 `begin_nodes[0..2]`，节点 4 固定取 `end_nodes[0]`；`node1..3_pump_run` 取自 `pump_nodes[0..2]`（只含带泵执行器，与节点位置可能错位），`node4_pump_run` 从不赋值 | `section_proc.js` 中 `action_F` 的变化事件 |

实现方式：

- `press_alarm_F` 保持现状，继续汇总全部执行器的 `pressure_AH_F`，用于报警显示。
- 另设一个段级 Bool 作为压力联锁条件：先对每个执行器计算 `pressure_AH_F && pressure_SD_F`，再对段内所有执行器做“或”运算。`section_loop` 的压力动作改用这个变量代替 `press_alarm_F`。
- 执行器的 `pressure_AH_F` 或 `pressure_SD_F` 变化时，都要触发这个变量的重新计算。
- 目前阶段没有单独的压力联锁变量，由 `press_alarm_F` 兼任，所以段数据块中不需要这个字段。
- `pressure_SD_F` 参与后，这个压力联锁变量要作为新字段加入段数据块，点表随之调整。
- 变量为真且段内有泵运行时，置位段的 `autoStopCmd`，之后沿用现有停泵链路：段的 `stop_pumps` 置位，再由 `stop_pumps` 的变化事件给各带泵执行器的命令块置位停泵命令。
- 这和输差联锁的结构相同，区别在于范围和倒计时：输差一侧由 `flow_alarm_F` 等条件置位 `pre_stop_notice`，倒计时结束后置位线的 `autoStopCmd`，停整条线；压力一侧没有倒计时，直接置位段的 `autoStopCmd`，只停本段。将来压力联锁若改为停线，需改为置位线的 `autoStopCmd`，并同时考虑 `line_action_source` 和 `action_F` 复位逻辑的配合。

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
