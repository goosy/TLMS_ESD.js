# TLMS_ESD Modbus 点表

> 本文是 [spec.md](spec.md) 的子文档，描述 HMI/SCADA 通过 Modbus TCP 连接控制器时能看到的全部点量。
> 点表由 `src/structs/` 的定义生成，与代码不一致时以代码为准；说明文字参考 `data_structure2025.xlsx`，术语按 [spec.md](spec.md) 第 3 节统一。

## 1. 访问约定

- 控制器在 `controller.modbus_server.port` 上提供 Modbus TCP 服务（监听 `0.0.0.0`）。
- 每条线、每个段、每个执行器以及动作记录各占一个单元号（unit id），由控制器配置的 `modbus_server.unit_id` 指定。
- 同一单元内的地址都从 0 开始：
  - 线、段、动作记录单元：寄存器 0 起为该数据块；
  - 执行器单元：寄存器 0 起为节点数据块，寄存器 200 起为命令块。
- 保持寄存器与输入寄存器内容相同；寄存器可读写，写入后控制器立即按变化处理。
- 多寄存器数值（`Real`、`DInt`、`UDInt`）按大端存放，高位字在低地址（ABCD 顺序）。
- 位地址写作 `寄存器.位`，位号 0 为寄存器最低位。例如 `1.0` 表示寄存器 1 的最低位。
- 线圈：每个 Bool 也可按线圈访问，线圈地址 = 字节偏移 × 8 + 位。表中给出的是数据块内的线圈地址；命令块整体位于寄存器 200 起，访问其线圈时需加 3200。
- 表中“初值”是控制器启动时的值。线、段、执行器的 `ID`，以及段的限值、延时和 `action_time` 在启动时由配置覆盖；节点数据块在连上执行器后由执行器上报值覆盖。

## 2. 线（LINE，5 个寄存器）

| 寄存器 | 线圈 | 名称 | 类型 | 初值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 0 |  | status | Word | 0 | 线状态字 |
| 0.0 | 8 | bypass | Bool | false | 是否越站 |
| 0.1 | 9 | pump_run | Bool | false | 本线是否起泵输油 |
| 0.2 | 10 | alarm_F | Bool | false | 本线有报警 |
| 0.3 | 11 | autoStopCmd | Bool | false | 自动停输命令 |
| 0.4 | 12 | manStopCmd | Bool | false | 人工停输命令 |
| 0.5 | 13 | pre_stop_notice | Bool | false | 停泵预告 |
| 1 |  | ID | UInt | 0 | 本线ID号 |
| 2 |  | action_section_ID | UInt | 0 | 大流差动作管段的段号 |
| 3 |  | flow_diff | Real | 0 | 越站流差（保留，不实现） |

## 3. 段（SECTION，21 个寄存器）

| 寄存器 | 线圈 | 名称 | 类型 | 初值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 0 |  | ID | UInt | 0 | 段号 |
| 1 |  | bypass_word | Word | 0 | 越站字 |
| 1.0 | 24 | bypass | Bool | false | 本段超驰 |
| 2 |  | status | Word | 0 | 段状态字 |
| 2.0 | 40 | comm_OK | Bool | false | 本段所有执行器通讯正常 |
| 2.1 | 41 | work_OK | Bool | false | 本段所有执行器工作正常 |
| 2.2 | 42 | protect_F | Bool | false | 本段处于保护状态下 |
| 2.3 | 43 | hangon_AF | Bool | false | 本段自动挂起 |
| 2.4 | 44 | hangon_MF | Bool | false | 本段人工挂起 |
| 2.5 | 45 | action_F | Bool | false | 本段是否泄漏停泵 |
| 2.6 | 46 | flow_warning_F | Bool | false | 本段流量警告 |
| 2.7 | 47 | flow_alarm_F | Bool | false | 本段流量报警（预动作） |
| 2.8 | 32 | press_warning_F | Bool | false | 本段压力警告 |
| 2.9 | 33 | press_alarm_F | Bool | false | 本段压力报警（预动作） |
| 2.10 | 34 | autoStopCmd | Bool | false | 本段自动停泵 |
| 2.11 | 35 | manStopCmd | Bool | false | 本段人工停泵 |
| 2.12 | 36 | line_action_source | Bool | false | 本段是否为全线停输来源 |
| 2.13 | 37 | pump_run | Bool | false | 本段是否起泵输油 |
| 2.14 | 38 | pump_change_F | Bool | false | 当前时间段是否有泵操作 |
| 2.15 | 39 | pre_stop_notice | Bool | false | 本段准备停泵 |
| 3 |  | flow_begin | Real | 0 | 首端执行器流量合计 |
| 5 |  | flow_end | Real | 0 | 末端执行器流量合计 |
| 7 |  | flow_diff | Real | 0 | 流量差 |
| 9 |  | flow_diff_WH | Real | 20 | 流量警告差上限值 |
| 11 |  | flow_diff_WH_delay | DInt | 3000 | 流量警告容错时间（单位毫秒） |
| 13 |  | flow_diff_AH | Real | 50 | 流量差报警上限值（动作） |
| 15 |  | flow_diff_AH_delay | DInt | 3000 | 流量报警容错时间（单位毫秒） |
| 17 |  | action_time | DInt | 60000 | 联锁动作时间（单位毫秒） |
| 19 |  | countdown | Int | 0 | 联锁动作倒计时（单位秒） |
| 20 |  | inner_word | Word | 0 | 内部位字 |
| 20.0 | 328 | flow_warning_trigger | Bool | false | 流量触发警告 |
| 20.1 | 329 | flow_alarm_trigger | Bool | false | 流量触发报警 |
| 20.3 | 331 | stop_pumps | Bool | false | 本段执行停泵 |

