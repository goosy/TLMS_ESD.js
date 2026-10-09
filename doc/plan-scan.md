# 数据层与扫描周期重构：迁移计划

> 目标设计见 [design-scan.md](design-scan.md)，本文只安排步骤和验证方式，不重复设计内容。代码实现以 spec 和 design 系列为准。

## 1. 原则

- **每一步独立可交付**：结束时 `pnpm test` 和 Biome 检查全部通过，可以单独提交、单独回退。
- **行为变化集中在后段**：第 1～5 步对外行为不变（只换内部机制）；时序变化只出现在第 6～8 步，且每一步只引入 design-scan.md 第 9 节和 7.5 节末尾列出的变化。
- **先有测试，再换实现**：每一步先补足能约束该步行为的测试，在旧实现上通过，再替换实现。
- **规范随行为变化同步修改**：哪一步改变了规范所描述的行为，哪一步同时修改 `doc/spec.md` 的对应条目。
- **design.md 最后合并**：迁移期间 design.md 继续描述当时的代码；第 8 步把 design-scan.md 并入 design.md 后删除 design-scan.md 和本文。
- **工作分支**：在 `dev` 上新建 `refactor/scan` 分支，每步一个或数个提交，全部完成后合并回 `dev`。
- **前置条件**：es-modbus 升级到 v0.3（见第 2 节前置步骤）在 `dev` 上先完成，`refactor/scan` 从升级之后的 `dev` 建立。

## 2. 步骤总览

**前置步骤（在 `dev` 上完成，不属于本次重构）**：es-modbus 从 v0.1.4 升级到 v0.3，对齐其破坏性变更（vector 改为 `snake_case` 命名、`write()` 以是否回显兑现、错误改为 `Error`、客户端自带指数退避重连和失效连接检测、支持 6 位与结构化 PDU 地址）。Binding 直接建立在驱动的读写结果和连接事件之上（design-scan.md 4.3、4.4 节），对上服务端的写入入口也在步骤 3 改动，所以先升级，避免对驱动接口的适配和测试做两遍。升级时需要明确重连由哪一层负责（`Base_Driver` 的 `reconnect_time` 与 es-modbus 自带的重连），因为它决定 `connected` 状态的含义。

| 步骤 | 内容 | 对应设计 | 对外行为 |
| --- | --- | --- | --- |
| 0 | 测试基线与确认项 | — | 不变 |
| 1 | Layout、编解码表、原型访问器 | 第 2 节 | 不变 |
| 2 | Observer 与两种检测模式，TTag 可读写，取消值缓存和 coupling 联动 | 第 3、5 节、10.1 节 | 不变（事件顺序见确认项 0.2） |
| 3 | 拆出 Binding，TData 原始写入方法 | 第 3、4 节 | 不变 |
| 4 | 调度器、规则、排序、Ticker（不接入） | 第 6、7 节 | 不变 |
| 5 | 接入扫描骨架 | 6.1、6.2 节、10.2 节 | 不变 |
| 6 | 派生量改为 derive 规则 | 7.5 节 | 去掉状态汇总防抖 |
| 7 | 动作、命令和连接状态改为 act 规则 | 7.5 节 | 去掉命令发送防抖；7.5 节末尾两点 |
| 8 | 清理，合并文档 | 第 8 节 | 不变 |

## 3. 各步骤

### 步骤 0：测试基线与确认项

改动：

1. **抽出测试夹具**：把 `test/section_proc_test.js` 中的 `build_line()` 和 `settle()` 移到 `test/harness.js`，扩展为可以构建“线 + 段 + 执行器（data、command、假驱动）”的完整对象图，并用 `create_fake_driver` 模拟执行器。
   - 测试只通过“设置输入 → `settle()` → 断言输出”的方式编写，不依赖事件触发的时刻；
   - `settle()` 现在实现为等待超过防抖链的时间；第 5 步起改为驱动调度器扫描，测试用例本身不改。
2. **补充行为测试**，覆盖 design-scan.md 7.5 节表中每一行现有处理，至少包括：
   - 执行器：`pump_run` 汇总、`response_code` 握手、`pressure_SD_F` 清命令位、`read_paras` / `write_paras`、`commands` 发送与 3 周期重发、命令屏蔽；
   - 段与线：各汇总量、输差延时、倒计时及人工挂起中断、压力 / 输差动作的置位与复位、`stop_pumps` / `cancel_stop` 下发、线 `flow_override` 总闸、`autoStopCmd` / `manStopCmd` 清除、动作记录；
   - 对上服务端：经 `Unit_Map` 的 vector 写寄存器、写线圈后，对应 tag 事件发出、联动处理执行。
