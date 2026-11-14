# Changelog

## v0.5.2 - 2026-11-14

It covers v0.5.1, which was never released on its own.

### Changed

- The pressure warning and pressure alarm of a section now take every node of the
  section into account, not only its begin nodes. A pressure alarm stops the pumps
  of its own section only.
- Communication delay protection: nodes and sections have a `delay_protect` flag,
  the command block gains `delay_protect_time` (its former flow fields become
  reserved), and communication state updates are debounced. The command block
  layout changes accordingly.
- The typed data layer is split into `TData`, `TTag` and `TGroup`, and the data
  structures of lines, sections, nodes, commands and the action record are
  generated from shared definitions.

### Fixed

- Driver read and write errors no longer abort the program; a single read error no
  longer resets `work_OK` immediately.
- Tag change event handling is reworked, and an emulator bug is fixed.

## v0.5.2 - 2026-11-14 (中文)

包含未单独发布的 v0.5.1 的内容。

### 变更

- 区段的压力预警和压力报警改为考虑区段内所有节点，而不仅是起始节点；压力报警只停本区段的泵。
- 通信延时保护：节点和区段增加 `delay_protect` 标志，命令块增加 `delay_protect_time`（原流量字段改为保留），通信状态更新加了防抖。命令块布局随之改变。
- 类型化数据层拆分为 `TData`、`TTag` 和 `TGroup`，管线、区段、节点、命令和动作记录的数据结构改由共享定义生成。

### 修复

- 驱动读写出错不再使程序异常中断；单次读取错误不再立即复位 `work_OK`。
- 重构标签值变化事件的处理，并修复一个模拟器缺陷。

## 2026-11-14

Versions before v0.5.2 were never tagged, and only v0.1.0 was formally released.
Their entries below are short summaries, one per minor series, kept for reference.

v0.5.2 之前的版本从未打标签，只正式发布过 V0.1.0，下面只按次版本系列简要记录，供参考。

## v0.5.0

- Drivers support the `LEBS` and `BEBS` device byte orders.

## v0.5.0 (中文)

- 驱动支持 `LEBS` 和 `BEBS` 设备字节序。

## v0.4.3

Covers v0.4.0 to v0.4.3.

- Section, line and node processing is reworked: a stop command goes only to
  running pumps, and the pressure and flow actions of the action record are no
  longer swapped.
- CLI: the default subcommand is `help`; the pm2 process is always named
  `tlms_esd`, and `tlms start` removes the previous instance first.
- Fixed an error when the controller name is omitted.

## v0.4.3 (中文)

包含 v0.4.0 至 v0.4.3。

- 重构区段、管线和节点的处理：停泵命令只发给运行中的泵；动作记录中的压力动作和流量动作不再颠倒。
- CLI：默认子命令改为 `help`；pm2 进程名固定为 `tlms_esd`，`tlms start` 会先删除上一个实例。
- 修复省略控制器名称时的错误。

## v0.3.1

Covers v0.3.0 to v0.3.1.

- The Modbus TCP driver uses the `es-modbus` package; the driver API changes.
- Logging moves from winston to log4js behind a wrapping logger.

## v0.3.1 (中文)

包含 v0.3.0 至 v0.3.1。

- Modbus TCP 驱动改用 `es-modbus` 包，驱动 API 随之改变。
- 日志由 winston 改为 log4js，并做了封装。

## v0.2.4

Covers v0.2.0 to v0.2.4.

- Action record of pump-stop actions, and logging of controller and section actions.
- Modbus TCP driver API refactored; a workaround for an S7 endpoint bug.

## v0.2.4 (中文)

包含 v0.2.0 至 v0.2.4。

- 增加停泵动作记录，以及控制器和区段动作的日志。
- 重构 Modbus TCP 驱动 API；规避 S7 端点的一个缺陷。
