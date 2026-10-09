# TLMS_ESD Design (Draft)

> English version of [design.zh-cn.md](design.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document was compiled from the existing code and describes how the system works: architecture, data structures, algorithms and internal mechanisms. For the requirements see [spec.md](spec.md).

## 1. Modules

| Path | Responsibility |
| --- | --- |
| `src/cli.js` | The `tlms` command line: parses arguments, calls pm2 or directly `import('./main.js')`. |
| `src/main.js` | Process entry: validates the layouts, reads the configuration, builds the controller, provides the real drivers reused per connection, starts the Modbus server and the main loop. |
| `src/runtime.js` | `build_runtime`: creates the TData of the controller, mounts them on `Unit_Map`, calls each `*_init`, and provides one iteration of the main loop `cycle` and `start` / `stop`. The drivers are provided by the caller through `get_drivers(driver_info)`, which lets tests inject fake drivers. |
| `src/gcl.js` | YAML loader (`yaml` library, YAML 1.1), keeping source line information. |
| `src/config.js` | Merges several configuration documents, fills in defaults, builds the name and ID indexes. |
| `src/init.js` | `prepare_controller`: builds the runtime object graph for the selected controller. |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | Initialization (event binding) and periodic processing of actuators (nodes), sections and lines. |
| `src/action_record.js` | Action records: CSV reading and writing, and browsing by index. |
| `src/drivers/` | `Base_Driver`, `MTClient` (Modbus TCP client), `S7Client`, and `createMTServer` / `create_vector` / `Unit_Map` (upward server). |
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
   1. initializes the action record;
   2. calls `build_runtime` (`runtime.js`): mounts the action record on `unit_id.action_records`, creates the TData in the order line -> section -> actuator, calls `attach_unit`, then each `*_init`; the drivers of the actuators are provided by `get_drivers` of `main.js`, reused per connection;
   3. starts the Modbus TCP server and waits until it is ready; when it fails to start (e.g. the port is in use), logs an error and exits with exit code 1, to be restarted by pm2;
   4. `runtime.start()` runs `section_loop` of all sections and `node_loop` of all actuators with `setInterval(MAIN_PERIOD = 500)` (`line_loop` is empty and not called).

## 3. Typed data layer

The external requirements and terminology of TData (an instance written tdata) and TTags are in section 3.6 of the spec; this section describes the implementation.

### 3.1 Layout definitions (`src/structs/`)

- Each item contains `{ name, type, offset, length, init_value }`; `offset` and `length` are in bits.
- `type` values (case-insensitive): `Bool`, `Byte`, `SInt`, `USInt`, `Int`, `UInt`, `Word`, `DInt`, `UDInt`, `DWord`, `Real`.
- A `Word` item with `coupling` is a status word or command word made of Bools; `is_combined: true` links the whole word and its bits in both directions. The `offset` of each coupling entry is relative to the start of the word.
- `{ includes: [...], offset }` splices in a group of shared items (such as `node_parameters`), shifted as a whole.
- `share.js#build_structure` expands the items into a flat `items`, computes the total length `length` of the structure, and normalizes coupling into an array of names.
- Bool position rule: `byte = offset >> 3`, `bit = offset % 8`. The internal buffer is big-endian, so the first byte of a word is the high byte of the register; coupling offsets 8-15 are register bits 0-7, offsets 0-7 bits 8-15. The definition files list 8-15 before 0-7, i.e. in the order of register bit 0 to bit 15; bit k of the word value is register bit k, and the `0xB1` mask is computed with these bit numbers.
- The point table in [spec-modbus.md](spec-modbus.md) is computed from these definitions by the rules above.
- The bit numbers of a combined word are fully guaranteed by the offset numbering above; in `buffer` a combined word is big-endian like any other multi-byte type, and neither the upward server nor the drivers swap bytes for combined words separately (spec 3.6).
- These layouts are the memory images of the Modbus register table and of the actuator data areas; changing any offset is a protocol change.
- Write ownership (spec 3.6) is currently guaranteed by manual review: the layouts do not mark who writes a TTag, and the validation does not check this rule. The existing write paths all comply: the ID, command word and parameter block of the command block and the parameter block of the node tdata are written by the controller, all word aligned and contiguous; the rest of the node tdata is written by the actuator and only read by the controller.

#### Layout validation

The layout rules of spec 3.6 are validated together at the layout stage, not scattered over the runtime of TData, TTag and TGroup:

- `share.js` provides `validate_structure(data_struct)`, which validates the flat `items` expanded by `build_structure` and returns an array of violation descriptions (an empty array means valid), without exiting at the first error.
- What is validated:
  - Names: duplicate names in `items`; names conflicting with the members of TData (methods and getters on `TData.prototype`, and instance fields such as `name`, `driver`, `IO_read`).
  - Type and length: `type` not among the supported types; `length` not matching the type (Bool 1, Byte / SInt / USInt 8, Int / UInt / Word 16, DInt / UDInt / DWord / Real 32).
  - Alignment: the `offset` of a non-Bool must be a multiple of 8; the byte offset of a multi-byte type must be even.
  - Overlap: the non-Bool items are sorted by byte range and adjacent ranges are checked for intersection; Bools are checked by `offset` for occupying the same bit twice; when a Bool falls inside a non-Bool range, the `coupling` of that non-Bool item must contain the name of the Bool.
  - Combined words: for an item with `coupling`, the `offset` of each component bit lies within `[offset, offset + length)`.
  - Total length: `length % 16 === 0`.
  - The type and range of `init_value` match `type` (a boolean for Bool, otherwise a number representable by the type).
- `build_structure` no longer silently skips a duplicate name, but keeps the item and leaves it to the validation report.
- Callers:
  - At controller startup (`main.js`, before any TData is created), the validation runs on all structures; on violations, each is written to the error log and the program exits;
  - `tlms check` runs the validation on all structures and reports its errors together with those of the configuration validation.
- After the validation passes, TData, TTag and TGroup do not repeat these checks; the `validate` of TTag keeps only defensive assertions.

Main layouts (byte offsets):

| Structure | Key TTags |
| --- | --- |
| NODE | 0 ID; 2 status; 4 temperature; 8 pressure; 12 flowmeter; 16 response_code; parameter block from 18 |
| COMMAND | 0 response_code (deprecated); 2 overtime (deprecated); 6 extra_commands (`has_commands`, `reset_paras`); 16 ID; 18 commands; parameter block from 20 |
| SECTION | 0 ID; 2 upward_input (reserved); 4 status; 6 flow_begin; 10 flow_end; 14 flow_diff; 18-34 limits and delays; 38 countdown; 40 inner_word (internal trigger bits) |
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
  - Bool and the single-byte types (Byte, SInt, USInt) read and write only one byte, without conversion within the byte; their index in the IO buffer is computed per 16-bit register: `byte_offset ^ 1` for `LE` / `little` / `BEBS`, `byte_offset` for `BE` / `LEBS`. A Bool changes only its own bit by `bit_mask`.

### 3.4 TGroup

- `create_tag_group(...names)` returns a group of tags to be synchronized with the device together.
- The overlap rules of the layout are guaranteed by the layout validation (3.1), and TGroup no longer checks overlaps. When a tag is added:
  - adding the same tag again is ignored;
  - a tag whose byte range exceeds the IO exchange area is an error, and the program exits;
  - the byte range the tag actually occupies in the IO buffer (with the indexes of Bool and single-byte types computed as in 3.3) is extended outward to a whole multiple of the driver write unit `driver.write_unit`, then merged into the write ranges (`#areas`); it is merged with existing ranges it intersects or adjoins, possibly several at once.
- The `start`, `remote_start` and `length` of the IO exchange area must be whole multiples of the write unit; `set_IO` checks this and otherwise reports an error and exits, so that the extended write ranges never leave the exchange area and the local write units align with the remote write units.
- `read()`: first `IO_read_all`, then each tag of the group calls `read_from` and runs `check_coupling`, which triggers the change events and refreshes combined words and their bits.
- `write()`: each tag of the group first calls `write_to` into `IO_buffer`, then `IO_write` is called for each merged range, passing the length of the range to the driver as well. Bytes within a range that belong to no tag of the group take the values last read into `IO_buffer`; by the write ownership rule these bytes are also written by the controller, so the data of the actuator is not overwritten.
- `copy_from(tdata)`: copies the values of the tags of the same name from another TData and runs `check_coupling`, used to synchronize the parameter block between data and command.

## 4. Drivers

### 4.1 Base_Driver

- Mixed in with `Object.mixin(this, new Base_Driver())`: it only adds the properties the subclass lacks, taking the prototype chain into account, so it neither overrides those the subclass defines itself, such as `start_tick`, nor shadows `connect` / `disconnect` inherited from the driver library.
- `stop()` stops the timer and calls the library's `disconnect()` (neither library reconnects automatically after an explicit disconnect); a later `start()` first calls `connect()` to reconnect.
- `start()` runs `start_tick` every `period_time` (1000 ms) and emits `tick` when connected.
- `emit_io_ok` / `emit_io_error` wrap the result of every read and write:
  - on the first error, `io_error` is emitted, and on the first success after an error, `io_ok` (not the per-transaction `data_error` event name of es-modbus, to avoid confusion with it);
  - when no read or write succeeds within `connfailed_time` (5000 ms), `on_error` is called, which emits `connfailed`;
  - the argument of `connfailed` and `io_error` is the error message string (its `message` when the library gives an `Error`).
- `reconnect_time` means only the reconnect interval, and `connfailed_time` only the escalation time above; the two are configured separately. The second constructor argument `options` of a driver can pass `period_time`, `reconnect_time`, `connfailed_time` (and `reconnect_max` for Modbus); the controller passes none and uses the defaults.
- Driver instances are reused by connection parameters:
  - Modbus by `host:port`;
  - S7 by `host:port rack slot`;
  - calling `start()` several times on the same driver does not create timers again.

### 4.2 MTClient (es-modbus)

- Address conversion: areas in the configuration and in TData are in bytes; the byte start `start` corresponds to the holding register PDU address `start >> 1` (0-based), and the length is `length >> 1` registers; they are passed as the structured range `[func_code, pdu_addr, length]` of es-modbus, not in Modicon notation.
- es-modbus throws synchronously on invalid arguments (range, quantity limits, unit_id); `read` / `write` catch it, log an error, and treat it as a read / write failure (`emit_io_error`).
- Only holding registers are accessed: MTClient gives the function codes explicitly, 03 for reading, 06 (single register) / 16 (multiple registers) for writing. Coils, discrete inputs and input registers are not used.
- `write_unit = 2`: the write unit is one register.
- Echo check of writes: the `write()` of es-modbus resolves with whether the response echoed the request. A mismatching echo means the write is unconfirmed: a warning is logged, it is treated as a read / write failure (`emit_io_error`), and `write` returns `false`.
- Reconnection uses the mechanism of es-modbus itself; `start_tick` is overridden to only emit `tick`:
  - the reconnect interval starts at `reconnect_time` (5000 ms), doubles on every failure up to `reconnect_max` (20000 ms), and returns to the initial value once the connection is stable;
  - 3 consecutive request timeouts (the default `max_timeouts` of es-modbus) mean a dead link: the connection is closed and reconnected as usual; when the connection drops, all pending requests fail with `connection lost`.

### 4.3 S7Client (@st-one-io/nodes7)

- Reads and writes the `DB` or `M` area with `readArea` / `writeArea`; start and length are in bytes.
- `write_unit = 1`: the write unit is one byte.
- Because `S7Endpoint.connect()` is incomplete, the library's own automatic reconnection is used for now (`autoReconnect`, taking `reconnect_time`, default 5000 ms, at a fixed interval), and `start_tick` is overridden too (marked as temporary code in the source).

### 4.4 Upward server (createMTServer + Unit_Map)

- `create_vector(unit_map)` creates the vector serving `Unit_Map`, and `createMTServer` uses it to create the es-modbus server; tests call the vector directly to simulate HMI requests.

- `Unit_Map.attach_unit(unit_id, tdata, start)` mounts a TData on the byte range `[start, start + size)` of a unit; a unit can hold several TData.
  - Actuator unit: data at byte 0, command at byte 400 (i.e. from register 200).
- Register `addr` corresponds to byte `addr * 2`, read and written big-endian in `tdata.buffer`; coil `addr` corresponds to bit `addr % 8` of byte `addr >> 3`.
- After every write, `tdata.check_all_tags()` is called, which turns the write of the HMI into tag change events.
- The vector method names are the snake_case names required by es-modbus: `get_holding_register`, `get_input_register`, `set_register`, `get_coil` (used for both FC 1 and FC 2), `set_coil`.
- Unmapped addresses (e.g. the gap between the node data area and the command block in an actuator unit) read as 0 / false and writes to them are ignored, so a block read of the HMI across the gap still succeeds. A warning is logged only once per (type, unit, address), to avoid flooding the log while polling.
- Requests are validated by es-modbus first: an unregistered unit id is answered with exception 0x0B, an illegal function code, quantity or address out of range with 0x01 / 0x03 / 0x02; when the vector throws, 0x04 is answered and the `vector_error` event logs it.

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
  - `io_error`: sets `work_OK = false` after the delay.
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
- Change of `pressure_SD_F`: clears the corresponding enable or disable command bit and sends the commands; also calls `section.update_press_SD_trigger()`.
- Aggregating state changes upward:
  - on changes of `comm_OK`, `work_OK`, `pump_run`, `pump_change_F`, `pressure_WH_F`, `pressure_AH_F`, calls `section.update_*`; on changes of `pressure_AH_F` also calls `section.update_press_SD_trigger()`;
  - on changes of `flowmeter`, calls `update_flow_begin` / `update_flow_end` by the begin / end role of the actuator in the section;
  - on changes of `pump_run_1..4`, `pump_run` takes their OR; when `pump_run` becomes false, the actuator's `stop_pumps` command is cleared.

## 6. Section processing (`section_proc.js`)

### 6.1 Aggregation functions

`get_update_fn(op, ...)` creates a function that aggregates an actuator property by AND / OR / ADD, wrapped with `debouncify(key, fn, 50)`. The timers of `debouncify` are kept in a module-level table and distinguished by a string key, so the key must be globally unique (of the form `section<name>_<prop>_update`).

### 6.2 Event-driven part (`section_init`)

- Variables on the section object (not TTags, see spec 3.6):
  - `press_SD_trigger`: the pressure interlock condition, computed by `update_press_SD_trigger()` as the OR of `pressure_AH_F && pressure_SD_F` over the actuators of the section, with a 50 ms debounce, logged on change;
  - `press_action` / `flow_action`: the pressure action and the flow difference action, set and reset by `section_loop` (see 6.3).
- On changes of `flow_begin` / `flow_end`, recomputes `flow_diff`.
- On changes of `flow_diff`, computes the trigger bits:
  - `flow_warning_trigger = flow_diff > flow_diff_WH`;
  - `flow_alarm_trigger = flow_diff > flow_diff_AH`.
- On changes of `flow_alarm_F`, `protect_F`, `pump_run`, updates `pre_stop_notice = flow_alarm_F && line.data.pump_run && protect_F`:
  - the pump running condition takes the line's `pump_run` (spec 5.2), and changes of the line's `pump_run` also trigger this update (see section 7);
  - when this section's `pump_run` changes, this computation may read the old value of the line, and the change event of the line then computes it once more; the line's `pre_stop_notice` only aggregates the results of the sections and does not take part in the computation of a section, so no loop forms;
  - `stop_pumps` and the pressure action still take this section's `pump_run`.
- On changes of `pre_stop_notice`, updates the line's `pre_stop_notice`.
- On changes of `flow_alarm_F`, `press_alarm_F`, also updates the line's `alarm_F`.
- Change of `stop_pumps`:
  - when true, sets `command.stop_pumps = node.data.pump_run` for each actuator with pumps;
  - when false, sets `stop_pumps = false` and `cancel_stop = true`.
- Change of `action_F`: only logs.
- Change of `pump_run`:
  - falling edge: clears the section's `autoStopCmd` / `manStopCmd`;
  - in both cases, updates this section's `pre_stop_notice` and the line's `pump_run`.

### 6.3 Periodic part (`section_loop`)

Runs every 500 ms:

1. Computes the protection state:
   - `protect_prereq = comm_OK && work_OK && !pump_change_F`;
   - `protect_F = protect_prereq && !flow_override && !line.flow_override`, i.e. no protection when either the `flow_override` of this section or that of its line is true;
   - `hangon_AF = !protect_prereq`.
2. Delay counting: while a trigger bit is true, its counter adds 500 ms per cycle, otherwise it is reset; when the count exceeds `*_delay`, `flow_warning_F` / `flow_alarm_F` is set.
3. Countdown:
   - while `pre_stop_notice` is true, `action_count` accumulates, and `countdown = (action_time - action_count) / 1000`;
   - when the result is below 0, `countdown` is set to 0 and the countdown is recorded as expired (`countdown_expired`).
4. Pressure action (variable `press_action`):
   - set when `press_SD_trigger && pump_run`, together with the section's `autoStopCmd`. `protect_F` is not checked, so it is not restricted by hang-on;
   - otherwise reset when `pump_run && !autoStopCmd`: a pump of this section is running (necessarily restarted after the stop), and the interlock condition has disappeared.
5. Flow difference action (variable `flow_action`):
   - set when the countdown expires, together with the line's `autoStopCmd` and this section's `line_action_source`;
   - otherwise first runs `line_action_source &&= line.autoStopCmd`, then resets when `line.pump_run && !flow_alarm_F && !line_action_source`. The pump running condition takes the line's, as for the stop pump notice; otherwise a section without pumps could never reset.
6. The reset conditions are evaluated every cycle and not latched; during the stop neither pump running condition holds, so the action state is kept until pumps run again.
7. Action aggregation:
   - when either action variable changes from false to true, sets the line's `action_section_ID` to this section's ID and calls `add_action_record()` to create a record; when both happen in the same cycle, only one record is created;
   - `action_F = press_action || flow_action`; when the result is false and the line's `action_section_ID` equals this section's ID, it is cleared, so as not to erase the action of another section.
8. Computes the stop command: `stop_pumps = (section auto/man || line auto/man) && pump_run`.

The section layout is planned to change in a future transitional version dedicated to layout adjustments: `press_action` / `flow_action` then become TTags, and the action record will be triggered by their change events instead of comparing old and new values in `section_loop`.

## 7. Line processing (`line_proc.js`)

- Aggregation rules:
  - `pump_run`, `pre_stop_notice`: the OR of the properties of the same name of the sections;
  - `alarm_F`: the OR of `flow_alarm_F` and `press_alarm_F` of the sections;
  - all with a 50 ms debounce.
- The line's `flow_override` is only logged and does not overwrite any section; its effect shows as an AND in the computation of the sections' `protect_F` (see 6.3).
- On changes of `pump_run`, calls `update_pre_stop_notice()` for each section of the line; on the falling edge, also clears the line's `autoStopCmd` / `manStopCmd`.

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
- The record content is filled in by the section's `add_action_record()` when a pressure action or a flow difference action occurs (see 6.3); `press_action` / `flow_action` take the action variables of the section; the rule for actuator positions is in section 11.

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
- Linting: ESLint with `@stylistic/eslint-plugin` (`eslint.config.js`, `pnpm lint`); JS is indented with tabs. ESLint finds code problems; @stylistic only regulates whitespace, quotes, semicolons and the like, without re-wrapping lines, so the hand-aligned layout tables are kept. Formatters that re-wrap lines (Biome, Prettier) are not used. In addition, the globals equivalent to the `Number` namespace (`isNaN`, `isFinite`, `parseInt`, `parseFloat`, `NaN`, `Infinity`) are forbidden; `Number.isNaN` and the like are used instead.

### 10.4 Build and release

- `rolldown.config.js` produces two ES module bundles:
  - `src/main.js` -> `./main.js`;
  - `src/cli.js` -> `./cli.js`, with `./main.js` set as external, so `cli.js` imports the bundle in the same directory at run time.
- The `prepare` script of `package.json` triggers the build; `bin.tlms` points to `cli.js`.

## 11. Unimplemented items

Requirements of the spec that the current code does not implement yet:

| Item | Spec requirement | Current code | Locations |
| --- | --- | --- | --- |
| Command masking by actuator configuration | Each actuator lists its supported commands with `supported_commands` in the configuration; the controller sends only supported commands and resets the other command bits directly (spec 5.1); for the implementation see 12.1 | The configuration has no such field; `node_loop` runs `command.commands &= 0xB1` for all actuators alike, keeping only bits 0, 4, 5, 7 (`stop_pumps`, `enable_pressure_SD`, `disable_pressure_SD`, `write_paras`), so `cancel_stop` is reset too | Actuator parsing in `config.js`; `node_loop` in `node_proc.js` |
| ID uniqueness check | The IDs of lines, sections and actuators are all distinct (across types); several tdata of the same object share its ID (spec 4.1) | `config.js` only checks that an actuator `id` is a non-zero number; lines, sections and actuators are each indexed by `ID<id>`, and neither duplicates nor equal IDs across types are reported; a duplicate of the same type silently overwrites the earlier one | `add_conf` in `config.js` |
| ID as the upward unit id | The Modbus unit id of a line, section or actuator is its ID (at least 1), the action record is fixed at unit id 0, and the controller configuration no longer has `unit_id` (spec 4.1, 5.5) | `build_runtime` looks up the unit id by name in `controller.modbus_server.unit_id[name]` (the action record in `unit_id.action_records`), and every object must be listed in the controller configuration | `build_runtime` in `runtime.js` |
| Configuration check command | `tlms check` reads and validates the configuration and all layouts (`validate_structure` of 3.1), reports all errors, and does not start the controller (spec 3.6, 5.6) | No such command; configuration errors are found only at startup, and most of them exit or crash directly; the layout validation already runs at startup (`main.js`) but is not yet wired into the command line | `cli.js`; `config.js` needs a separately callable validation function that collects all errors |
| Action record positions mapped to actuators (defect in the existing code) | Nodes 1-4 map to the actuators of the action section in order, begin actuators first, then end actuators; the pressure, ID and pump running state of each position come from the same actuator (spec 5.4) | Nodes 1-3 always take `begin_nodes[0..2]`, node 4 always takes `end_nodes[0]`; `node1..3_pump_run` come from `pump_nodes[0..2]` (actuators with pumps only, which may be misaligned with the node positions), and `node4_pump_run` is never assigned | `add_action_record` in `section_proc.js` |


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