3. **确认项**（结果记入本文第 5 节）：
   - 0.1 es-modbus 处理功能码 15 / 16 时，是否在同一个同步调用中依次调用 vector（决定 design-scan.md 3.2 节的合并结论是否成立）；
   - 0.2 现有处理器中，有没有依赖“组合字与组成位事件先后顺序”的（design-scan.md 10.1 节）；
   - 0.3 现有处理器中，有没有依赖“同一 tag 在一次处理中多次变化分别发出事件”的（第 8 步合并事件后不再成立）。
4. **基准测试脚本**：把快照比对的基准脚本加入 `bench/`（不随 `pnpm test` 运行），作为第 2 步的性能对照。

完成标准：新测试在现有实现上全部通过；三个确认项有结论。

### 步骤 1：YAML 布局、Layout、编解码表、原型访问器

改动：

- 布局描述改为 YAML（design-scan.md 2.1 节）：把 `src/structs/*.js` 的结构定义转换为 `src/layouts.yaml`（逐条保留注释为 `comment`），由 `src/layouts.js` 编译并导出；删除 `src/structs/` 目录，`build_structure` 和 `validate_structure` 移入数据层。转换前后展开得到的条目逐项相同（转换时一次性比对）。
- 构建：rolldown 把 `layouts.yaml` 复制到 `main.js` 同目录；`.gitignore` 忽略这份复制品。
- 新增 `src/typed_data/codecs.js`（`CODECS`）和 `src/typed_data/layout.js`：`compile_layout(yaml_path)`、`layout_of(data_struct)`、`tags_at_byte`、`Data_Class` 生成。同一结构只编译一次（以结构对象为键缓存）。
- 按组件边界（design-scan.md 1.1 节）：`build_structure` / `validate_structure` 移到 `src/typed_data/structure.js`；新代码出错时抛出异常，不用项目日志器。
- `TData` 构造函数改为基于 Layout：`new TData(NODE, name)` 的现有调用方式保留（内部取缓存的 Layout），访问器来自原型。
- 本步保留 TTag 的值缓存和 `check_change` / `check_coupling`，setter 仍然“写 buffer → 检查变化 → 联动”，事件行为完全不变；TTag 的按类型 switch 改为查 `CODECS`。
- `validate_structure` 的保留名称表随 TData 成员调整。
- 类型声明：生成 `src/layout_types.d.ts`（第 4 节 D1），新增 `pnpm gen:types` 脚本和一致性测试。

验证：现有 `ttag_test`、`tdata_test`、`tgroup_test`、`layout_test` 和第 0 步的行为测试全部通过；新增 Layout 单元测试（YAML 片段引用、内联列表、`length` 省略、引用不存在的片段、`tags_at_byte`、组合字与组成位共字节、编解码往返）；`pnpm build` 后在示例配置下运行打包产物。

### 步骤 2：Observer 与检测模式

改动：

- 新增 `src/typed_data/observer.js`：快照比对、`previous()`、`scan_snapshot`（design-scan.md 第 5 节）。
- TData 支持两种检测模式（spec-data-api.md 4.2 节，实现见 design-scan.md 3.3 节）：立即（默认）和延迟（`detect()`）；`on_write` 在两种模式下都于写入后调用，立即模式下在检测之后；控制器使用立即模式（design-scan.md 3.3 节）。
- TTag 不再持有值：`value` 可读可写，写入与 `data[name] = v` 等价；`change` 事件由 Observer 发出（spec-data-api.md）。
- 删除 TTag 的值缓存、`check_change`、`check_coupling`；`build_structure` 仍保留 coupling 名称，供布局校验判断组成位。
- 组件边界：TData、TTag、Observer 不再使用项目日志器和 `process.exit`，出错时抛出异常；现有 `assert_exits` 类测试相应改为断言异常。
- `TGroup.read()` 改为“逐 tag 原始装载 → 一次检测”；`check_all_tags()` 改名为 `detect()`，做一次检测；`layout` 改为只读属性。

验证：全部测试通过；新增 Observer 单元测试（只改组成位、只改组合字、改后恢复、NaN、嵌套赋值、迭代上限）和两种检测模式的测试，以及 spec-data-api.md 中每项承诺的测试；运行 `bench/` 与第 1 步对比。

### 步骤 3：拆出 Binding，TData 原始写入方法

改动：