`inner_word` 为控制器内部使用的触发位，HMI 只需读取。

## 4. 节点数据块（NODE，73 个寄存器，执行器单元寄存器 0 起）

节点数据块来自执行器，控制器周期读取后发布；`comm_OK`、`work_OK` 由控制器根据通信情况维护。

| 寄存器 | 线圈 | 名称 | 类型 | 初值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 0 |  | ID | UInt | 0 | 执行器ID |
| 1 |  | status | Word | 3 | 执行器状态字 |
| 1.0 | 24 | comm_OK | Bool | true | 用于维护执行器通讯状态 |
| 1.1 | 25 | work_OK | Bool | true | 用于维护执行器工作状态 |
| 1.2 | 26 | pump_run | Bool | false | 本执行器有泵运行 |
| 1.3 | 27 | pump_change_F | Bool | false | 本执行器是否处于泵操作延时 |
| 1.4 | 28 | pump_run_1 | Bool | false | 1#泵运行状态 |
| 1.5 | 29 | pump_run_2 | Bool | false | 2#泵运行状态 |
| 1.6 | 30 | pump_run_3 | Bool | false | 3#泵运行状态 |
| 1.7 | 31 | pump_run_4 | Bool | false | 4#泵运行状态 |
| 1.8 | 16 | pressure_enabled | Bool | false | 压力允许报警 |
| 1.9 | 17 | temperature_enabled | Bool | false | 温度允许报警 |
| 1.10 | 18 | pressure_SD_F | Bool | false | 压力允许联锁停输标志 |
| 1.11 | 19 | delay_protect | Bool | true | 延迟保护（暂不使用） |
| 1.12 | 20 | pressure_AH_F | Bool | false | 压力上上限标志 |
| 1.13 | 21 | pressure_WH_F | Bool | false | 压力上限标志 |
| 1.14 | 22 | pressure_WL_F | Bool | false | 压力下限标志 |
| 1.15 | 23 | pressure_AL_F | Bool | false | 压力下下限标志 |
| 2 |  | temperature | Real | 0 | 温度值 |
| 4 |  | pressure | Real | 0 | 压力值 |
| 6 |  | flowmeter | Real | 0 | 流量值 |
| 8 |  | response_code | Word | 0 | 执行应答（各位含义同命令字，置位表示该命令已执行）（G5无需响应码，应当改为UDInt） |
| 8.0 | 136 | stop_pumps | Bool | false | 停泵命令（应答位） |
| 8.1 | 137 | cancel_stop | Bool | false | 取消停泵（应答位） |
| 8.2 | 138 | horn | Bool | false | 输出报警（应答位） |
| 8.3 | 139 | reset_horn | Bool | false | 停止报警（应答位） |
| 8.4 | 140 | enable_pressure_SD | Bool | false | 设置压力联锁停泵（应答位） |
| 8.5 | 141 | disable_pressure_SD | Bool | false | 取消压力联锁停泵（应答位） |
| 8.6 | 142 | read_paras | Bool | false | 读取所有参数（应答位）（已不需要实际发送） |
| 8.7 | 143 | write_paras | Bool | false | 写参数命令（应答位） |
| 8.8 | 128 | enable_pressure_alarm | Bool | false | 允许压力报警（应答位） |
| 8.9 | 129 | disable_pressure_alarm | Bool | false | 禁止压力报警（应答位） |
| 8.10 | 130 | enable | Bool | false | 允许该执行器工作（应答位） |
| 8.11 | 131 | disable | Bool | false | 禁止该执行器工作（应答位） |
| 8.12 | 132 | reset_CPU | Bool | false | 重置CPU（应答位） |
| 8.13 | 133 | reset_conn | Bool | false | 重置连接（应答位） |
| 8.14 | 134 | reserve | Bool | false | 保留（应答位） |
| 8.15 | 135 | executing | Bool | false | 命令执行中（应答位） |
| 9 |  | temperature_zero_raw | Int | 0 | 温度原始零点值 |
| 10 |  | temperature_span_raw | Int | 27648 | 温度原始量程值 |
| 11 |  | temperature_underflow | Int | -500 | 温度下溢出设置值 |
| 12 |  | temperature_overflow | Int | 28000 | 温度上溢出设置值 |
| 13 |  | temperature_zero | Real | 0 | 温度零点值（以实际为准） |
| 15 |  | temperature_span | Real | 100 | 温度量程值（以实际为准） |
| 17 |  | temperature_AH | Real | 0 | 温度高高值 |
| 19 |  | temperature_WH | Real | 0 | 温度高值 |
| 21 |  | temperature_WL | Real | 0 | 温度低值 |
| 23 |  | temperature_AL | Real | 0 | 温度低低值 |
| 25 |  | temperature_DZ | Real | 0.5 | 温度比较死区 |
| 27 |  | temperature_FT | UDInt | 0 | 温度比较容错时间 |
| 29 |  | pressure_zero_raw | Int | 0 | 压力原始零点值 |
| 30 |  | pressure_span_raw | Int | 27648 | 压力原始量程值 |
| 31 |  | pressure_underflow | Int | -500 | 压力下溢出设置值 |
| 32 |  | pressure_overflow | Int | 28000 | 压力上溢出设置值 |
| 33 |  | pressure_zero | Real | 0 | 压力零点值（以实际为准） |
| 35 |  | pressure_span | Real | 4 | 压力量程值（以实际为准） |
| 37 |  | pressure_AH | Real | 0 | 压力高高值 |
| 39 |  | pressure_WH | Real | 0 | 压力高值 |
| 41 |  | pressure_WL | Real | 0 | 压力低值 |
| 43 |  | pressure_AL | Real | 0 | 压力低低值 |
| 45 |  | pressure_DZ | Real | 0.05 | 压力比较死区 |
| 47 |  | pressure_FT | UDInt | 0 | 压力比较容错时间 |
| 49 |  | reserve1 | Real | 0 | 预留（原流量数据） |
| 51 |  | reserve2 | Real | 0 | 预留 |
| 53 |  | reserve3 | Real | 0 | 预留 |
| 55 |  | invalid_value_of_AI | Real | -100000 | 模拟量无效时的预置值（暂时没实现） |
| 57 |  | delay_protect_time | UDInt | 5000 | 通讯中断延后挂起时间 |
| 59 |  | flow_smooth_factor | Real | 0.9 | 流量平滑权值 |
| 61 |  | equS1 | DInt | 10000 | 流量1当量 |
| 63 |  | equS2 | DInt | 10000 | 流量2当量 |
| 65 |  | equS3 | DInt | 10000 | 流量3当量 |
| 67 |  | equS4 | DInt | 10000 | 流量4当量 |
| 69 |  | equS5 | DInt | 10000 | 流量5当量 |
| 71 |  | pump_change_delay | UDInt | 180000 | 泵操作延时 |

