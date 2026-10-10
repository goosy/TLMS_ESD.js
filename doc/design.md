# TLMS_ESD Design

> English version of [design.zh-cn.md](design.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document describes how the system works: architecture, data structures, algorithms and internal mechanisms. For the requirements see [spec.md](spec.md), for the programming interface of TData / TTag see [spec-data-api.md](spec-data-api.md).

## 1. Modules

| Path | Responsibility |
| --- | --- |
| `src/cli.js` | The `tlms` command line: parses arguments, calls pm2 or directly `import('./main.js')`. |
| `src/main.js` | Process entry: reads the configuration, builds the controller, provides the real drivers reused per connection, starts the Modbus server and the scan. |
| `src/runtime.js` | `build_runtime`: creates the TData of the controller, mounts them on `Unit_Map`, calls each `*_init`, creates the scan scheduler and declares all rules, and provides `start` / `stop`. The drivers are provided by the caller through `get_drivers`. |
| `src/gcl.js` | YAML loader (`yaml` library, YAML 1.2), keeping source line information. |
| `src/config.js` | Merges several configuration documents, fills in defaults, builds the name and ID indexes, converts the `supported_commands` of actuators into command mask words. |
| `src/init.js` | `prepare_controller`: builds the runtime object graph for the selected controller. |
| `src/node_proc.js` / `src/section_proc.js` / `src/line_proc.js` | Initialization (log handlers, IO binding) and rule declarations of actuators (nodes), sections and lines. |
| `src/action_record.js` | Action records: CSV reading and writing, and the rule browsing records by index. |
| `src/scan.js` | The scan scheduler `Scheduler` (section 5). |
| `src/rules.js` | Rules: `derive` / `act` declarations, ordering and startup checks, `Ticker`, `on_delay` / `off_delay` (section 6). |
| `src/drivers/` | `Base_Driver`, `MTClient` (Modbus TCP client), `S7Client`, `createMTServer` (upward server, using the vector of the data layer), and the IO binding `binding.js` (4.5). |
| `src/typed_data/` | Data layer (section 3): `TData` / `TTag`, `observer.js` (change detection), `structure.js` (structure expansion and layout validation), `layout.js` (layout compilation), `codecs.js` (codecs of the types), `endian.js` (byte order conversion per item), `server.js` (`Unit_Map` and the vector of the upward server), `types.js` (type declaration generation). |
| `src/layouts.yaml` | Layout descriptions of LINE, SECTION, NODE, COMMAND, RECORD. |
| `src/layouts.js` | Compiles `layouts.yaml` and exports these layouts and the fragments the business needs. |
| `src/layout_types.d.ts` | Type declarations generated from the layouts (`pnpm gen:types`). |
| `src/util.js` | log4js logging, `Object.mixin`. |

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
   - when the pressure and temperature limits are missing, takes the range limits;
   - computes the command mask word `command_mask` from `supported_commands` (14.1).
4. After all documents are merged, lines are linked to controllers and sections to lines by name (objects referencing each other).
5. `prepare_controller(name)`:
   1. selects the controller (the first one when empty or 0);
   2. builds new, reduced runtime objects `line` / `section` / `actuator`;
   3. the `driver_info` of an actuator carries the protocol, the address and the data / command areas;
   4. actuators are also put into `section.begin_nodes` / `end_nodes` / `pump_nodes` by begin, end and pump station.
6. `run_controller`:
   1. initializes the action record;
   2. calls `build_runtime` (`runtime.js`):
      1. mounts the action record on `unit_id.action_records`, creates the TData in the order line -> section -> actuator, calls `attach_unit`, then each `*_init`; the drivers of the actuators are provided by `get_drivers` of `main.js`, reused per connection;
      2. creates the scan scheduler (section 5), registers all tdata, the data Bindings of the actuators (with the input group `data_payload`) and the write-only command Bindings;
      3. after the object graph is built, calls `node_rules` / `section_rules` / `line_rules` in the order actuators -> sections -> lines to declare the rules (sections 7, 8, 9), then declares the rule of the action record (section 10) and the command masking rule of each actuator (14.1), then `prepare()` orders and checks;
      4. all tdata use the immediate detection mode, with `on_write` wired to `request_scan()` of the scheduler (3.5);
   3. starts the Modbus TCP server and waits until it is ready; when it fails to start (e.g. the port is in use), logs an error and exits with exit code 1, to be restarted by pm2;
   4. `runtime.start()` first runs an initial scan (computing all derived values), then starts the periodic tick (`MAIN_PERIOD = 500`); rule errors are written to the log through the `on_error` of the scheduler.

## 3. Data layer (`src/typed_data/`)

The external requirements and terminology of TData (an instance written tdata) and TTags are in section 3.6 of the spec, the programming interface in spec-data-api.md; this section describes the implementation. The data layer consists of four parts:

| Part | Responsibility | Instances | Mutability |
| --- | --- | --- | --- |
| Layout | Compiled from the layout description: byte positions and codecs of the tags, the reverse table from bytes to tags, prototype accessors | One per structure | Immutable |
| TData | The value buffer `buffer` (big-endian), access by name, raw write methods, the TTag returned by `get(name)` | One per tdata | Mutable |
| Observer | Snapshot comparison, emitting change events, providing the values at the end of the previous scan | One per tdata | Mutable |
| Unit_Map and vector | Mount tdata on the units and addresses of the upward server (4.4) | One per server | Mutable |

Dependency direction: Observer depends on TData and Layout, TData only on Layout, Layout only on the layout description. The IO binding (4.5), the scan scheduler (section 5) and rules (section 6) are outside the data layer and depend on it; the data layer notifies them only through callbacks passed in by the user (wired to `request_scan()` in the controller) and does not know they exist.

### 3.1 Component boundary

The data layer is to become a separate component in the future, shared by a Modbus device emulator and controllers like this project: the component offers a Modbus TCP server and operates its internal state through TData / TTag. The code is organized along the component boundary:

- The component code is all in `src/typed_data/` and imports no modules outside the component: it does not depend on the configuration (`config.js`), the business processing (`*_proc.js`), the project's layouts (`src/layouts.yaml`, `src/layouts.js`) or the project's logger (`util.js`);
- On errors the component code throws, without logging or calling `process.exit`, and the caller decides how to report and exit; non-fatal situations at run time that need reporting (such as accessing an unmapped address) go through a logger injected by a constructor argument, which outputs nothing by default;
- Layout descriptions are external input to the component: this project's `src/layouts.yaml` is handed to the component for compilation by `src/layouts.js`;
- The interface of the component (spec-data-api.md) is for programmers: TData / TTag can be read and written at any time and emit events when values change, and the component does not restrict these capabilities because of the scheduling of any user.

### 3.2 Layout definitions (`src/layouts.yaml`)

- The layout description is a YAML 1.2 file: the root key `layouts` maps layout names to item lists; all other root keys are fragments (such as `node_commands`, `node_parameters`, `node_status`), referenced by name from items.
- Each item contains `{ name, type, offset, init_value }`, optionally `length`, `comment`; `offset` and `length` are in bits, and when `length` is omitted it is given by the type.
- Only one side of a combined word and its component bits gives `init_value` (spec 3.6): when `build_structure` expands, if the combined word gives none it is composed from the component bits (bits not given are false), and if the combined word gives one the values of the component bits are split from the whole word; when both sides give values, the given values are kept and the validation reports it. All existing layouts give them on the component bits.
- `type` values (case-insensitive): `Bool`, `Byte`, `SInt`, `USInt`, `Int`, `UInt`, `Word`, `DInt`, `UDInt`, `DWord`, `Real`.
- A `Word` item with `coupling` (a fragment name or an inline list) is a status word or command word made of Bools; `is_combined: true` links the whole word and its bits in both directions. The `offset` of each coupling entry is relative to the start of the word.
- `{ includes: <fragment name or inline list>, offset }` splices in a group of shared items (such as `node_parameters`), shifted as a whole, optionally with `name_prefix`.
- `src/typed_data/layout.js#compile_layout(yaml_path)` reads the file synchronously, resolves fragment references (an error for a missing or cyclic reference), fills in omitted `length`s, then for each layout calls `structure.js#build_structure` to expand it into a flat `items` (computing the total length `length` of the structure and normalizing coupling into an array of names) and validates it, returning `{ layouts, fragments }`.
- `src/layouts.js` compiles `layouts.yaml` in its directory at load time (the path resolved from the module location; at build time a copy plugin in the rolldown configuration outputs it as a separate file next to `main.js`, not bundled into `main.js`), and exports `LINE`, `SECTION`, `NODE`, `COMMAND`, `RECORD`, plus the parameter block items `node_parameters` and the command bit items `node_commands`; when a layout is invalid, each violation is written to the error log and the program exits.
- Each layout is compiled into a Layout (`layout_of`): besides the expanded `name`, `length`, `items`, it has the item table `entries` indexed by name (byte offset, bit mask, codec), the reverse table `tags_at_byte` from bytes to tags, and the TData subclass `Data_Class` dedicated to the structure.
- Bool position rule: `byte = offset >> 3`, `bit = offset % 8`. The internal buffer is big-endian, so the first byte of a word is the high byte of the register; coupling offsets 8-15 are register bits 0-7, offsets 0-7 bits 8-15. The definition files list 8-15 before 0-7, i.e. in the order of register bit 0 to bit 15; bit k of the word value is register bit k, and the command mask word `command_mask` is computed with these bit numbers (14.1).
- The point table in [spec-modbus.md](spec-modbus.md) is computed from these definitions by the rules above.
- The bit numbers of a combined word are fully guaranteed by the offset numbering above; in `buffer` a combined word is big-endian like any other multi-byte type, and neither the upward server nor the drivers swap bytes for combined words separately (spec 3.6).
- These layouts are the memory images of the Modbus register table and of the actuator data areas; changing any offset is a protocol change.
- Write ownership (spec 3.6) is currently guaranteed by manual review: the layouts do not mark who writes a TTag, and the validation does not check this rule. The existing write paths all comply: the ID, command word and parameter block of the command block and the parameter block of the node tdata are written by the controller, all word aligned and contiguous; the rest of the node tdata is written by the actuator and only read by the controller.

#### Layout validation

The layout rules of spec 3.6 are validated together at the layout stage, not scattered over the runtime of TData, TTag and Binding:

- `structure.js` provides `validate_structure(data_struct)`, which validates the flat `items` expanded by `build_structure` and returns an array of violation descriptions (an empty array means valid), without exiting at the first error.
- What is validated:
  - Names: duplicate names in `items`; names conflicting with the members of TData (methods and getters on `TData.prototype`, and instance fields such as `name`).
  - Type and length: `type` not among the supported types; `length` not matching the type (Bool 1, Byte / SInt / USInt 8, Int / UInt / Word 16, DInt / UDInt / DWord / Real 32).
  - Alignment: the `offset` of a non-Bool must be a multiple of 8; the byte offset of a multi-byte type must be even.
  - Overlap: the non-Bool items are sorted by byte range and adjacent ranges are checked for intersection; Bools are checked by `offset` for occupying the same bit twice; when a Bool falls inside a non-Bool range, the `coupling` of that non-Bool item must contain the name of the Bool.
  - Combined words: for an item with `coupling`, the `offset` of each component bit lies within `[offset, offset + length)`.
  - Total length: `length % 16 === 0`.
  - The type and range of `init_value` match `type` (a boolean for Bool, otherwise a number representable by the type).
  - Both a combined word and its component bits give `init_value`.
- `build_structure` keeps an item with a duplicate name and leaves it to the validation report.
- Callers:
  - `compile_layout` runs the validation on all layouts of the file and on violations throws an error containing all of them; when the controller loads `src/layouts.js`, each is accordingly written to the error log and the program exits;
  - `tlms check` runs the validation on all structures and reports its errors together with those of the configuration validation (not implemented, see section 13).
- After the validation passes, TData, TTag and Binding do not repeat these checks; `layout_of` keeps only defensive assertions.

Main layouts (byte offsets):

| Structure | Key TTags |
| --- | --- |
| NODE | 0 ID; 2 status; 4 temperature; 8 pressure; 12 flowmeter; 16 response_code; parameter block from 18 |
| COMMAND | 0 response_code (deprecated); 2 overtime (deprecated); 6 extra_commands (`has_commands`, `reset_paras`); 16 ID; 18 commands; parameter block from 20 |
| SECTION | 0 ID; 2 upward_input (reserved); 4 status; 6 flow_begin; 10 flow_end; 14 flow_diff; 18-34 limits and delays; 38 countdown; 40 inner_word (internal trigger bits) |
| LINE | 0 status; 2 ID; 4 action_section_ID; 6 flow_diff (reserved) |
| RECORD | 0-10 time; 12 section_ID; 14-36 flows and pressures; 42-48 actuator IDs; 50 status; 52 index |

### 3.3 Codecs and prototype accessors

- The codec table `codecs.js` has an entry per type; `get(buffer, byte, mask)` decodes from the big-endian buffer, and `set(buffer, byte, mask, value)` encodes and writes; the device byte order is not handled in the table, only in the IO binding (4.5).
- `layout_of` generates a TData subclass `Data_Class` for each structure and defines an accessor once on its prototype for each item, shared by the instances of the same structure:
  - the getter decodes from `buffer` with the codec table every time and caches no value;
  - the setter writes `buffer` with the codec table, then calls `after_write` (3.5).
- A combined word and its component bits share the same bytes; after writing either side, the other side naturally reads the new value, and no extra linkage is needed.
- A tag name must not equal a member of TData (the accessor would shadow the member), checked by `validate_structure`, with a further defensive check in `layout_of`.
- `set_access_tracer(tracer | null)` (`layout.js`): once set, the accessors call `tracer(tdata, name, "read" | "write")` on every read and write of a tag, for the dependency tracing test mode of the scheduler (6.5); when not set, the accessors only add one check. The data layer only knows the hook, not the existence of rules.
- The type declarations `src/layout_types.d.ts` are generated from the layout file (one interface per layout, the tags as properties, `comment` as doc comments), providing editor completion for access by name; the generated file goes into version control, and a test checks it matches the layout file.

### 3.4 TData

- `new TData(struct, name, { detection, on_write })` returns an instance of the `Data_Class` of the structure: allocates `buffer` (`layout.size` bytes) and encodes and writes the `init_value` of each item in turn. `detection` is `"immediate"` (default) or `"deferred"` (4.2 of spec-data-api.md).
- `name` is writable; `layout`, `size`, `buffer` are read-only (getters only, assignment throws a `TypeError`), and the content of `buffer` can be read and written. `buffer` is always big-endian; the buffer exchanged with drivers belongs to the IO binding (4.5).
- There are two ways to write `buffer`, both through TData, allowed at any time, whether during a scan or not:

  | Way | Users |
  | --- | --- |
  | Assignment by name (`data[name] = v` or `tag.value = v`) | Any code: rules, event handlers, asynchronous callbacks, ordinary programs |
  | The raw write methods `write_register(offset, value)`, `write_bit(offset, mask, value)`, `write_bytes(offset, source)`, located by byte offset | The upward server (4.4) |

- Apart from the data layer and the IO binding, no code writes the content of `buffer` directly; a test checks that no other file in `src/` calls a write on `.buffer`. The loading of the IO binding (4.5) writes the content of `buffer` directly in the input phase of a scan, without requesting a scan, and the changes after loading are detected in the publish phase of the same scan.
- A function code 16 request writes several registers in a row within one synchronous call. In the immediate detection mode every write detects, so a Real spanning two registers emits one `change` event with a half-written value after the first register and another with the complete value after the second; rules are not affected, because `request_scan()` merges (5.2) and the scan runs only after the whole request has been handled.
- On errors TData throws (layout conflicts, values out of range), without logging or exiting.

### 3.5 Detection modes and Observer

Detection is done by the Observer (`observer.js`) of each tdata. All write paths end in the same private method of TData, and the two detection modes (behavior in 4.2 of spec-data-api.md) only decide who calls `diff()` after a write, and when:

```js
// setter -> after_write -> #written; write_register / write_bit / write_bytes -> #written
#written() {
    if (this.#detection === "immediate") this.#observer.diff();  // detect right now
    this.#on_write?.(this);                                       // then notify the user
}

detect() {
    this.#observer.diff();
}
```

- Immediate mode: calls `diff()` synchronously inside the write statement, then `on_write`; deferred mode: only calls `on_write`, and detection is done by the user calling `detect()`.
- The scan is not part of TData: TData has no phases, ordering or timing, and only chooses between "detect itself" and "leave it to the user".

**Snapshot comparison.** The Observer holds a snapshot as long as `buffer`, copied from `buffer` at creation. `diff()` compares `buffer` with the snapshot byte by byte; only for differing bytes does it find the related tags through the reverse table `tags_at_byte`, decoding the old value from the snapshot and the new value from `buffer`, and records a change when the values differ (two NaN count as the same); after the comparison it updates the snapshot, then reports together:

- Reported in layout order (a combined word before its component bits); for each change, first the TData emits `change(tagname, old, new)`, then the TTag of the tag emits `change(old, new)`; events are always emitted after the new value takes effect;
- Several writes of the same tag between two detections merge into one event, and a value that changed and was then restored emits no event;
- When an event handler writes a tag again, the nested comparison only registers, and after the current round of changes has been reported another round of comparison follows; when there are still new changes after 16 consecutive rounds, an exception is thrown to prevent oscillation;
- Old values are decoded from the snapshot, and no values are cached;
- `bench/change_detection_bench.js` measures the cost of loading item by item and then detecting on the NODE structure (74 tags, 146 bytes): about 1.2-1.7 µs per cycle without changes, about 2-3 µs with few changes, about 7 µs with all values changed (development machine).

**Values of the previous scan.** `observer.previous(name)` returns the value at the end of the previous scan, decoded from the scan snapshot; the scheduler updates it by calling `take_scan_snapshot()` at the end of each scan. In immediate mode the detection snapshot keeps refreshing between scans, so the scan snapshot is kept separately.

**The controller uses the immediate mode.** All tdata of the controller (data and command of lines, sections and actuators, the action record) use the immediate detection mode, with `on_write` wired to `request_scan()` of the scheduler, so any write (rules, event handlers, HMI, asynchronous callbacks) requests a scan after detection. The reasons:

- Values are equally timely in both modes: writes take effect immediately, and rules always read the current value; the detection mode only decides when `change` events are emitted;
- The interlocks and aggregations of the controller are all in rules and do not depend on events (6.6), so the deferred mode brings no benefit to the interlock results;
- In immediate mode events are emitted in the call stack of the write, so the writer can be traced when debugging.

The costs affect only event handlers (logging): the events of writes of rules in the evaluate phase are emitted in the middle of rule execution; several changes of the same tag within one scan emit separate events; a function code 16 write of a value spanning two registers shows one intermediate value (3.4).

### 3.6 TTag and byte order conversion

- `data.get(name)` returns the `TTag` of the tag, created and cached on first access, `undefined` when the name does not exist. A TTag holds no value: reading `value` decodes from the `buffer` of the TData, and writing `value` is exactly equivalent to `data[name] = v`; `name`, `type`, `length` come from the Layout item; `change` events are emitted by the Observer.
- `endian.js` implements the conversion between the device byte order and the internal big-endian per layout item (`load_entry` / `store_entry` / `io_index` / `io_range`), without detecting changes; the IO binding implements the same mapping per byte (4.5), and tests use `endian.js` as the reference to check that the two agree byte by byte:
  - 2 bytes: `BE` copies as is; `LE` / `little` / `BEBS` swap the two bytes;
  - 4 bytes: the four orders `BE`, `LE` / `little`, `BEBS`, `LEBS` are supported;
  - Bool and the single-byte types (Byte, SInt, USInt) read and write only one byte, without conversion within the byte; their index in the IO buffer is computed per 16-bit register: `byte ^ 1` for `LE` / `little` / `BEBS`, `byte` for `BE` / `LEBS`. A Bool changes only its own bit by its bit mask.

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

- `Unit_Map` and `create_vector(unit_map, { logger })` belong to the data layer (`src/typed_data/server.js`). The warnings of the vector about accesses to unmapped addresses are output through the injected `logger`, nothing by default; `createMTServer` (driver) passes the project logger and uses the vector to create the es-modbus server. Tests call the vector directly to simulate HMI requests.

- `Unit_Map.attach_unit(unit_id, tdata, start)` mounts a TData on the byte range `[start, start + size)` of a unit; a unit can hold several TData.
  - Actuator unit: data at byte 0, command at byte 400 (i.e. from register 200).
- Register `addr` corresponds to byte `addr * 2`, read big-endian from `tdata.buffer`; coil `addr` corresponds to bit `addr % 8` of byte `addr >> 3`.
- Writes go through `write_register` / `write_bit` of TData, which processes them by the detection mode (currently immediate detection); the vector does not change `buffer` directly.
- The vector method names are the snake_case names required by es-modbus: `get_holding_register`, `get_input_register`, `set_register`, `get_coil` (used for both FC 1 and FC 2), `set_coil`.
- Unmapped addresses (e.g. the gap between the node data area and the command block in an actuator unit) read as 0 / false and writes to them are ignored, so a block read of the HMI across the gap still succeeds. A warning is logged only once per (type, unit, address), to avoid flooding the log while polling.
- Requests are validated by es-modbus first: an unregistered unit id is answered with exception 0x0B, an illegal function code, quantity or address out of range with 0x01 / 0x03 / 0x02; when the vector throws, 0x04 is answered and the `vector_error` event logs it.

### 4.5 IO binding (`src/drivers/binding.js`)

The IO binding is not part of the data layer: it operates tdata through the interface of TData and `buffer`, and writes `buffer` only when loading device data.

- `new Binding(data, driver, { start, remote_start, length, endian, on_update }, ...extras)` maps the exchange area `[start, start + length)` of a tdata to the remote area of the same length from `remote_start`; `extras` is passed to the driver as is (`unit_id` for Modbus, `area, db` for S7). The three exchange area parameters must be whole multiples of the driver write unit `driver.write_unit` (default 1), otherwise an exception is thrown, so that the extended write ranges never leave the exchange area and the local write units align with the remote write units.
- Binding holds the `IO_buffer` in device byte order (as long as the tdata, with the same indexes), and data read by the driver is written only into it.
- Byte mapping `io_index`: at creation, the index in `IO_buffer` of each byte of the tdata is computed. The device byte order applies per 16-bit register and per 32-bit value (spec 3.6): 4-byte items are converted by the four orders `BE`, `LE` / `little`, `BEBS`, `LEBS`; other bytes are converted per 16-bit register, `byte ^ 1` for `LE` / `little` / `BEBS`, unchanged for `BE` / `LEBS`. The layout validation guarantees that non-Bool items do not overlap and Bools fall only inside combined words, so the mapping of each byte is unique.
- `create_group(...names)` returns a group of tags to be synchronized with the device together (`Binding_Group`):
  - a missing name or a tag outside the exchange area throws; adding the same tag again is ignored;
  - ownership mask `own`: the bits of each byte of the group that belong to the group, the whole byte for non-Bool items, only its own bit for a Bool, several items of the group on the same byte ORed;
  - write ranges: the positions of the bytes of the group in `IO_buffer`, extended outward to write units, with adjacent write units merged.
- Loading and exporting are both byte-by-byte loops by the ownership mask:

  ```js
  // load: IO_buffer -> buffer, only the bits owned by the group
  for (const i of group.bytes) {
      const m = group.own[i];
      buffer[i] = (buffer[i] & ~m) | (IO_buffer[io_index[i]] & m);
  }
  // store: buffer -> IO_buffer, before writing the group areas
  for (const i of group.bytes) {
      const j = io_index[i];
      const m = group.own[i];
      IO_buffer[j] = (IO_buffer[j] & ~m) | (buffer[i] & m);
  }
  ```

- Reading: `request_read()` reads the whole exchange area into `IO_buffer`, sets `fresh` and calls `on_update`; a read in progress is shared and not started again, so requests do not pile up on slow devices. `load(group)` loads, in the input phase of a scan, only the bits of the group by the mask and clears `fresh`; bits outside the group (such as `comm_OK`, maintained by the controller) stay unchanged; it changes only `buffer`, emits no events, and requests no scan.
- Writing: `request_write(group)` registers a write request, and the same group registered several times within one scan is written only once; `flush_writes()`, in the output phase of a scan, exports the bits of the group into `IO_buffer` by the mask, then calls the driver to write each write range, passing the length of the range to the driver as well. Writes are asynchronous and do not block the scan. Bits within a range that do not belong to the group take the values last read; by the write ownership rule these bytes are also written by the controller, so the data of the actuator is not overwritten.
- While the driver is not connected, nothing is read or written, and write requests are kept until the `flush_writes()` after the connection recovers.
- Driver events and the results of asynchronous reads and writes are recorded as states of Binding for rules to read (6.1), written only by Binding:

  | State | Updated when |
  | --- | --- |
  | `connected` | The driver's `connect` / `connfailed` events |
  | `read_ok` | Each read completes: true on success, false on failure |
  | `write_done(group)` | A write of a group completes; records the completion sequence number and result, for rules to decide "the write requested last time has completed" |

  When new data arrives, a state changes or a write completes, Binding calls the `on_update(binding)` passed at creation, which the controller wires to `request_scan()`.

## 5. Scan (`src/scan.js`)

### 5.1 Four phases

The `scan(tick)` of the scheduler runs entirely synchronously:

```js
function scan(tick) {
    // 1 input: take the process image, advance running tickers on periodic ticks
    phase = "input";
    for (const { binding, input_group } of bindings) if (input_group && binding.fresh) binding.load(input_group);
    if (tick) for (const ticker of running_tickers) ticker.count++;
    // 2 evaluate: all rules in one fixed dependency order, each isolated (5.4)
    phase = "evaluate";
    for (const rule of ordered_rules) guarded(() => rule.run(rule.ticker), rule);
    // 3 publish: detect every change since the last scan, emit change events
    phase = "publish";
    for (const data of data_blocks) guarded(() => data.detect(), data);
    // the end of this scan: tdata, binding states and variables save their values
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

1. **Input**: loads the actuators with new data from `IO_buffer` into `buffer`, forming the process image of this scan. Actuators without new data keep their values, and communication anomalies are reflected by `comm_OK` / `work_OK`. The scan of a periodic tick also adds 1 to the count of all running tickers (6.3).
2. **Evaluate**: runs all rules in the arranged order (section 6), computing aggregated values, trigger bits, timing and interlock actions, and registering write requests.
3. **Publish**: all Observers compare their snapshots and emit change events. Event handlers only log (6.6).
4. **Output**: performs the write requests registered in this scan; the scan of a periodic tick also starts the next round of reads. Reads and writes are asynchronous; when they complete, the `on_update` of Binding requests a scan, by which time this scan has ended.

"The values at the end of the previous scan" are saved after the publish phase: the writes made by rules and event handlers in this scan all count as part of this scan. tdata are saved by their Observers (3.5); Binding states (`connected`, `read_ok`) and registered variables (6.1) are saved in a copy each by the scheduler. From these the scheduler provides uniform values of the previous scan and edge checks:

```js
scheduler.previous(owner, name);  // tdata: observer.previous(name); binding state or variable: saved by the scheduler
scheduler.rose(owner, name);      // !previous && current
scheduler.fell(owner, name);      // previous && !current
scheduler.changed(owner, name);   // previous differs from current (NaN equals NaN)
```

### 5.2 Triggers

Scans have two kinds of triggers:

| Trigger | Source | `tick` |
| --- | --- | --- |
| Periodic tick | Once every `MAIN_PERIOD` (500 ms) | true |
| Scan request | `request_scan()`: writes of tdata (including HMI writes through Unit_Map), actuator data read back, Binding state changes and write completions | false |

- `request_scan()` merges with `setImmediate`: several requests in the same round of the event loop cause only one scan; when a periodic tick arrives while a request is pending, the scan of the tick handles it as well.
- Requests during a scan come from the writes of the scan itself (the periodic tick never calls `request_scan()`, and external callbacks can only run between two scans):
  - requests in the input and evaluate phases are ignored: the later rules of this scan already read these writes, and their changes are detected as well; derive rules write in every scan, and if they caused scans too, scanning would never stop;
  - requests from the start of the publish phase on schedule the next scan: the tdata written by event handlers may already have been detected in this publish phase.
- When `scan()` is called during a scan (e.g. in a rule or an event handler), it does not run nested but is queued after the current scan.
- Timing advances only when `tick` is true, and scans triggered by requests do not advance it, so the number of scans does not affect timing (6.3).

### 5.3 Timing

- After actuator data is read back, an HMI write, or a connection state change, a scan runs immediately: derived states and interlock actions are completed in this scan, and the resulting commands are sent in the output phase of this scan.
- Reads are started periodically, and the freshness of actuator data is limited by the read period; the acknowledgement of commands is in `response_code` of the node tdata, obtained by the periodic read.
- Within one period several scans happen because of the read-backs of different actuators, and the begin and end data of a section may be read at different moments; the flow difference evaluation has a confirmation delay, so it is not affected by momentary inconsistencies.
- The controller neither debounces nor filters the values reported by actuators; signal debouncing is done by the actuators.

### 5.4 Error isolation

The controller is a safety system, and one defect must not stop the other interlocks:

- Each rule runs on its own; when it throws, the exception is reported through `on_error(error, source)` injected when the scheduler is created, and the following rules continue; `source` is the failing rule, tdata or Binding;
- In the publish phase the detection of each tdata (with its event handlers) is isolated on its own;
- Failures of asynchronous reads and writes in the output phase are reported through `on_error` as well;
- The controller wires `on_error` to the log; the scheduler itself does not log, and exceptions are ignored when it is not injected.

### 5.5 Scheduler interface

```js
const scheduler = new Scheduler({ period: MAIN_PERIOD, on_error });
scheduler.add_data(tdata);                    // detected in the publish phase, snapshot at the end of a scan
scheduler.add_binding(binding, input_group);  // loaded in the input phase, flushed and read in the output phase
scheduler.add_binding(binding);               // output only: flushed in the output phase, never read nor loaded
scheduler.add_var(owner, name);               // a shared variable: a property of an object (6.1)
scheduler.add_rule(rule);                     // built by derive() / act() (6.2)
scheduler.prepare();                          // order the rules and check them (6.4); throws with every error
scheduler.start();                            // periodic ticks: scan(true) every period
scheduler.request_scan();                     // a coalesced triggered scan: scan(false)
scheduler.stop();
```

- `prepare()` is called once before the first scan: it checks and orders all rules, assigns a ticker to each rule, and obtains a fixed execution table; nothing is registered afterwards.
- A Binding registered without an input group is write-only, used for the command blocks of actuators: the controller only writes commands to actuators and never reads them back.
- `scan(tick)` can be called directly, for tests to drive scans.
- `trace_dependencies()` / `untrace_dependencies()`: the dependency tracing test mode (6.5).

## 6. Rules (`src/rules.js`)

### 6.1 Dependency keys

The objects that rules read and write are uniformly expressed as "dependency keys", i.e. `(owner, name)` pairs:

- when the owner is a TData, the name is a tag name, e.g. `(section.data, 'comm_OK')`;
- when the owner is an ordinary object such as a section, line or actuator, the name is a property name of that object, e.g. `(section, 'press_SD_trigger')`. Such variables must be registered with `add_var`; a variable must be a property of some object, and a bare variable cannot be a dependency key;
- when the owner is a Binding, the name is a state name, e.g. `(binding, 'connected')`, read-only.

So TTags, variables (spec 3.6) and Binding states are ordered by the same rules.

A combined word shares the same data with its component bits but has a different name, and dependencies built by name cannot see the relation between them. Therefore:

- Rules write only component bits, never combined words. Whole-word writes come only from loading and the upward server, which are inputs of the scan; when several command bits need to be cleared (the acknowledgement handshake, command masking), they are written bit by bit by name;
- A combined word in `reads` is expanded before ordering into reads of all its component bits, after which dependencies are built by name. So a rule writing a bit is ordered before a rule reading the whole word; two rules writing different bits have no dependency between them.

### 6.2 The two kinds of rules

| Kind | Write constraint | Use |
| --- | --- | --- |
| derive | The only writer of its write keys, fully determining their values in every scan | Aggregations, differences, trigger bits, protection state, timing, `comm_OK`, `action_F`, `stop_pumps` and the like |
| act | Its write keys may have several writers (including the HMI, loading and other acts), and it may write only when a condition holds | Edge actions, interlock set / reset, sending and receiving commands, copying parameters, action records, `work_OK` |

Each rule has a name `name`, used in the startup checks and error reports, e.g. `section S1 comm_OK`. The keys declared by a rule are of three kinds:

| Field | Meaning |
| --- | --- |
| `reads` | Reads the values of this scan and forms dependencies: the writers are ordered before this rule |
| `writes` | The keys written |
| `reads_previous` | Reads the values at the end of the previous scan (`scheduler.previous()`), forming no dependency, used to break cycles (6.4) |

IO started by a rule (`request_write`) is only registered; the actual reads and writes are performed together in the output phase, forming no dependency, and are not declared.

Rules can use two kinds of state:

| State | Use | Values of the previous scan, edge checks |
| --- | --- | --- |
| Dependency keys (tags, Binding states, registered variables) | State shared by several rules, taking part in ordering | Provided by the scheduler (5.1) |
| Closure variables | State belonging to one rule only: latches, counts, the "previous value" it needs itself, and the like | Kept by the rule itself |

Closure variables are not registered and take no part in ordering, and only the rule they belong to may read and write them. Timing does not accumulate in closure variables, but uses the ticker assigned by the scheduler (6.3).

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

### 6.3 Timing (Ticker)

The scheduler assigns a Ticker to each rule and passes it as the argument of `run(ticker)` in scans. The rule decides itself when timing starts and stops, and the scheduler only advances it:

- `start()` starts timing from 0, and calling it while running has no effect, so a condition that keeps holding keeps counting; `stop()` stops and resets; `restart()` stops and then starts;
- `count` is the number of periodic ticks since the start, `elapsed` is `count * MAIN_PERIOD`;
- Advancing: in the input phase of a tick scan, the scheduler adds 1 to the `count` of the running tickers (5.1); scans triggered by requests do not advance them. Only running tickers are in the set, so the cost of advancing is proportional to the number of timings in progress;
- Rules do not receive the `tick` flag and do not accumulate counts themselves, so the number of scans does not affect timing;
- Each rule has only one ticker. Logic that needs two independent timings is split into two rules; e.g. the flow difference warning delay and the flow difference alarm delay of a section belong to two derive rules.

Delays by value are expressed by two helper functions:

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

When the condition of `off_delay` does not hold from the start, the output stays true for `delay_ms` after startup and then becomes false, consistent with the output of a TOF while its input is false.

Timing started by an edge (an action performed some time after an event, which the rule may abort on its own in between) is done by an act rule operating the ticker directly. An edge check is true only in the scan where the edge occurs, so the timing check must be outside the edge check:

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

Timing semantics:

- When the condition disappears or the rule calls `stop()`, it takes effect immediately, without waiting for the next tick. E.g. a manual hang-on during the countdown: the HMI writes `flow_override` of the section or line, triggering a scan, in which `protect_F` and `pre_stop_notice` become false and the countdown rule stops its ticker, so no flow difference action occurs;
- A ticker started between two ticks has `count` 1 at the next tick: after the condition holds, `on_delay` outputs true at the `floor(delay / MAIN_PERIOD) + 1`-th following tick;
- A ticker started in a tick scan has `count` 0 in that scan and counts from the next tick;
- When the condition appears and disappears between two ticks, the ticker stops and resets, without affecting timing;
- In scans triggered by requests `count` does not change, so rules depending on timing results produce no new edges when run repeatedly;
- Timing values that need to be shown externally (such as `countdown`) are converted from `elapsed` by the rule in every scan, and the value does not change between two ticks.

### 6.4 Ordering and checks

`prepare()` topologically sorts all rules once (Kahn's algorithm), giving a fixed execution order:

- Directed edge: rule writing key K -> rule reading key K; all writers of the same key are ordered before its readers;
- When a rule reads a key it also writes (read-modify-write, e.g. the rule containing `line_action_source &&= line.autoStopCmd`), that read forms no dependency edge;
- Keys in `reads_previous` form no dependency edges;
- Several writers of the same key, and rules without dependencies between them, are ordered by declaration order, so the result is repeatable.

Rules are declared after the whole object graph (all tdata, Bindings and variables) is built, because rules of upper levels reference tdata of lower levels, and rules of lower levels also reference tdata of upper levels (e.g. the section's `pre_stop_notice` reads the line's `pump_run`). The declaration order is actuators -> sections -> lines, objects of the same kind in configuration order, then the rule of the action record, and finally the command masking rule of each actuator (14.1).

E.g. the section's `pre_stop_notice` reads the line's `pump_run`, the line's `pump_run` aggregates the `pump_run` of the sections, and the line's `pre_stop_notice` in turn aggregates the `pre_stop_notice` of the sections. Ordering by level (section -> line) cannot give a correct order; ordering by key gives:

```
node.pump_run -> section.pump_run -> line.pump_run
  -> section.pre_stop_notice -> line.pre_stop_notice
```

which is computed right once within the same scan.

At startup the following errors are checked; when found, all errors are reported and the program refuses to start:

- A dependency cycle: the rules and keys on the cycle are reported, with the hint that `reads_previous` can break it;
- A key in `reads_previous` has no value of the previous scan: only tags, the `connected` / `read_ok` of Binding and registered variables have values of the previous scan;
- A key has a derive writer and also other rule writers;
- A rule writes a read-only Binding state;
- A rule writes a combined word;
- A rule declares a tag name or Binding state name that does not exist;
- A rule declares a variable not registered with `add_var`;
- A rule has no name, or two rules have the same name.

**Breaking cycles.** The dependencies between rules must be acyclic. When the business really needs a cycle, the rule author picks one place on the cycle and reads the value at the end of the previous scan there, i.e. puts this key into `reads_previous` in the declaration and reads it with `scheduler.previous()` in `run`. This is a unit delay in control systems: this quantity is always one scan period behind the others on the cycle, with fixed semantics. Copying the actuator parameters is an example (7.3).

```js
derive({
    name: 'line B',
    reads_previous: [[section.data, 'A']],
    writes: [[line.data, 'B']],
    run: () => { line.data.B = g(scheduler.previous(section.data, 'A')); },
});
```

The scheduler neither picks the breaking point automatically nor evaluates repeatedly within a scan until stable: whether it converges depends on the functions in the rules, not on the structure of the dependency graph, and is generally undecidable; even when it converges, the result may differ with the breaking point or the initial values. Where to break is a business decision, left to the rule author to write explicitly, which makes it easy to review.

### 6.5 Checking the dependency declarations

Dependencies rely on explicit declarations, and a missing read key leads to a wrong order without an error. So a check in test mode is provided:

- `trace_dependencies()` of the scheduler sets the access tracing hook of the data layer (3.3) and records the accesses into the actual read and write sets of the "current rule"; after a test runs some scans, a tag actually accessed but not declared is an error; reads of combined words are compared by their expanded component bits (6.1), and a write of a combined word is an error in itself;
- `scheduler.previous()` takes values from the snapshot and does not go through the accessors, so a tag declared only in `reads_previous` that is read directly is reported as an error too (it reads the value of this scan);
- The hook can trace only tags; Binding states and variables do not go through accessors and are outside the check;
- In the immediate detection mode, writes of a rule emit events during the execution of the rule, and accesses in event handlers are recorded under that rule; by the convention of 6.6, event handlers only log and take the values they need from the event arguments, causing no extra accesses;
- The fixture of the system tests turns the check on in every test and requires no undeclared accesses.

At run time the hook is not set. "Run once and infer the dependencies automatically" was not adopted, because the short-circuiting of `&&`, `||` and conditional branches mean one run cannot see all reads.

### 6.6 Coding conventions for event handlers

This is a convention of the controller code, not a restriction of TData / TTag: TData / TTag prevent no writes.

- Derived logic such as interlocks and aggregations is written as rules, not in event handlers, so that a scan is based on one set of inputs and the result does not depend on the order of events;
- Event handlers are for logging; writing tags in handlers is allowed, and such a write requests a scan and is read by the rules in the next scan;
- Logic that needs asynchronous operations is written as act rules: the rule registers the request, Binding records the completion state and requests a scan, and the follow-up processing is done by the rule reading the completion state (4.5).

## 7. Actuator processing (`node_proc.js`)

### 7.1 IO binding

The data and command of each actuator have a Binding each (4.5), kept in `actuator.data_binding` / `actuator.command_binding`.

- data:
  - binds the whole structure, with the remote start `driver_info.data.start`;
  - `data_payload` contains the ID, the status bits, the measured values, `response_code` and the parameter block (not `comm_OK`, which the controller maintains itself);
  - `data_parameters` contains only the parameter block.
- command:
  - binds from local byte 16 (skipping the local area 0-15), with the remote start `driver_info.commands.start`;
  - `commands_payload` contains the ID, commands and the parameter block.

### 7.2 Reads and writes

- Reading the actuator data is done by the scan: the scan of a periodic tick starts the read in its output phase; when the data arrives, the `on_update` of Binding requests a scan, which loads `data_payload` in the input phase and detects the changes in the publish phase.
- The command Binding is write-only (5.5): rules register writes, which are written out in the output phase of the scan; after a write completes, `on_update` requests a scan. While the driver is not connected, write requests are kept and written out once the connection recovers.
- Driver events are only logged; the connection and read results are recorded by Binding as `connected` / `read_ok`, for rules to read.

### 7.3 Rules (`node_rules`)

| Rule | Processing |
| --- | --- |
| `comm_OK` (derive) | `off_delay(connected, delay_protect_time)`: true while connected, and kept for `delay_protect_time` after a disconnection before becoming false; when never connected, kept for the same time after startup |
| `work_OK` | Set to false when `off_delay(read_ok, delay_protect_time)` is false, i.e. when reads keep failing for longer than `delay_protect_time`; after a successful read, the loading restores the value reported by the actuator |
| Parameter refresh | The rising edge of `connected` starts timing, and after 2 s the parameters of the node tdata are copied to the command block; a disconnection in between stops it |
| Withdrawing `stop_pumps` (actuators with pumps) | On the falling edge of `pump_run`, clears `stop_pumps` of the command block |
| Acknowledgement handshake | When `response_code` changes and is not 0, for the bits set to 1 in `response_code`, the command bits of the same name in the command block are cleared bit by bit, and `executing` is cleared |
| `pressure_SD_F` | On change, clears the corresponding enable or disable command bit |
| `read_paras` | On the rising edge, copies the parameters of the node tdata to the command block and resets the bit |
| `write_paras` | On the rising edge, copies the parameters of the command block to the node tdata and registers a write of `data_parameters`; after the write completes (the sequence number of `write_done` is reached), resets the bit |
| `has_commands` (derive) | `commands` is not 0 |
| Sending | When `commands` changes, or when `response_code` changes and is not 0 (so the actuator sees the acknowledged bits cleared), registers a write of `commands_payload` |
| Resending | After `has_commands` has held for more than 3 ticks, registers a write again on every tick; timed per actuator |

- `write_paras` writes the parameters of the command block into the node tdata, while the parameter refresh and `read_paras` copy the parameters of the node tdata to the command block, and `comm_OK` / `work_OK` read `delay_protect_time` of the node tdata, which forms a cycle. The latter break this cycle by reading the node parameters at the end of the previous scan (`reads_previous`, 6.4): the node parameters come from the actuator, and being one scan late does no harm; `write_paras`, on the other hand, must read the command parameters of this scan, since the HMI often writes the parameters and then `write_paras` in the same request.
- Rules write only command bits, never the whole word `commands` (6.1).
- `pump_run` follows the value reported by the actuator (the actuator already ORs the states of its pumps), and the controller does not compute it separately.
- State changes are only logged; the aggregation to the section is done by the rules of the section (section 8).

## 8. Section processing (`section_proc.js`)

### 8.1 Event handling (`section_init`)

- Writes the section's ID, name and flow difference parameters (`flow_diff_WH` and the like, `action_time`).
- State changes (`action_F`, alarms, hang-on, `pre_stop_notice` and the like) are only logged.

### 8.2 Rules (`section_rules`)

The variables and rules of a section are declared after the object graph is built (6.4). The variables on the section object (not TTags, see spec 3.6) are registered with `add_var`:

- `press_SD_trigger`: the pressure interlock condition;
- `countdown_expired`: the countdown has expired;
- `press_action` / `flow_action`: the pressure action and the flow difference action.

derive rules, run in every scan, ordered among themselves by the ordering:

| Rule | Computation |
| --- | --- |
| `comm_OK`, `work_OK` | AND over all begin and end actuators |
| `press_warning_F` / `press_alarm_F` | OR of `pressure_WH_F` / `pressure_AH_F` over the begin and end actuators |
| `pump_run`, `pump_change_F` | OR of the properties of the same name over the actuators with pumps |
| `flow_begin` / `flow_end` | Sum of `flowmeter` of the begin / end actuators |
| `flow_diff` | `flow_begin - flow_end` |
| Trigger bits | `flow_warning_trigger = flow_diff > flow_diff_WH`, `flow_alarm_trigger` likewise |
| `press_SD_trigger` | OR of `pressure_AH_F && pressure_SD_F` over the begin and end actuators, logged on change |
| Protection state | `protect_prereq = comm_OK && work_OK && !pump_change_F`; `protect_F = protect_prereq && !flow_override && !line.flow_override`, i.e. no protection when either the `flow_override` of this section or that of its line is true; `hangon_AF = !protect_prereq` |
| `flow_warning_F` / `flow_alarm_F` | One rule each: `on_delay(ticker, trigger bit, *_delay)` |
| `pre_stop_notice` | `flow_alarm_F && line.pump_run && protect_F`: the pump running condition takes the line's (spec 5.2), while `stop_pumps` and the pressure action still take this section's |
| Countdown | Timing while `pre_stop_notice` is true, `countdown = (action_time - elapsed) / 1000`; when the result is below 0, `countdown` is set to 0 and `countdown_expired` is true |
| `action_F` | `press_action \|\| flow_action` |
| `stop_pumps` | `(section auto/man \|\| line auto/man) && pump_run` |

`pre_stop_notice` reads the line's `pump_run`, which in turn aggregates the `pump_run` of the sections; after ordering, they are computed in turn within the same scan, and no recomputation through the change event of the line is needed any more.

### 8.3 Interlock actions

act rules, run in every scan:

1. Stop command reset: on the falling edge of `pump_run`, clears the section's `autoStopCmd` / `manStopCmd`. It is declared before the pressure action; both write `autoStopCmd` and are ordered by declaration order.
2. Pressure action (variable `press_action`):
   - set when `press_SD_trigger && pump_run`, together with the section's `autoStopCmd`. `protect_F` is not checked, so it is not restricted by hang-on;
   - otherwise reset when `pump_run && !autoStopCmd`: a pump of this section is running (necessarily restarted after the stop), and the interlock condition has disappeared.
3. Flow difference action (variable `flow_action`):
   - set on `countdown_expired`, together with the line's `autoStopCmd` and this section's `line_action_source`;
   - otherwise first runs `line_action_source &&= line.autoStopCmd`, then resets when `line.pump_run && !flow_alarm_F && !line_action_source`. The pump running condition takes the line's, as for the stop pump notice; otherwise a section without pumps could never reset.
4. The reset conditions are evaluated in every scan and not latched; during the stop neither pump running condition holds, so the action state is kept until pumps run again.
5. Action record: on a rising edge of either action variable, sets the line's `action_section_ID` to this section's ID and calls `add_action_record()` to create a record; when both happen in the same scan, only one record is created. When both action variables are false and the line's `action_section_ID` equals this section's ID, it is cleared, so as not to erase the action of another section.
6. Pump commands: on changes of the section's `stop_pumps`, when true sets `command.stop_pumps = node.data.pump_run` for each actuator with pumps; when false sets `stop_pumps = false` and `cancel_stop = true`.

The section layout is planned to change in a future transitional version dedicated to layout adjustments: `press_action` / `flow_action` then become TTags, and the action record will be triggered by their change events instead of checking rising edges in the action record rule.

## 9. Line processing (`line_proc.js`)

- Rules (`line_rules`, derive):
  - `pump_run`, `pre_stop_notice`: the OR of the properties of the same name of the sections;
  - `alarm_F`: the OR of `flow_alarm_F` and `press_alarm_F` of the sections.
- The line's `flow_override` is only logged and does not overwrite any section; its effect shows as an AND in the `protect_F` rule of the sections (see 8.2).
- act rule: on the falling edge of `pump_run`, clears the line's `autoStopCmd` / `manStopCmd`.

## 10. Action records (`action_record.js`)

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
- `index` is handled by an act rule (`action_record_rule`), declared after the rules of all sections; the rule remembers the record currently shown in a closure:
  - when `index` differs from the one shown: when -1, clears the time TTags; otherwise loads the corresponding record into data, and when out of range restores the previous value.
- The record content is filled in by the section's `add_action_record()` when a pressure action or a flow difference action occurs (see 8.3); `press_action` / `flow_action` take the action variables of the section; the rule for actuator positions is in section 13.

## 11. Logging

- log4js has two categories:
  - `default`: writes `logs/info.log` and `logs/error.log` with the date pattern `yyyy-MM-dd` of the file appender (`alwaysIncludePattern`, `keepFileExt`, `fileNameSep: "_"`), so the actual file names are `logs/info_<yyyy-MM-dd>.log` and `logs/error_<yyyy-MM-dd>.log` (rolled daily, each file limited to 10 MB, compressed); also writes to the console when `TLMS !== 'controller'`;
  - `console`: writes only to the console.
- `logger` is a wrapper object that can switch categories.

## 12. Runtime environment, dependencies and build

### 12.1 Runtime environment and process management

- Runtime environment: Node.js; the sources are ES modules (using `import ... with { type: 'json' }` and `import.meta.dirname`).
- Background running uses pm2 (a peer dependency):
  - `tlms start` first runs `pm2 delete tlms_esd`, then `pm2 start` with the fixed process name `tlms_esd`, so only one instance exists at a time;
  - `stop`, `list`, `log`, `flush` correspond to `pm2 delete`, `pm2 list`, `pm2 log`, `pm2 flush`;
  - pm2 starts with `TLMS=controller` set, and the logging module turns off the console output accordingly.

### 12.2 Dependencies

| Library | Use |
| --- | --- |
| `es-modbus` | Modbus TCP client (to the actuators) and server (to the HMI) |
| `@st-one-io/nodes7` | S7 client (to the actuators) |
| `yaml` | Configuration and layout parsing (YAML 1.2) |
| `csv-parser` | Reading the action record CSV |
| `log4js` | Logging |
| `mri` | Command-line argument parsing |

### 12.3 Development tools

- Package manager: pnpm.
- Tests: `node --test`.
- Linting: ESLint with `@stylistic/eslint-plugin` (`eslint.config.js`, `pnpm lint`); JS is indented with tabs. ESLint finds code problems; @stylistic only regulates whitespace, quotes, semicolons and the like, without re-wrapping lines, so the hand-aligned layout tables are kept. Formatters that re-wrap lines (Biome, Prettier) are not used. In addition, the globals equivalent to the `Number` namespace (`isNaN`, `isFinite`, `parseInt`, `parseFloat`, `NaN`, `Infinity`) are forbidden; `Number.isNaN` and the like are used instead.

### 12.4 Build and release

- `rolldown.config.js` produces two ES module bundles:
  - `src/main.js` -> `./main.js`;
  - `src/cli.js` -> `./cli.js`, with `./main.js` set as external, so `cli.js` imports the bundle in the same directory at run time.
- The `prepare` script of `package.json` triggers the build; `bin.tlms` points to `cli.js`.

## 13. Unimplemented items

Requirements of the spec that the current code does not implement yet:

| Item | Spec requirement | Current code | Locations |
| --- | --- | --- | --- |
| ID uniqueness check | The IDs of lines, sections and actuators are all distinct (across types); several tdata of the same object share its ID (spec 4.1) | `config.js` only checks that an actuator `id` is a non-zero number; lines, sections and actuators are each indexed by `ID<id>`, and neither duplicates nor equal IDs across types are reported; a duplicate of the same type silently overwrites the earlier one | `add_conf` in `config.js` |
| ID as the upward unit id | The Modbus unit id of a line, section or actuator is its ID (at least 1), the action record is fixed at unit id 0, and the controller configuration no longer has `unit_id` (spec 4.1, 5.5) | `build_runtime` looks up the unit id by name in `controller.modbus_server.unit_id[name]` (the action record in `unit_id.action_records`), and every object must be listed in the controller configuration | `build_runtime` in `runtime.js` |
| Configuration check command | `tlms check` reads and validates the configuration and all layouts (`validate_structure` of 3.2), reports all errors, and does not start the controller (spec 3.6, 5.6) | No such command; configuration errors are found only at startup, and most of them exit or crash directly; the layout validation already runs at startup (`main.js`) but is not yet wired into the command line | `cli.js`; `config.js` needs a separately callable validation function that collects all errors |
| Action record positions mapped to actuators (defect in the existing code) | Nodes 1-4 map to the actuators of the action section in order, begin actuators first, then end actuators; the pressure, ID and pump running state of each position come from the same actuator (spec 5.4) | Nodes 1-3 always take `begin_nodes[0..2]`, node 4 always takes `end_nodes[0]`; `node1..3_pump_run` come from `pump_nodes[0..2]` (actuators with pumps only, which may be misaligned with the node positions), and `node4_pump_run` is never assigned | `add_action_record` in `section_proc.js` |

## 14. Command processing

All commands go through the common handshake of 7.3 (send the command word, clear the corresponding bits on receiving `response_code`); some commands also have local processing in the controller:

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

### 14.1 Command masking

Commands are masked by the `supported_commands` configured for each actuator (spec 5.1):

- Parsing: when `config.js` parses an actuator, it converts the `supported_commands` array into a 16-bit mask word `command_mask`. For each command name of the array, the command word bit k is looked up in the command enumeration (`node_commands`), and bit k of the mask is set to 1; the bit numbers are the register bits (see 3.2).
- Validation: a name outside the command enumeration in the array is a configuration error; the program reports it at startup and exits, in the same way as the validation of the actuator `id`.
- When the field is omitted, all commands are supported, and `command_mask` takes all bits 0-13 of the command enumeration, i.e. `0x3FFF`.
- Use: `command_mask` is carried into the runtime with the actuator object. Each actuator has a masking rule, which in every scan resets by name, bit by bit, the command bits that are 0 in `command_mask`; bit 14 (`reserve`) and bit 15 (`executing`) are not commands and are not affected.
- The masking rule is declared after all other rules: several writers of the same command bit are ordered by declaration order, so it comes after the other rules writing command bits; since it writes command bits, it comes before the sending rule that reads `commands`, so unsupported command bits are never sent.