- 新增 `src/drivers/binding.js`（与驱动放在一起，不属于数据层，design-scan.md 1.1 节）：绑定参数检查（抛出错误而不是退出）、`io_index`、分组的所有权掩码与写区间、`request_read` / `load` / `request_write` / `flush_writes`、连接与完成状态（4.4 节，本步只记录，不被使用）。
- `create_group(...names)` 取代 `create_tag_group`；`TGroup` 删除。
- 本步尚无调度器：读取完成后立即 `load` 并比对，写请求立即 `flush_writes`，保持现有时序。
- TData 增加 `write_register` / `write_bit` / `write_bytes`；`Unit_Map` 的 vector 改用它们。写入后按检测模式处理（立即模式下写入后立即检测）。
- `node_proc.js` 改用 Binding；`TData.set_IO` 删除。
- 启动流程中对 Binding 抛出的错误统一记录日志并退出，保持“配置错误拒绝启动”的行为。
- 新增“禁止直接写 buffer”的检查测试（3.2 节）。
- 组件边界：`create_vector` 与 `Unit_Map` 从 `drivers/modbusTCP.js` 迁入 `src/typed_data/`，日志器改为构造参数注入；`createMTServer` 留在驱动中并使用它们。TData 去掉 `set_IO` 后不再依赖 TGroup / Binding。

验证：

- 等价性测试：在测试文件中保留一份现有 `read_from` / `write_to` 的字节序转换实现作为对照，对 4 种字节序、Modbus 与 S7 两种写入单元、随机缓冲区内容，比较新旧装载 / 导出结果逐字节相同；
- 现有 `tgroup_test` 的写区间用例迁移到 Binding 后全部通过；
- 第 0 步的行为测试全部通过。

### 步骤 4：调度器、规则、排序、Ticker

改动（只新增模块，不接入运行流程）：

- `src/scan.js`：调度器（design-scan.md 6.5 节的接口；`request_scan` 的合并与扫描各阶段中请求的处理、`scan(tick)` 的四个阶段、`running_tickers`、出错隔离、扫描结束时保存 tdata / Binding 状态 / 登记变量的值，以及 `previous` / `rose` / `fell` / `changed`）。
- `src/rules.js`：`derive` / `act` 声明（含打断环用的 `reads_previous`）、依赖键、拓扑排序、启动检查（design-scan.md 7.4 节全部）、`Ticker`、`on_delay` / `off_delay`。
- 数据层的访问追踪钩子 `set_access_tracer`，以及调度器的依赖追踪测试模式（design-scan.md 7.6 节）。

验证：单元测试覆盖排序（含读改写、同键多写入者按声明顺序、跨层级依赖示例、用 `reads_previous` 打断环）、全部启动检查、Ticker 与 `on_delay` / `off_delay` 的计时语义（design-scan.md 7.3 节逐条）、`request_scan` 的合并与各阶段中请求的处理、出错隔离、边沿判断（tdata、Binding 状态、登记的变量）、依赖追踪测试模式。

### 步骤 5：接入扫描骨架

改动：

- `run_controller` 创建调度器，`setInterval` 改为周期 tick 调用 `scan(true)`。
- 执行器数据读取改为：tick 扫描的输出阶段 `request_read()`，完成后置 `fresh` 并请求扫描，输入阶段装载。
- 线、段、执行器 tdata 的 `on_write` 接到 `request_scan()`：立即模式下的写入（包括经 `Unit_Map` 的 HMI 写入）检测之后也请求扫描（design-scan.md 10.1 节）。
- `section_loop` / `node_loop` 包装为粗粒度 act 规则，按现有顺序（先段后执行器）执行，不参与排序检查，只在周期 tick 的扫描中执行；启动时先做一次初始扫描（design-scan.md 10.2 节）。
- 控制器仍使用立即检测模式，现有事件处理器和防抖原样工作。
- 测试夹具不变：它用模拟定时器推进周期 tick，并在每一步之间让 `setImmediate` 执行，触发扫描随之完成。

行为：数据读回到装载之间只差一次 `setImmediate`，其余不变。

验证：全部测试通过；用 `pnpm dev` 在示例配置下启动，确认启动、日志、对上服务端读写正常（执行器不在线时 `comm_OK` 按延时变为 false）。

### 步骤 6：派生量改为 derive 规则

一个提交，包括两部分：

- 汇总类：删除执行器 `pump_run` 的“或”运算（以执行器上报值为准，见 design-scan.md 7.5 节）；段的 `comm_OK`、`work_OK`、`press_warning_F`、`press_alarm_F`、`pump_run`、`pump_change_F`、`flow_begin`、`flow_end`、`flow_diff`、触发位、`press_SD_trigger`、`pre_stop_notice`；线的 `pump_run`、`alarm_F`、`pre_stop_notice`。
- `section_loop` 中的派生部分：`protect_F` / `hangon_AF`、输差警告 / 报警延时（各一条规则，用 `on_delay`）、倒计时 `countdown`、`action_F`、`stop_pumps`。`section_loop` 的粗粒度规则只剩动作部分。

