# TLMS_ESD Specification (Draft)

> English version of [spec.zh-cn.md](spec.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document was reverse-engineered from the existing code and describes what the system does and why. For the implementation see [design.md](design.md).

## 1. Goals

TLMS_ESD (Pipeline Leakage Emergency Shutdown System) protects oil pipelines against leakage. A pipeline is organized in lines and sections, with measurement and control points at both ends of each section. The system monitors them continuously and shuts down automatically on anomalies:

- **Flow difference monitoring**: when the flow difference of a section (total flow at the begin end minus total flow at the end end) exceeds the warning value (WH), the system raises a warning; when it exceeds the alarm value (AH), the whole line is shut down. A countdown precedes the shutdown, and an operator can interrupt it during the countdown.
- **Pressure monitoring**: when the pressure of a measurement point exceeds the warning value (WH), the system raises a warning; when it exceeds the alarm value (AH), the section of that point is shut down, without a countdown. The pressure shutdown can be enabled or disabled per measurement point.
- **Hang-on**: the flow difference protection works per section. While a section is hung on, the system no longer stops pumps because of its flow difference, but alarms are still raised. The system hangs a section on automatically on a communication failure, an abnormal measurement point (such as a faulty measuring device), during a period after pumps start or stop, and so on; while the measuring devices are under maintenance, the section must be hung on manually to avoid false actions. Hang-on does not affect the pressure shutdown.
- **Central monitoring and traceability**: the states of lines, sections and measurement points are collected and offered to the HMI/SCADA for monitoring and operation, and every interlock shutdown action is recorded.

This project implements only the controller program; the programs on the measurement point side are implemented by the actuators (see section 3).

## 2. Scope

### 2.1 Included

- Reading the YAML configuration and running one of its controllers by name;
- Communication with actuators over two protocols: Modbus TCP and Siemens S7;
- Section-level flow difference alarm, pressure alarm aggregation, interlock pump stop and cancel stop;
- Line-level bypass, alarm aggregation, automatic / manual stop pump commands;
- Publishing actuator parameters and writing them back, sending actuator commands;
- Interlock action records (persisted as CSV, the latest N records browsable over Modbus);
- Logging;
- The command-line tool `tlms`, which runs and manages controller instances in the background.

### 2.2 Not included

- The PLC programs of the actuators (pressure limit checks and the actual pump start / stop are done by the actuators);
- HMI screens;
- Line-level flow difference (`LINE.flow_diff` is reserved and not implemented).

## 3. Terminology and object model

### 3.1 Core terms

The system has only two kinds of runtime entities:

- **Controller**: this program. A controller is one TLMS process. It manages several lines as configured, polls actuator data periodically, evaluates flow differences and interlocks, and acts as a Modbus TCP server that offers all state to the HMI/SCADA. The HMI/SCADA communicates only with the controller.
- **Actuator**: a PLC in the field and its program, not part of this project. An actuator acquires flow, pressure, temperature and pump running states, checks pressure limits, reports its own working state, and stops pumps and changes parameters on the controller's commands. An actuator is a Modbus TCP or S7 server, and the controller connects to it.

### 3.2 Nodes and actuators

- **Node**: a measurement and control point at an end of a section. A node has its own flow, pressure, temperature and pump running states, and occupies one data area and one command area on its actuator.
- Relation between actuators and nodes: an actuator usually corresponds to one node, but may also hold two or more nodes, which may belong to different lines or sections.
- Simplification in the program: the controller treats each node as an independent actuator.
  - Each entry of `actuators` in the configuration and each actuator object in the code corresponds to one node;
  - Several nodes on the same actuator are written as several `actuators` entries, each with its own data area and command area; under Modbus TCP they share the IP and port;
  - The controller keeps one node data block (NODE) and one command block (COMMAND) per node, both sharing the Modbus unit id of the node (the node ID, see 4.1).
- So both words, "node" and "actuator", appear in the configuration and the code, but they correspond essentially one to one. When this document describes the processing of the controller it says "actuator", meaning such an object with one node per actuator.
- An actuator with `pumps` configured is called an actuator with pumps; it is the target of stop pump commands.

### 3.3 Logical objects in the controller

The following objects exist only inside the controller, to organize actuators and aggregate states:

| Object | Description |
| --- | --- |
| Line | A pipeline, made of several sections, belonging to one controller. |
| Section | A piece of pipe with nodes at both ends: the begin actuators (`begin_nodes`) and the end actuators (`end_nodes`). The section is the basic unit of flow difference evaluation, hang-on and interlock. |
| Action record | A snapshot of the field when an interlock pump stop happens. |

Relations: controller 1-N lines, line 1-N sections, section N-N actuators (the same actuator can be a begin or end actuator in different sections).

### 3.4 Division of evaluation and protection

| Evaluation | Where | Processing |
| --- | --- | --- |
| Flow difference over limit | Controller | Computes the flow difference per section; above WH for the delay, warns; above AH for the delay, issues the stop pump notice and counts down; when the countdown ends, shuts down the whole line. |
| Pressure over limit | Actuator | The actuator checks the pressure limits and reports `pressure_AH_F`, together with whether the pressure interlock shutdown is allowed (`pressure_SD_F`); only for actuators that allow the pressure interlock, the controller shuts down the section immediately when their pressure is in alarm and a pump in the section is running, without a countdown. |
| Hang-on | Controller | The section's `hangon_AF` (automatic hang-on) and `hangon_MF` (manual hang-on). It applies only to the flow difference interlock: a hung-on section does not stop pumps because of the flow difference, and a manual hang-on during the countdown interrupts the shutdown. The pressure interlock is not restricted by hang-on. |

### 3.5 Deployment

- One controller connects to several actuators, each with one or more nodes:
  - Modbus TCP: the nodes of the same actuator share the IP and port and are distinguished by address, e.g. the data of the first node at register 0 and its commands at register 100, the next node at 200 and 300;
  - S7: data and commands are in different DBs, e.g. DB1 and DB2.
- The `IP` of a controller in the configuration records the deployment address of the controller itself; the program does not read it, and the server always listens on all addresses.

### 3.6 Data blocks, TTags and variables

The state inside the controller is of two kinds, which discussions and documents must keep clearly apart:

| Term | Meaning | Nature |
| --- | --- | --- |
| Data block (TData) | The block of data of a line, section, node, command or action record, whose layout is given by the data structure definition | The bridge between actuators, HMI and controller |
| TTag | A named entry of a data block, e.g. `press_alarm_F` of a section | External interface (API) |
| Variable | An ordinary program variable on a controller object, belonging to no data block | Internal implementation, free to change |

Data blocks must meet the following requirements:

- **Fixed layout**: each TTag has a definite type, byte offset and bit number; the same layout is both the memory image of the actuator data / command area and the register point table of the HMI (see [spec-modbus.md](spec-modbus.md)).
- **Valid layout**: a layout must satisfy the following rules; an invalid layout is a program error:
  - TTag names are distinct within a data block;
  - the bit length of each TTag matches its type; multi-byte types (Int, UInt, Word, DInt, UDInt, DWord, Real) start at an even byte, single-byte types (Byte, SInt, USInt) at a whole byte, and a Bool may be at any bit;
  - the byte ranges of non-Bool TTags do not overlap;
  - each bit belongs to at most one Bool TTag;
  - a Bool inside the byte range of a non-Bool TTag must be a component bit of that TTag (a combined word); conversely, each component bit of a combined word must lie within the range of the word;
  - the total length of a data block is a whole number of registers (a multiple of 16 bits).
- **Layout validation**: at startup the controller validates the layouts of all data blocks; on violations it reports all of them and refuses to start; the configuration check command (see 5.6) runs the same validation.
- **Combined word bit numbers**: in a 16-bit combined word, bit k of the word value is bit k of the register, guaranteed by the offset numbering of the bits in the layout; neither inside the controller nor at the upward server or the driver boundary are bytes swapped additionally for combined words.
- **Exchange with drivers**: a data block holds the buffer exchanged with the actuator, read and written as a whole or in groups through the Modbus TCP or S7 driver; the device byte order is converted only at this boundary, and inside the controller everything is big-endian.
  - For Bool and single-byte TTags, the device byte order applies per 16-bit register containing them: under byte orders that swap the two bytes of a register, a Bool or single-byte TTag lies in the other byte of the same register on the device, with the same bit number.
- **Write unit**: the smallest unit written to an actuator is set by the protocol. Under Modbus TCP the controller uses only holding registers (function code 03 for reading, 06 / 16 for writing), and the write unit is one register; under S7 the write unit is one byte. A group write writes only the write units holding the TTags of the group.
- **Write ownership**: TTags written by the controller and TTags written by the actuator must not share a write unit, so that a write of one side does not overwrite the data of the other. Adding or adjusting TTags must follow this rule.
- **Upward publishing**: data blocks are mounted on the Modbus TCP server of the controller, and the HMI reads and writes their content directly.
- **Access by name**: the program reads and writes TTag values by name.
- **Change events**: when the value of a TTag changes (whether read from the actuator, written by the HMI or assigned by the program), a change event is emitted after the new value takes effect; business logic implements its interplay by subscribing to events.
- **Combined word linkage**: a status word / command word made of Bools is linked with its bits in both directions.
- **Group synchronization**: several TTags can be grouped and synchronized with the actuator as a whole.

TTags are the interface:

- Adding or removing a TTag, or changing the name, type, offset or meaning of a TTag, is a protocol change: the actuator programs and the HMI must change accordingly, and the point table must be updated.
- Protocol changes should be concentrated in the version planning, to avoid repeated changes of the point table.
- State used only inside the controller, which need not be exchanged with the actuators or the HMI, must be implemented as variables, and must not take space in a data block for that (including unused bits of internal bit words such as `inner_word`).
- A proposal for new state must say whether it is a TTag or a variable; unless a layout change has been confirmed, it is a variable by default.

## 4. Configuration requirements

- All `*.yaml` / `*.yml` files in the working directory are read and merged; YAML 1.1 merge keys (`<<`) are supported.
- Top-level keys: `controllers`, `lines`, `sections`, `actuators`.
- Controller:
  - `name`, `records_size` (number of action records kept, default 10);
  - `modbus_server.port`;
  - Modbus unit ids are no longer configured: the unit id of a line, section or actuator is its ID, and the action record is fixed at unit id 0 (see 4.1).
- Line:
  - `id`, `name`;
  - `controller`: name of the controller it belongs to;
  - `sections`: list of section names.
- Section:
  - `id`, `name`;
  - `begin_nodes`, `end_nodes`: lists of actuator names;
  - `flow_diff_WH` / `flow_diff_WH_delay`: flow difference warning limit and its delay (ms);
  - `flow_diff_AH` / `flow_diff_AH_delay`: flow difference alarm limit and its delay (ms);
  - `action_time`: interlock countdown (ms).
- Actuator (`actuators`):
  - `id`: must be a non-zero number, otherwise the program exits;
  - `name`, `IP`;
  - `pumps`: optional, each entry of the form `"running signal, stop output"`;
  - one of `modbus_server` or `s7_server`, each able to configure the `data` and `commands` areas; the area start `start` is in bytes, and under Modbus corresponds to register `start / 2` (e.g. `start: 200` is register 100);
  - `supported_commands`: list of supported commands (see the command support configuration in 5.1);
  - `endian`: byte order, default `BE`.
- The configuration files are also the basis for programming the actuators; the controller takes only the parts relevant to itself:
  - Actuator fields taken by the controller: `id`, `name`, `IP`, the protocol with its data / command areas, whether `pumps` is configured, the list of supported commands;
  - The IDs, limits, delays and `action_time` of sections and lines are the initial values of the corresponding data blocks;
  - The other actuator fields (pressure / temperature ranges and limits, `pressure_SD`, `pressure_AI`, `temperature_AI`, `flows`, pump signal addresses) are for programming the actuators, and the controller does not take them directly;
  - Actuator parameters and states follow what the actuator reports; the controller publishes them and writes them back to the actuator on HMI commands (see 5.1).

### 4.1 ID rules

- The `id` of all lines, sections and actuators (nodes) must be distinct.
- The uniqueness applies across types: lines, sections and actuators must not repeat each other's IDs either; e.g. the ID of a section must not equal the ID of any actuator.
- Several data blocks of the same object share the object's ID, which is not a duplicate. E.g. an actuator has both a node data block and a command block, and both share the ID of the actuator.
- The ID is also the unit id of the object on the Modbus TCP server of the controller (see 5.5), so:
  - the ID must be a valid Modbus unit id, and at least 1;
  - unit id 0 is reserved for the action record.
- These rules are validated by the configuration check (see 5.6); a violation is a configuration error.

## 5. Functional requirements

### 5.1 Actuators

- Read the actuator data periodically: ID, status word (communication / working OK, pump running, the states of each pump, pressure / temperature alarm enables and limit flags), temperature, pressure, flow, command response code, parameter block.
- On a communication failure or a data read failure, after the delay of the parameter `delay_protect_time`, set `comm_OK` / `work_OK` to false respectively.
- 2 s after the communication recovers, refresh the parameters in the command block with the current parameters of the actuator, so that the HMI sees the same parameters as the field.
- Command enumeration: the table below is the complete list of commands, all of which the controller must implement. The command names are used in the HMI point table (see section 5 of [spec-modbus.md](spec-modbus.md)) and in the command support configuration of actuators; the bit is the position of the command in the command word, agreed with the actuators, and must not change.

  | Bit | Command | Effect | Source |
  | --- | --- | --- | --- |
  | 0 | `stop_pumps` | Stop pumps | Interlock logic (see 5.2) |
  | 1 | `cancel_stop` | Cancel stop, so the actuator releases the stop pump output | Interlock logic (see 5.2) |
  | 2 | `horn` | Output alarm | HMI |
  | 3 | `reset_horn` | Stop alarm | HMI |
  | 4 | `enable_pressure_SD` | Enable the pressure interlock pump stop | HMI |
  | 5 | `disable_pressure_SD` | Disable the pressure interlock pump stop | HMI |
  | 6 | `read_paras` | Read parameters: refresh the parameters in the command block with the current parameters of the actuator, without sending to the actuator | HMI |
  | 7 | `write_paras` | Write parameters: write the parameters in the command block to the actuator | HMI |
  | 8 | `enable_pressure_alarm` | Enable the pressure alarm | HMI |
  | 9 | `disable_pressure_alarm` | Disable the pressure alarm | HMI |
  | 10 | `enable` | Allow the actuator to work | HMI |
  | 11 | `disable` | Forbid the actuator to work | HMI |
  | 12 | `reset_CPU` | Reset the actuator CPU | HMI |
  | 13 | `reset_conn` | Reset the connection | HMI |

  Bit 14 (`reserve`) of the command word is reserved, and bit 15 (`executing`) is a status bit; neither is a command. A new command must be added to this list first.

- Command handshake:
  - After a command is set, the controller sends the command word together with the ID and the parameter block to the actuator;
  - The actuator acknowledges the executed command bits with `response_code`, and the controller clears those command bits when it receives it;
  - The enable / disable pressure interlock pump stop commands are cleared when the `pressure_SD_F` reported by the actuator reaches the corresponding state;
  - Without an acknowledgement for 3 consecutive cycles, the command is sent again.
- Stop and cancel stop:
  - Normally, after the controller issues `stop_pumps`, the actuator stops the pumps and the reported pump running state becomes false; the controller then withdraws `stop_pumps`, and `cancel_stop` is not needed;
  - Abnormally, the pump running state may stay true (e.g. a faulty state signal). Even after the controller withdraws `stop_pumps`, the actuator keeps its stop pump output, which is not released because of the pump state and prevents the other pumps on the same actuator from starting;
  - So when the stop command is withdrawn, the controller must send `cancel_stop` to the actuators concerned, which then release the stop pump output.
- Command support configuration: different actuators may support different commands. Each actuator lists the commands it supports (taken from the command enumeration above) in the configuration, and the controller sends an actuator only the commands it supports; the controller resets unsupported command bits directly without sending them, and the HMI sees those bits reset.
  - The configuration field is `supported_commands`, whose value is a list of command names taken from the command enumeration, for example:

    ```yaml
    actuators:
    - id: 1001
      name: A1
      supported_commands:
        - stop_pumps
        - cancel_stop
    ```

  - When `supported_commands` is omitted, all commands are supported by default

### 5.2 Sections

- `comm_OK` / `work_OK`: true when all actuators of the section are OK.
- `pump_run` / `pump_change_F`: true when any actuator with pumps has a pump running / a pump in the start-stop transition.
- `press_warning_F` / `press_alarm_F`: true when any actuator has a pressure warning / alarm.
- Flow:
  - `flow_begin` is the sum of the flows of the begin actuators, `flow_end` the sum of the flows of the end actuators;
  - `flow_diff = flow_begin - flow_end`.
- Flow difference evaluation (not evaluated while the section is bypassed, `bypass`):
  - After the flow difference stays above `flow_diff_WH` for `flow_diff_WH_delay`, `flow_warning_F` is set;
  - After it stays above `flow_diff_AH` for `flow_diff_AH_delay`, `flow_alarm_F` is set.
- Protection state:
  - When communication is OK, work is OK, no pump is in a start-stop transition, the section is not bypassed and not hung on manually (`hangon_MF`), the section is in the protection state (`protect_F`);
  - When any of the first four conditions fails, the section is hung on automatically (`hangon_AF`).
- Stop pump notice:
  - When `flow_alarm_F`, `pump_run` and `protect_F` all hold, the stop pump notice (`pre_stop_notice`) is issued and the `action_time` countdown starts (`countdown`, in s);
  - When the countdown ends and the conditions still hold, the flow interlock is executed;
  - When any condition disappears during the countdown (e.g. a manual hang-on clears `protect_F`), the countdown is reset and the shutdown is interrupted.
- Interlock actions:
  - Flow interlock (stop the line): sets the section's `action_F`, records the line's `action_section_ID`, sets the line's `autoStopCmd`, and marks this section as the line action source (`line_action_source`). The stop command of the line applies to all sections of the line, and every section with a pump running stops its pumps;
  - Pressure interlock: when `pressure_AH_F` is true for any actuator of the section whose `pressure_SD_F` is true, and a pump of the section is running, sets the section's `action_F` and the section's `autoStopCmd`. An actuator whose `pressure_SD_F` is false only raises an alarm and does not trigger a pump stop. The pressure interlock is not restricted by hang-on (`protect_F`). For now the pressure interlock stops only this section; it may be extended to stop the line in the future.
  - The section's `press_alarm_F` still aggregates `pressure_AH_F` of all actuators, for the alarm display, whether the pressure interlock is allowed or not.
- Pump stop: when an automatic / manual stop command exists on the section or its line and a pump of this section is running, a stop pump command is issued to all actuators with pumps of this section; when the command is withdrawn, a cancel stop command is issued.
- Reset:
  - After all pumps stop, the section's `autoStopCmd` / `manStopCmd` are cleared;
  - When a pump restarts, if the alarms have disappeared and the action is not held by a stop command, `action_F` and the line's `action_section_ID` are cleared automatically.
- Every time `action_F` is set, an action record is created (see 5.4).

### 5.3 Lines

- `pump_run`: true when any section has a pump running;
- `alarm_F`: true when any section has a flow alarm or a pressure alarm;
- `pre_stop_notice`: true when any section is in the stop pump notice;
- `bypass`: the bypass state of the line is passed to all sections of the line;
- After all pumps of the line stop, the line's `autoStopCmd` / `manStopCmd` are cleared;
- `manStopCmd` is written by the HMI, for a manual pump stop.

### 5.4 Action records

- Content:
  - Time (year / month / day / hour / minute / second), ID of the action section;
  - Begin and end flows and the flow difference;
  - Pressure, ID and pump running state of the actuators of the action section, in 4 fixed positions (nodes 1-4);
  - Action reason: the pressure reason (`press_action`) takes the section's `press_alarm_F`, the aggregation of the pressure alarms of all actuators; the flow reason (`flow_action`) takes the section's `flow_alarm_F`.
- Actuator positions:
  - The 4 fixed positions keep the data structure compatible with the original PLC controller; variable-length records are not supported;
  - The 4 positions do not distinguish begin and end: the actuators of the action section take nodes 1-4 in order, begin actuators first, then end actuators; e.g. with 2 begin actuators and 2 end actuators, they take nodes 1, 2 and nodes 3, 4;
  - The pressure, ID and pump running state of each position come from the same actuator;
  - When the section has more than 4 actuators, only the first 4 are recorded; unused positions are 0 / false.
- Persistence: appended to `action_records.csv` in the working directory, created automatically when missing.
- Browsing: the latest `records_size` records are kept in memory; the HMI writes `index` (0 is the latest) to switch the displayed record; `index = -1` means no record.

### 5.5 Upward interface (Modbus TCP server)

- The controller listens on `controller.modbus_server.port` at address `0.0.0.0`.
- Each line, each section, each actuator and the action record take one unit id each: the unit id of a line, section or actuator is its ID (see 4.1), and the action record is fixed at unit id 0.
- In an actuator unit, the node data block starts at register 0 and the command block at register 200.
- Reading and writing holding registers, reading input registers, and reading and writing coils are supported. A write from the HMI triggers the processing of the resulting state changes immediately.
- The register layouts of the data blocks are defined by `src/structs/` and must stay consistent with the HMI and the actuator programs. The complete point table is in [spec-modbus.md](spec-modbus.md).

### 5.6 Running and operation

- The controller runs as a resident background process, independent of a login session; only one controller instance runs at a time, and starting one stops the existing instance first.
- The command-line tool `tlms` supports:
  - starting with a configuration directory and a controller name (`start`), and restarting (`restart`, same as `start`);
  - stopping (`stop`);
  - listing the instances running in the background (`list`);
  - viewing the log (`log`) and clearing the logs (`flush`);
  - checking whether the configuration is valid (`check`): reads and validates the configuration in the given configuration directory, reports all errors, and does not start the controller; the validation includes the ID rules of 4.1 and the data block layout rules of 3.6;
  - running in the foreground (`debug`) with log level debug, for debugging;
  - showing the version and help.
- When the controller name is omitted, the first controller of the configuration runs.
- Logging:
  - Normal logs and error logs are written to `logs/info_<date>.log` and `logs/error_<date>.log` in the working directory (a date such as `2026-11-14`), rolled daily, each file limited to 10 MB and compressed;
  - When running in the foreground, the logs are also written to the console;
  - The log level is set by the environment variable `LOG_LEVEL`, default `info`.
- Uncaught exceptions are only logged and do not exit the process, so that the protection keeps running.

## 6. Performance and timing

- Main loop period 500 ms (`MAIN_PERIOD`); the flow difference delays and the countdown accumulate in this step.
- Driver polling period 1 s; reconnect 5 s after a disconnection.
- State aggregation is debounced by 50 ms, command sending by 100 ms.

## 7. Implementation constraints

- Implemented in JavaScript.
- Communication with actuators must support both Modbus TCP and Siemens S7; upward, only a Modbus TCP server is offered.
- The configuration format is YAML, the action records are persisted as CSV.
- The runtime environment, dependencies, process management and build are in section 10 of [design.md](design.md).