## 5. 命令块（COMMAND，74 个寄存器，执行器单元寄存器 200 起）

寄存器 0–7 为控制器本地区，不与执行器交换；寄存器 8 起（`ID`、命令字、参数块）与执行器命令区交换。

- 命令：HMI 置位命令字中的相应位，控制器下发给执行器，收到应答后自动清除。
- 参数：参数块初始等于执行器上报的参数；HMI 修改参数后置位 `write_paras`，控制器把参数写回执行器。

| 寄存器 | 线圈 | 名称 | 类型 | 初值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 0 |  | response_code | Word | 0 | 执行器执行后的应答代码 |
| 1 |  | overtime | Int | 5000 | 应答超时设定 (毫秒) |
| 3 |  | extra_commands | Word | 0 | 扩展命令字 |
| 3.0 | 56 | has_commands | Bool | false | 当前有命令需要发送 |
| 3.1 | 57 | reset_paras | Bool | false | 将命令参数值重置为执行器参数值（将取消） |
| 8 |  | ID | UInt | 0 | 执行器ID |
| 9 |  | commands | Word | 0 | 命令字 |
| 9.0 | 152 | stop_pumps | Bool | false | 停泵命令 |
| 9.1 | 153 | cancel_stop | Bool | false | 取消停泵 |
| 9.2 | 154 | horn | Bool | false | 输出报警 |
| 9.3 | 155 | reset_horn | Bool | false | 停止报警 |
| 9.4 | 156 | enable_pressure_SD | Bool | false | 设置压力联锁停泵 |
| 9.5 | 157 | disable_pressure_SD | Bool | false | 取消压力联锁停泵 |
| 9.6 | 158 | read_paras | Bool | false | 读取所有参数（已不需要实际发送） |
| 9.7 | 159 | write_paras | Bool | false | 写参数命令 |
| 9.8 | 144 | enable_pressure_alarm | Bool | false | 允许压力报警 |
| 9.9 | 145 | disable_pressure_alarm | Bool | false | 禁止压力报警 |
| 9.10 | 146 | enable | Bool | false | 允许该执行器工作 |
| 9.11 | 147 | disable | Bool | false | 禁止该执行器工作 |
| 9.12 | 148 | reset_CPU | Bool | false | 重置CPU |
| 9.13 | 149 | reset_conn | Bool | false | 重置连接 |
| 9.14 | 150 | reserve | Bool | false | 保留 |
| 9.15 | 151 | executing | Bool | false | 命令执行中 |
| 10 |  | temperature_zero_raw | Int | 0 | 温度原始零点值 |
| 11 |  | temperature_span_raw | Int | 27648 | 温度原始量程值 |
| 12 |  | temperature_underflow | Int | -500 | 温度下溢出设置值 |
| 13 |  | temperature_overflow | Int | 28000 | 温度上溢出设置值 |
| 14 |  | temperature_zero | Real | 0 | 零点值 |
| 16 |  | temperature_span | Real | 100 | 量程值 |
| 18 |  | temperature_AH | Real | 0 | 高高值 |
| 20 |  | temperature_WH | Real | 0 | 高值 |
| 22 |  | temperature_WL | Real | 0 | 低值 |
| 24 |  | temperature_AL | Real | 0 | 低低值 |
| 26 |  | temperature_DZ | Real | 0.5 | 温度比较死区 |
| 28 |  | temperature_FT | UDInt | 0 | 温度比较容错时间 |
| 30 |  | pressure_zero_raw | Int | 0 | 压力原始零点值 |
| 31 |  | pressure_span_raw | Int | 27648 | 压力原始量程值 |
| 32 |  | pressure_underflow | Int | -500 | 压力下溢出设置值 |
| 33 |  | pressure_overflow | Int | 28000 | 压力上溢出设置值 |
| 34 |  | pressure_zero | Real | 0 | 零点值 |
| 36 |  | pressure_span | Real | 4 | 量程值 |
| 38 |  | pressure_AH | Real | 0 | 高高值 |
| 40 |  | pressure_WH | Real | 0 | 高值 |
| 42 |  | pressure_WL | Real | 0 | 低值 |
| 44 |  | pressure_AL | Real | 0 | 低低值 |
| 46 |  | pressure_DZ | Real | 0.05 | 压力比较死区 |
| 48 |  | pressure_FT | UDInt | 0 | 压力比较容错时间 |
| 50 |  | reserve1 | Real | 0 | 预留 |
| 52 |  | reserve2 | Real | 0 | 预留 |
| 54 |  | reserve3 | Real | 0 | 预留 |
| 56 |  | invalid_value_of_AI | Real | -100000 | 模拟量无效时的预置值（暂时没实现） |
| 58 |  | delay_protect_time | UDInt | 5000 | 通讯中断延后挂起时间 |
| 60 |  | flow_smooth_factor | Real | 0.9 | 流量平滑权值 |
| 62 |  | equS1 | DInt | 10000 | 流量1当量 |
| 64 |  | equS2 | DInt | 10000 | 流量2当量 |
| 66 |  | equS3 | DInt | 10000 | 流量3当量 |
| 68 |  | equS4 | DInt | 10000 | 流量4当量 |
| 70 |  | equS5 | DInt | 10000 | 流量5当量 |
| 72 |  | pump_change_delay | UDInt | 180000 | 泵操作延时 |