每迁移一项，同时删除对应的事件订阅、`update_*` 函数和 `debouncify` 包装。段和线的规则在对象图建好之后声明（design-scan.md 7.4 节），新增的变量见 design-scan.md 7.5 节；剩下的粗粒度规则声明读写的键（design-scan.md 10.2 节）。

删除 `test/section_proc_test.js`：它直接调用本步删除的 `update_*` 和改变后的 `section_loop`；其场景已由系统测试覆盖，唯一例外“跨段不抹掉 `action_section_ID`”在步骤 7 写成规则级的单元测试。

规范：修改 `doc/spec.md` 第 6 节，删除“状态汇总带 50 ms 防抖”，写入“执行器数据读回、HMI 写入后立即处理”和“延时、倒计时按主循环周期累计”。

验证：全部测试通过；打开依赖追踪测试模式运行行为测试，确认声明与实际读写一致（尚未改写的事件处理器的访问列为已知例外，见 design-scan.md 10.2 节）；新增“倒计时期间人工挂起，在 HMI 写入后的那次扫描中即中断”的测试。

### 步骤 7：动作、命令和连接状态改为 act 规则

一个提交，包括三部分：

- 段与线的动作：压力动作、输差动作、`autoStopCmd`、`line_action_source`、`action_section_ID`、动作记录；`pump_run` 下降沿清除命令；`stop_pumps` / `cancel_stop` 下发。联锁动作每次扫描都执行。删除 `section_loop` 粗粒度规则。
- 执行器命令：应答握手、`pressure_SD_F` 清命令位、`read_paras` / `write_paras`（用 `write_done` 状态）、命令发送改为登记 `request_write(commands_payload)`、3 周期重发（用 Ticker，每个执行器单独计时）、按执行器配置的命令屏蔽（`supported_commands`，design.md 12.1 节，取代统一的 `& 0xB1`）。命令 Binding 以只写方式登记到调度器（design-scan.md 6.5 节）。删除 `debounce_send_commands` 和 `node_loop` 粗粒度规则。
- 连接状态：驱动事件只更新 Binding 状态；`comm_OK`、`work_OK`、连接后 2 s 刷新参数改为 act 规则；删除对应的驱动事件回调和 `setTimeout`。测试夹具中的驱动改为先断开、启动后再连接，与真实驱动一致。

规则只写组成位、不写组合字（design-scan.md 7.1 节）：握手和屏蔽改为按名逐位清除命令位。

规范：修改 `doc/spec.md` 第 6 节，删除“命令发送带 100 ms 防抖”，写入“由此产生的命令立即发出”和“通信中断延时按主循环周期累计”。

验证：全部测试通过；新增测试覆盖 7.5 节末尾两点差异（`delay_protect_time` 按周期步长；读取在延时内恢复不再出现短暂的 `work_OK = false`）；新增“HMI 写命令后，命令在同一次扫描的输出阶段写出”的测试。

### 步骤 8：清理，合并文档

改动：

- 审查全部剩余事件处理器，按 design-scan.md 第 8 节的编码约定，派生逻辑都已写成规则。
- 删除 `debouncify` / `debounce` 和 TTag 的旧接口残留。
- 控制器仍使用立即检测模式（design-scan.md 3.3 节），不切换。

规范：修改 `doc/spec.md` 3.4 节（新增“输入信号去抖由执行器完成”）和 3.6 节“变化事件”（design-scan.md 第 9 节）。

文档：把 design-scan.md 并入 design.md（重写第 3、5、6、7 节，更新第 1、2、9 节中相关描述），删除 design-scan.md 和本文。

验证：全部测试通过；`pnpm dev` 冒烟运行；运行 `bench/` 记录最终结果。

## 4. 已决事项

| 编号 | 事项 | 结论 | 实施步骤 |
| --- | --- | --- | --- |
| D1 | 由布局生成的类型声明是否纳入版本库 | 纳入：由 `layouts.yaml` 生成到 `src/layout_types.d.ts`，由测试检查与布局一致，避免忘记重新生成 | 步骤 1 |
| D4 | 布局描述的来源 | 改为单个 YAML 文件（design-scan.md 2.1 节）；多文件 / 目录以后再支持 | 步骤 1 |
| D3 | 7.5 节末尾两点行为差异是否接受 | 接受 | 步骤 7 |

## 5. 确认项结论

步骤 0 完成后填写：

| 编号 | 结论 | 影响 |
| --- | --- | --- |
| 0.1 | 已由源码确认：es-modbus v0.3.0-beta.2 的 `ModbusServer.js` 在处理功能码 15 / 16 时，在一个同步循环中对每个点调用 `set_coil` / `set_register`。步骤 0 补一个测试固定这一行为 | design-scan.md 3.2 节的合并结论成立 |
| 0.2 | 待确认 | |
| 0.3 | 待确认 | |
