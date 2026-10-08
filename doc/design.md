# TLMS_ESD Design (Draft)

> English version of [design.zh-cn.md](design.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document was compiled from the existing code and describes how the system works: architecture, data structures, algorithms and internal mechanisms. For the requirements see [spec.md](spec.md).

## 1. Modules

| Path | Responsibility |
| --- | --- |
| `src/cli.js` | The `tlms` command line: parses arguments, calls pm2 or directly `import('./main.js')`. |
| `src/main.js` | Process entry: reads the configuration, builds the controller, creates the TData and mounts them on the Modbus server, starts the main loop. |
| `src/gcl.js` | YAML loader (`yaml` library, YAML 1.1), keeping source line information. |
| `src/config.js` | Merges several configuration documents, fills in defaults, builds the name and ID indexes. |
| `src/init.js` | `prepare_controller`: builds the runtime object graph for the selected controller. |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | Initialization (event binding) and periodic processing of actuators (nodes), sections and lines. |
| `src/action_record.js` | Action records: CSV reading and writing, and browsing by index. |
| `src/drivers/` | `Base_Driver`, `MTClient` (Modbus TCP client), `S7Client`, and `createMTServer` / `Unit_Map` (upward server). |
| `src/typed_data/` | `TData` / `TTag` / `TGroup`: typed buffers and change events. |
| `src/structs/` | Memory layout definitions of LINE, SECTION, NODE, COMMAND, RECORD. |
| `src/util.js` | log4js logging, `debouncify` / `debounce`, `Object.mixin`. |

## 2. Startup

1. `cli.js` first calls `process.chdir(--path)`, then does one of:
   - `start`: `pm2 delete tlms_esd`, then `pm2 start main.js -- <controller>` with `TLMS=controller` set, so that the logs do not go to the console;
   - `debug`: rewrites `process.argv[2]`, sets `LOG_LEVEL=debug`, then imports `main.js` dynamically.
2. `main.js` calls `read_config(process.cwd())`:
   1. `readdir` lists all `*.ya?ml` in the working directory;
   2. each file is parsed into a JS object by `GCL.load`;
   3. each document is processed by `add_conf`.
3. `add_conf` stores each object both in an array (`push`) and as a property of the same array (`[name]`, lines / sections / actuators also `[ID<id>]`), so `cfg_*` can be iterated and looked up by key. Processing of actuators:
   - parses the `pumps` strings;
   - normalizes `modbus_server` / `s7_server` into `{data, commands, endian, ...}` with defaults;
   - when the pressure and temperature limits are missing, takes the range limits.
4. After all documents are merged, lines are linked to controllers and sections to lines by name (objects referencing each other).
5. `prepare_controller(name)`:
   1. selects the controller (the first one when empty or 0);
   2. builds new, reduced runtime objects `line` / `section` / `actuator`;
   3. the `driver_info` of an actuator carries the protocol, the address and the data / command areas;
   4. actuators are also put into `section.begin_nodes` / `end_nodes` / `pump_nodes` by begin, end and pump station.
6. `run_controller`:
   1. initializes the action record and mounts it on `unit_id.action_records`;
   2. creates the TData in the order line -> section -> actuator, calls `attach_unit`, then each `*_init`;
   3. starts the Modbus TCP server;
   4. runs `section_loop` of all sections and `node_loop` of all actuators with `setInterval(MAIN_PERIOD = 500)` (`line_loop` is empty and not called).

## 3. Typed data layer

The external requirements and terminology of data blocks (TData) and TTags are in section 3.6 of the spec; this section describes the implementation.

### 3.1 Layout definitions (`src/structs/`)

- Each item contains `{ name, type, offset, length, init_value }`; `offset` and `length` are in bits.
- `type` values (case-insensitive): `Bool`, `Byte`, `SInt`, `USInt`, `Int`, `UInt`, `Word`, `DInt`, `UDInt`, `DWord`, `Real`.
- A `Word` item with `coupling` is a status word or command word made of Bools; `is_combined: true` links the whole word and its bits in both directions. The `offset` of each coupling entry is relative to the start of the word.
- `{ includes: [...], offset }` splices in a group of shared items (such as `node_parameters`), shifted as a whole.
- `share.js#build_structure` expands the items into a flat `items`, computes the total length `length` of the structure, and normalizes coupling into an array of names.
- Bool position rule: `byte = offset >> 3`, `bit = offset % 8`. The internal buffer is big-endian, so the first byte of a word is the high byte of the register; coupling offsets 8-15 are register bits 0-7, offsets 0-7 bits 8-15. The definition files list 8-15 before 0-7, i.e. in the order of register bit 0 to bit 15; bit k of the word value is register bit k, and the `0xB1` mask is computed with these bit numbers.
- The point table in [spec-modbus.md](spec-modbus.md) is computed from these definitions by the rules above.
- Items other than Bool / Byte must be word aligned (even bytes), otherwise the program reports an error at startup and exits.
- These layouts are the memory images of the Modbus register table and of the actuator data areas; changing any offset is a protocol change.

Main layouts (byte offsets):

| Structure | Key TTags |
| --- | --- |
| NODE | 0 ID; 2 status; 4 temperature; 8 pressure; 12 flowmeter; 16 response_code; parameter block from 18 |
| COMMAND | 0 response_code (deprecated); 2 overtime (deprecated); 6 extra_commands (`has_commands`, `reset_paras`); 16 ID; 18 commands; parameter block from 20 |
| SECTION | 0 ID; 2 bypass_word; 4 status; 6 flow_begin; 10 flow_end; 14 flow_diff; 18-34 limits and delays; 38 countdown; 40 inner_word (internal trigger bits) |
| LINE | 0 status; 2 ID; 4 action_section_ID; 6 flow_diff (reserved) |
| RECORD | 0-10 time; 12 section_ID; 14-36 flows and pressures; 42-48 actuator IDs; 50 status; 52 index |

### 3.2 TData

- Exposes two buffers:
  - `buffer`: the internal value buffer, always big-endian (BE); the Modbus server reads and writes it directly as big-endian;
  - `IO_buffer`: the buffer exchanged with drivers, in device byte order.
- Each item creates a `TTag`, and a property of the same name is defined on the TData:
  - the getter returns `tag.value`;
  - the setter calls `tag.set_value`, then `check_coupling`, so that a combined word and its bits refresh each other.
- When any tag changes, the TData emits `change(tagname, old, new)`; the tag itself emits `change(old, new)`. Business logic subscribes with `data.get(name).on('change', ...)`.
- After `buffer` is written directly from outside (writes from the server), `check_all_tags()` compares the cached values with the buffer one by one and emits the missed change events.
- `set_IO(driver, {remote_start, start, length, endian}, ...extras)` binds a driver:
  - the local `IO_buffer[start .. start+length)` corresponds to the remote area of the same length from `remote_start`;
  - `extras` is passed to the driver as is: `unit_id` for Modbus, `area, db` for S7;
  - creates `IO_read_all` (reads the whole area into `IO_buffer`), `IO_write` (writes by range) and `create_tag_group`.

### 3.3 TTag

- Each tag holds the subarray of its own part of `buffer` and caches its current value `value`. `check_change` compares the cached value with the value in the buffer; when they differ, it updates the cache and emits an event, always after the new value has taken effect.
- `read_from(IO_buffer, endian)` / `write_to(IO_buffer, endian)` convert between the device byte order and the internal big-endian:
  - 2 bytes: `BE` copies as is; `LE` / `little` / `BEBS` swap the two bytes;
  - 4 bytes: the four orders `BE`, `LE` / `little`, `BEBS`, `LEBS` are supported;
  - Bool is read and written by bit, Byte is not converted.

### 3.4 TGroup

- `create_tag_group(...names)` returns a group of tags to be synchronized with the device together.
- When a tag is added, a binary search merges the byte ranges of the tags into contiguous write ranges (`#areas`), and adjacent ranges are joined automatically. On overlapping ranges:
  - a Bool may fall inside an existing range;
  - an overlap of other types is a configuration error, and the program exits.
- `read()`: first `IO_read_all`, then each tag of the group calls `read_from`, which triggers the change events.
- `write()`: each tag of the group first calls `write_to` into `IO_buffer`, then `IO_write` is called for each merged range.
- `copy_from(tdata)`: copies the values of the tags of the same name from another TData, used to synchronize the parameter block between data and command.

## 4. Drivers

### 4.1 Base_Driver

- Mixed in with `Object.mixin(this, new Base_Driver())`: it only adds the properties the subclass lacks, and does not override those the subclass defines itself, such as `start_tick`.
- `start()` runs `start_tick` every `period_time` (1000 ms) and emits `tick` when connected.
- `emit_data_ok` / `emit_data_error` wrap the result of every read and write:
  - on the first error, `data_error` is emitted;
  - when no read or write succeeds within `reconnect_time` (5000 ms), `on_error` is called, which emits `connfailed`.
- Driver instances are reused by connection parameters:
  - Modbus by `host:port`;
  - S7 by `host:port rack slot`;
  - calling `start()` several times on the same driver does not create timers again.

### 4.2 MTClient (es-modbus)

- Address conversion: areas in the configuration and in TData are in bytes; the byte start `start` corresponds to holding register `40000 + (start >> 1) + 1`, and the length is `length >> 1` registers.
- Reconnection uses the mechanism of es-modbus itself; `start_tick` is overridden to only emit `tick`.

### 4.3 S7Client (@st-one-io/nodes7)

- Reads and writes the `DB` or `M` area with `readArea` / `writeArea`; start and length are in bytes.
- Because `S7Endpoint.connect()` is incomplete, the library's own `autoReconnect = 5000` is used for now, and `start_tick` is overridden too (marked as temporary code in the source).

### 4.4 Upward server (createMTServer + Unit_Map)

- `Unit_Map.attach_unit(unit_id, tdata, start)` mounts a TData on the byte range `[start, start + size)` of a unit; a unit can hold several TData.
  - Actuator unit: data at byte 0, command at byte 400 (i.e. from register 200).
- Register `addr` corresponds to byte `addr * 2`, read and written big-endian in `tdata.buffer`; coil `addr` corresponds to bit `addr % 8` of byte `addr >> 3`.
- After every write, `tdata.check_all_tags()` is called, which turns the write of the HMI into tag change events.
- Accesses to unmapped addresses log an error; reads return 0 or false.

## 5. Actuator processing (`node_proc.js`)

### 5.1 IO binding

- data:
  - binds the whole structure, with the remote start `driver_info.data.start`;
  - `data_payload` contains the ID, the status bits, the measured values, `response_code` and the parameter block (not `comm_OK`, which the controller maintains itself);
  - `data_parameters` contains only the parameter block.
- command:
  - binds from local byte 16 (skipping the local area 0-15), with the remote start `driver_info.commands.start`;
  - `commands_payload` contains the ID, commands and the parameter block.

### 5.2 Periodic processing

`node_loop` runs every 500 ms:

1. When the driver is connected, runs `data_payload.read()`.
2. Command masking: `command.commands &= 0xB1`, keeping bits 0, 4, 5, 7 for all actuators alike (see sections 11 and 12).
3. When `has_commands` has been true for more than 3 cycles, the commands are sent again (`debounce_send_commands`).

### 5.3 Events

- Driver events:
  - `connfailed`: sets `comm_OK = false` after the delay `delay_protect_time`;
  - `connect`: sets `comm_OK = true` and runs `reset_parameters` 2 s later (command parameter block <- data);
  - `data_error`: sets `work_OK = false` after the delay.
- Change of `response_code` (acknowledgement handshake):
  1. `commands &= ~response_code` clears the acknowledged command bits;
  2. `executing = false`;
  3. if `response_code` is still not 0, the commands are sent once more (so the actuator sees that the command bits are cleared).
- Change of `commands`: updates `has_commands` and calls `commands_payload.write()` with a 100 ms debounce.
- `read_paras`: copies the parameters in data to command, then resets the bit in nextTick.
- `write_paras`:
  1. copies the parameters in command to `data_parameters`;
  2. writes the parameter block of the actuator data area;
  3. resets the bit after the write completes.
- Change of `pressure_SD_F`: clears the corresponding enable or disable command bit and sends the commands.
- Aggregating state changes upward:
  - on changes of `comm_OK`, `work_OK`, `pump_run`, `pump_change_F`, `pressure_WH_F`, `pressure_AH_F`, calls `section.update_*`;
  - on changes of `flowmeter`, calls `update_flow_begin` / `update_flow_end` by the begin / end role of the actuator in the section;
  - on changes of `pump_run_1..4`, `pump_run` takes their OR; when `pump_run` becomes false, the actuator's `stop_pumps` command is cleared.

## 6. Section processing (`section_proc.js`)

### 6.1 Aggregation functions

`get_update_fn(op, ...)` creates a function that aggregates an actuator property by AND / OR / ADD, wrapped with `debouncify(key, fn, 50)`. The timers of `debouncify` are kept in a module-level table and distinguished by a string key, so the key must be globally unique (of the form `section<name>_<prop>_update`).

### 6.2 Event-driven part (`section_init`)

- On changes of `flow_begin` / `flow_end`, recomputes `flow_diff`.
- On changes of `flow_diff`, computes the trigger bits:
  - `flow_warning_trigger = flow_diff > flow_diff_WH && !bypass`;
  - `flow_alarm_trigger = flow_diff > flow_diff_AH && !bypass`.
- On changes of `flow_alarm_F`, `protect_F`, `pump_run`, updates `pre_stop_notice = flow_alarm_F && pump_run && protect_F`; on changes of `flow_alarm_F`, `press_alarm_F`, also updates the line's `alarm_F`.
- Change of `stop_pumps`:
  - when true, sets `command.stop_pumps = node.data.pump_run` for each actuator with pumps;
  - when false, sets `stop_pumps = false` and `cancel_stop = true`.
- Rising edge of `action_F`: fills in `Action_Record.data`, then calls `add_record()`.
- Change of `pump_run`:
  - falling edge: clears the section's `autoStopCmd` / `manStopCmd`;
  - rising edge: if the flow and pressure alarms have both disappeared, `action_F` is true, and there is neither `autoStopCmd` nor `line_action_source`, clears `action_F` and the line's `action_section_ID`;
  - in both cases, updates this section's `pre_stop_notice` and the line's `pump_run`.

### 6.3 Periodic part (`section_loop`)

Runs every 500 ms:

1. Computes the protection state:
   - `protect_prereq = comm_OK && work_OK && !pump_change_F && !bypass`;
   - `protect_F = protect_prereq && !hangon_MF`;
   - `hangon_AF = !protect_prereq`.
2. Delay counting: while a trigger bit is true, its counter adds 500 ms per cycle, otherwise it is reset; when the count exceeds `*_delay`, `flow_warning_F` / `flow_alarm_F` is set.
3. Countdown:
   - while `pre_stop_notice` is true, `action_count` accumulates, and `countdown = (action_time - action_count) / 1000`;
   - when the result is below 0, `countdown` is set to 0 and a `flow_action` occurs.
4. Pressure action: when `press_alarm_F && pump_run`, sets `action_F`, the line's `action_section_ID` and the section's `autoStopCmd`. `protect_F` is not checked, so it is not restricted by hang-on; the actuators' `pressure_SD_F` is not checked either for now (see section 11).
5. Flow action: sets `action_F`, the line's `action_section_ID`, the line's `autoStopCmd` and `line_action_source`; without a flow action, `line_action_source &&= line.autoStopCmd`.
6. Computes the stop command: `stop_pumps = (section auto/man || line auto/man) && pump_run`.

## 7. Line processing (`line_proc.js`)

- Aggregation rules:
  - `pump_run`, `pre_stop_notice`: the OR of the properties of the same name of the sections;
  - `alarm_F`: the OR of `flow_alarm_F` and `press_alarm_F` of the sections;
  - all with a 50 ms debounce.
- On changes of `bypass`, writes `bypass` of all sections.
- On the falling edge of `pump_run`, clears the line's `autoStopCmd` / `manStopCmd`.

## 8. Action records (`action_record.js`)

- The CSV columns are the TTags of RECORD except the Word types and `index`.
- At startup:
  1. writes the header when the file does not exist;
  2. reads all rows as a stream and keeps the latest `records_size` with `unshift`, the newest first;
  3. restores the types of the columns.
- `add_record()`:
  1. writes the current time;
  2. puts the record at the head of the in-memory list;
  3. sets `index = 0`;
  4. appends a row with `appendFile`.
- Change of `index`:
  - when -1, clears the time TTags;
  - otherwise loads the corresponding record into data; when out of range, restores the previous value.
- The record content is filled in by the section on the rising edge of `action_F` (see 6.2); the rule for actuator positions is in section 11.

## 9. Logging

- log4js has two categories:
  - `default`: writes `logs/info.log` and `logs/error.log` with the date pattern `yyyy-MM-dd` of the file appender (`alwaysIncludePattern`, `keepFileExt`, `fileNameSep: "_"`), so the actual file names are `logs/info_<yyyy-MM-dd>.log` and `logs/error_<yyyy-MM-dd>.log` (rolled daily, each file limited to 10 MB, compressed); also writes to the console when `TLMS !== 'controller'`;
  - `console`: writes only to the console.
- `logger` is a wrapper object that can switch categories.

## 10. Runtime environment, dependencies and build

### 10.1 Runtime environment and process management

- Runtime environment: Node.js; the sources are ES modules (using `import ... with { type: 'json' }` and `import.meta.dirname`).
- Background running uses pm2 (a peer dependency):
  - `tlms start` first runs `pm2 delete tlms_esd`, then `pm2 start` with the fixed process name `tlms_esd`, so only one instance exists at a time;
  - `stop`, `list`, `log`, `flush` correspond to `pm2 delete`, `pm2 list`, `pm2 log`, `pm2 flush`;
  - pm2 starts with `TLMS=controller` set, and the logging module turns off the console output accordingly.

### 10.2 Dependencies

| Library | Use |
| --- | --- |
| `es-modbus` | Modbus TCP client (to the actuators) and server (to the HMI) |
| `@st-one-io/nodes7` | S7 client (to the actuators) |
| `yaml` | Configuration parsing (YAML 1.1, with merge keys) |
| `csv-parser` | Reading the action record CSV |
| `log4js` | Logging |
| `mri` | Command-line argument parsing |

### 10.3 Development tools

- Package manager: pnpm.
- Tests: `node --test`.
- Linting: Biome.

### 10.4 Build and release

- `rolldown.config.js` produces two ES module bundles:
  - `src/main.js` -> `./main.js`;
  - `src/cli.js` -> `./cli.js`, with `./main.js` set as external, so `cli.js` imports the bundle in the same directory at run time.
- The `prepare` script of `package.json` triggers the build; `bin.tlms` points to `cli.js`.

## 11. Unimplemented items

Requirements of the spec that the current code does not implement yet:

| Item | Spec requirement | Current code | Locations |
| --- | --- | --- | --- |
| Pressure interlock triggered by `pressure_SD_F` | A pressure pump stop is triggered only when an actuator whose `pressure_SD_F` is true is in pressure alarm (spec 5.2) | The pressure action of the section checks only `press_alarm_F && pump_run`, and `press_alarm_F` aggregates `pressure_AH_F` of all actuators; `pressure_SD_F` is used only to clear the `enable_pressure_SD` / `disable_pressure_SD` command bits | `section_loop`, `update_press_alarm_F` in `section_proc.js`; the `pressure_SD_F` event in `node_proc.js` |
| Command masking by actuator configuration | Each actuator lists its supported commands with `supported_commands` in the configuration; the controller sends only supported commands and resets the other command bits directly (spec 5.1); for the implementation see 12.1 | The configuration has no such field; `node_loop` runs `command.commands &= 0xB1` for all actuators alike, keeping only bits 0, 4, 5, 7 (`stop_pumps`, `enable_pressure_SD`, `disable_pressure_SD`, `write_paras`), so `cancel_stop` is reset too | Actuator parsing in `config.js`; `node_loop` in `node_proc.js` |
| ID uniqueness check | The IDs of lines, sections and actuators are all distinct (across types); several data blocks of the same object share its ID (spec 4.1) | `config.js` only checks that an actuator `id` is a non-zero number; lines, sections and actuators are each indexed by `ID<id>`, and neither duplicates nor equal IDs across types are reported; a duplicate of the same type silently overwrites the earlier one | `add_conf` in `config.js` |
| ID as the upward unit id | The Modbus unit id of a line, section or actuator is its ID (at least 1), the action record is fixed at unit id 0, and the controller configuration no longer has `unit_id` (spec 4.1, 5.5) | `run_controller` looks up the unit id by name in `controller.modbus_server.unit_id[name]` (the action record in `unit_id.action_records`), and every object must be listed in the controller configuration | `run_controller` in `main.js` |
| Configuration check command | `tlms check` reads and validates the configuration and reports all errors, without starting the controller (spec 5.6) | No such command; configuration errors are found only at startup, and most of them exit or crash directly | `cli.js`; `config.js` needs a separately callable validation function that collects all errors |
| Action record positions mapped to actuators (defect in the existing code) | Nodes 1-4 map to the actuators of the action section in order, begin actuators first, then end actuators; the pressure, ID and pump running state of each position come from the same actuator (spec 5.4) | Nodes 1-3 always take `begin_nodes[0..2]`, node 4 always takes `end_nodes[0]`; `node1..3_pump_run` come from `pump_nodes[0..2]` (actuators with pumps only, which may be misaligned with the node positions), and `node4_pump_run` is never assigned | The change event of `action_F` in `section_proc.js` |

Implementation:

- `press_alarm_F` stays as it is and keeps aggregating `pressure_AH_F` of all actuators, for the alarm display.
- A separate section-level Bool is the pressure interlock condition: first compute `pressure_AH_F && pressure_SD_F` for each actuator, then OR it over all actuators of the section. The pressure action of `section_loop` uses this variable instead of `press_alarm_F`.
- A change of an actuator's `pressure_AH_F` or `pressure_SD_F` triggers the recomputation of this variable.
- At present there is no separate pressure interlock variable; `press_alarm_F` serves as it, so the section data block does not need a TTag for it.
- Once `pressure_SD_F` takes part, this pressure interlock variable is added to the section data block as a new TTag, and the point table is adjusted accordingly.
- When the variable is true and a pump of the section is running, the section's `autoStopCmd` is set, then the existing stop chain follows: the section's `stop_pumps` is set, and the change event of `stop_pumps` sets the stop command in the command block of each actuator with pumps.
- This has the same structure as the flow difference interlock; the differences are scope and countdown: on the flow side, `pre_stop_notice` is set by `flow_alarm_F` and other conditions, and after the countdown the line's `autoStopCmd` is set, stopping the whole line; on the pressure side there is no countdown, and the section's `autoStopCmd` is set directly, stopping only this section. If the pressure interlock is changed to stop the line in the future, it must set the line's `autoStopCmd` instead, and its interplay with `line_action_source` and the reset logic of `action_F` must be considered as well.

## 12. Command processing

All commands go through the common handshake of 5.3 (send the command word, clear the corresponding bits on receiving `response_code`); some commands also have local processing in the controller:

| Command | Command word bit | Controller processing |
| --- | --- | --- |
| `stop_pumps` | 0 | Set by the section's `stop_pumps`; withdrawn when the actuator's pump running state becomes false |
| `cancel_stop` | 1 | Set when the section's `stop_pumps` is withdrawn, so the actuator releases the stop pump output |
| `horn` / `reset_horn` | 2 / 3 | Common handshake |
| `enable_pressure_SD` / `disable_pressure_SD` | 4 / 5 | Common handshake, also cleared on changes of `pressure_SD_F` |
| `read_paras` | 6 | Local processing (actuator parameters copied to the command block), no need to send |
| `write_paras` | 7 | Local processing: writes the parameters directly to the actuator data area, resets after completion |
| `enable_pressure_alarm` / `disable_pressure_alarm` | 8 / 9 | Common handshake |
| `enable` / `disable` | 10 / 11 | Common handshake |
| `reset_CPU` / `reset_conn` | 12 / 13 | Common handshake |

### 12.1 Command masking

Per the spec, commands are masked by the `supported_commands` configured for each actuator:

- Parsing: when `config.js` parses an actuator, it converts the `supported_commands` array into a 16-bit mask word `command_mask`. For each command name of the array, the command word bit k is looked up in the command enumeration (`node_commands`), and bit k of the mask is set to 1; the bit numbers are the register bits (see 3.1).
- Validation: a name outside the command enumeration in the array is a configuration error; the program reports it at startup and exits, in the same way as the validation of the actuator `id`.
- When the field is omitted, all commands are supported, and `command_mask` takes all bits 0-13 of the command enumeration, i.e. `0x3FFF`.
- Bit 14 (`reserve`) and bit 15 (`executing`) are not commands and are not affected by the mask: the actual filter is `commands & (command_mask | 0xC000)`, so that `executing` is not cleared by mistake.
- Use: `command_mask` is carried into the runtime with the actuator object. Before sending, `commands & command_mask` is applied, so unsupported command bits are reset directly and not sent; this replaces the common `& 0xB1` in `node_loop` today.
- Note: today's common mask runs in `node_loop` every 500 ms, while command sending has a 100 ms debounce, so a masked command bit may still be sent before it is reset; masking per actuator must filter on the send path, not rely on the periodic reset alone.