## 6. 动作记录（RECORD，27 个寄存器）

数据块显示一条记录。写入 `index` 选择要查看的记录：0 为最新，1 为上一条，依此类推；`-1` 表示没有记录。

| 寄存器 | 线圈 | 名称 | 类型 | 初值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 0 |  | year | Uint | 0 | 年 |
| 1 |  | month | Uint | 0 | 月 |
| 2 |  | day | Uint | 0 | 日 |
| 3 |  | hour | Uint | 0 | 时 |
| 4 |  | minute | Uint | 0 | 分 |
| 5 |  | second | Uint | 0 | 秒 |
| 6 |  | section_ID | UInt | 0 | 引发动作的段ID 为0表示还没有记录 |
| 7 |  | flow_begin | Real | 0 | 动作段首端执行器流量和 |
| 9 |  | flow_end | Real | 0 | 动作段末端执行器流量和 |
| 11 |  | flow_diff | Real | 0 | 动作段流差 |
| 13 |  | node1_press | Real | 0 | 动作段执行器1压力 |
| 15 |  | node2_press | Real | 0 | 动作段执行器2压力 |
| 17 |  | node3_press | Real | 0 | 动作段执行器3压力 |
| 19 |  | node4_press | Real | 0 | 动作段执行器4压力 |
| 21 |  | node1_ID | UInt | 0 | 动作段执行器1ID |
| 22 |  | node2_ID | UInt | 0 | 动作段执行器2ID |
| 23 |  | node3_ID | UInt | 0 | 动作段执行器3ID |
| 24 |  | node4_ID | UInt | 0 | 动作段执行器4ID |
| 25 |  | status | Word | 0 | 动作状态字 |
| 25.0 | 408 | press_action | Bool | false | 压力超限动作 |
| 25.1 | 409 | flow_action | Bool | false | 输差超限动作 |
| 25.2 | 410 | node1_pump_run | Bool | false | 动作段首端执行器1有开泵 |
| 25.3 | 411 | node2_pump_run | Bool | false | 动作段首端执行器2有开泵 |
| 25.4 | 412 | node3_pump_run | Bool | false | 动作段首端执行器3有开泵 |
| 25.5 | 413 | node4_pump_run | Bool | false | 动作段首端执行器4有开泵 |
| 26 |  | index | Int | -1 | 倒数第几个记录，0为最新 |

## 7. 与 2025 版点表（data_structure2025.xlsx）的差异

以下差异以代码为准，本文已按代码编写：

| 位置 | 2025 版点表 | 代码 |
| --- | --- | --- |
| 段数据块长度 | 22 个寄存器，寄存器 20 另有 `action_F_edge`、`stop_edge` | 21 个寄存器，无这两个位 |
| 节点数据块参数区寄存器 55–58 | `reserve4`（Real）、`delay_protect_time`（Real） | `invalid_value_of_AI`（Real）、`delay_protect_time`（UDInt） |
| 节点数据块 raw 量程 / 溢出初值 | 20000 / 20500 | 27648 / 28000 |
| 节点数据块 `response_code` 类型 | UInt | Word（按命令位组织） |
| 命令块参数 `delay_hangup` | 名称为 `delay_hangup` | 名称为 `delay_protect_time` |
| 动作记录状态字 | `node1..3_pump_run` | 另有 `node4_pump_run` |
