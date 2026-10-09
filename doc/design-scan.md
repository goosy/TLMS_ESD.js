# Data Layer and Scan Cycle Refactoring Design (Draft)

> English version of [design-scan.zh-cn.md](design-scan.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document is the target design of an internal refactoring and describes how the data layer and the main loop work after the refactoring. The current state is in [design.md](design.md), the requirements in [spec.md](spec.md).
> The refactoring changes no layout, point table or protocol, and no evaluation condition of the interlock logic; the timing changes are in section 9, which also lists the spec entries to be changed accordingly.
> The migration steps are in [plan-scan.md](plan-scan.md). After the refactoring, the content of this document is merged into sections 3, 5, 6 and 7 of design.md, and this document is deleted.
> The interface TData / TTag promise to their users is in [spec-data-api.md](spec-data-api.md): they are general data objects for programmers, values can be read and written at any time, and events are emitted when values change; the scan-based data flow of this document is only how the controller uses them and does not restrict their capabilities.

## 1. Goals and overall structure

The refactoring solves four problems of the current state:

| Problem | Current | After the refactoring |
| --- | --- | --- |
| Accessors | Each TData instance calls `defineProperty` for each tag; TTag creates closures per type in `init()`, with much repeated code across types | Each structure is compiled once, with accessors defined on the prototype; a codec table is looked up by type (sections 2, 3) |
| Change detection | Relies on every write path calling `check_change` itself, and combined words are linked manually through the `coupling` list; the value cached by TTag may disagree with the buffer | The buffer is compared with a snapshot byte by byte, detection is the same for all writers, and the `coupling` linkage and the value cache are removed (section 5) |
| Derived values | Aggregated values propagate level by level through events + 50 ms debounces, and the result depends on how timers and IO returns interleave | Each scan evaluates synchronously in dependency order; scans are triggered immediately by arriving inputs, and the periodic tick only advances timing (sections 6, 7) |
| Responsibilities | TData carries layout, mirror, driver binding and events at once | Split into the four layers Layout, TData, Binding, Observer (this section) |

The four layers:

| Layer | Responsibility | Instances | Mutability |
| --- | --- | --- | --- |
| Layout | Compiled from the YAML layout description: byte positions and codecs of the tags, the reverse table from bytes to tags, prototype accessors | One per structure | Immutable |
| TData | The value buffer `buffer` (big-endian), access by name, raw write methods, the TTag handles returned by `get(name)` | One per tdata | Mutable |
| Binding | Correspondence between `buffer` ranges and driver addresses, device byte order, write unit, `IO_buffer`, group reads and writes, connection and completion states | One per binding of a tdata to a driver | Binding parameters immutable, states mutable |
| Observer | Snapshot comparison, emitting change events, providing the values at the end of the previous scan | One per tdata | Mutable |

Dependency direction: Binding and Observer depend on TData and Layout, TData only on Layout, Layout only on the layout description. Drivers appear only in Binding. The scan scheduler (section 6) is the only module that calls rules; TData and Binding notify it only through callbacks passed in by the user (wired to `request_scan()` in the controller) and do not know the scheduler exists.

### 1.1 Component boundary

Layout, TData (with the TTag handles), Observer and the upward server (vector and Unit_Map) are to become a separate component in the future, shared by a Modbus device emulator and controllers like this project: the component offers a Modbus TCP server and operates its internal state through TData / TTag. The component is not separated this time, but the code is organized along the component boundary:

- The component code lives in `src/typed_data/`: `codecs.js`, `structure.js` (structure expansion and layout validation), `layout.js`, `types.js` (type declaration generation), TData, TTag, Observer, and the vector and Unit_Map moved in;
- The component code must not import modules outside the component: it does not depend on the configuration (`config.js`), the business processing (`*_proc.js`), the project's layouts (`src/layouts.yaml`, `src/layouts.js`) or the project's logger (`util.js`);
- On errors the component code throws, without logging or calling `process.exit`, and the caller decides how to report and exit; non-fatal situations at run time that need reporting (such as accessing an unmapped address) go through a logger injected by a constructor argument, which outputs nothing by default;
- Layout descriptions are external input to the component: this project's `src/layouts.yaml` is handed to the component for compilation by `src/layouts.js`;
- Binding, the scheduler, rules and Ticker do not belong to the component; they may depend on the component, and the component does not depend on them; the controller gives `request_scan()` to TData as the `on_write` callback (3.3), and the component does not know the scheduler exists;
- The interface of the component (spec-data-api.md) is for programmers: TData / TTag can be read and written at any time and emit events when values change, and the component does not restrict these capabilities because of the scheduling of any user.

The parts of the existing code that do not yet meet the boundary are removed step by step in the migration plan (the steps of section 3 of plan-scan.md).

## 2. Layout

### 2.1 Layout description (YAML)

The layout description is pure data, given as a YAML file and no longer written in JS modules. So the data layer does not depend on the structure definitions of any specific project: this project's layouts are released with the code, and when the data layer becomes a separate component in the future, the layouts are external configuration passed in by the caller. The file format, item fields and validity rules are in section 6 of spec-data-api.md.

This project's layout file is `src/layouts.yaml`, in `src/` together with the entry module, compiled at load time by `src/layouts.js`, which exports `LINE`, `SECTION`, `NODE`, `COMMAND`, `RECORD` and the fragments the business logic needs (such as the list of names of the parameter block). At build time the file is copied as a separate file next to `main.js` (not bundled into `main.js`), and its path is resolved from the module location, so it has the same position relative to the entry module when running from source and when running the bundle. When a layout is invalid, each violation is written to the error log and the program exits, meeting "refuse to start on layout violations".

### 2.2 Compilation

- `compile_layout(yaml_path)`: reads and parses the YAML synchronously, resolves fragment references, expands each layout with `build_structure` and validates it with `validate_structure`; on violations it throws an error containing all of them. Returns `{ layouts, fragments }`: `layouts` indexes the Layouts by layout name, `fragments` indexes the expanded item lists by fragment name.
- `layout_of(data_struct)`: compiles an expanded structure into a Layout, cached by the structure object. `compile_layout` uses it internally; structures built from JS items in tests are compiled by it as well.

The content of a Layout:

- `size`: the number of bytes, i.e. `data_struct.length >> 3`;
- `entries`: the item table indexed by name, each item containing:
  - `name`, `type` (lower case), `init_value`;
  - `byte`: byte offset;
  - `size`: number of bytes (1 for Bool and single-byte types, 2 for 16-bit types, 4 for 32-bit types);
  - `mask`: `1 << (offset % 8)` for Bool, `0xff` otherwise;
  - `codec`: the entry of the type in the codec table;
- `tags_at_byte`: an array of length `size`, whose item i holds all items covering byte i. A combined word and its component bits fall on the same bytes and appear together in the corresponding items;
- `Data_Class`: the TData subclass dedicated to the structure (see 2.4);
- the same `name`, `length`, `items` as the expanded structure, so existing code that uses structures as `NODE.items` and the like is not affected.

`layout_of` assumes the structure is valid and does not repeat the layout rule validation; it only checks that tag names do not conflict with members of TData (an accessor would shadow the member on a conflict).

### 2.3 Codec table

Each type has an entry in the table; `get(buffer, entry)` decodes from the big-endian buffer, and `set(buffer, entry, value)` encodes and writes:

```js
const CODECS = {
    bool:  { get: (b, e) => (b[e.byte] & e.mask) !== 0,
             set: (b, e, v) => { b[e.byte] = v ? b[e.byte] | e.mask : b[e.byte] & ~e.mask; } },
    byte:  { get: (b, e) => b.readUInt8(e.byte),   set: (b, e, v) => b.writeUInt8(v, e.byte) },
    usint: { get: (b, e) => b.readUInt8(e.byte),   set: (b, e, v) => b.writeUInt8(v, e.byte) },
    sint:  { get: (b, e) => b.readInt8(e.byte),    set: (b, e, v) => b.writeInt8(v, e.byte) },
    int:   { get: (b, e) => b.readInt16BE(e.byte), set: (b, e, v) => b.writeInt16BE(v, e.byte) },
    // uint, word, dint, udint, dword, real follow the same pattern
};
```

All code in TTag that creates closures by type branches is replaced by this table. The device byte order is not handled in the table, only in Binding (section 4).

### 2.4 Prototype accessors

At compilation a TData subclass is generated for each structure, and an accessor is defined once on its prototype for each item:

```js
class Data_Class extends TData {}
for (const entry of entries) {
    const { get, set } = entry.codec;
    Object.defineProperty(Data_Class.prototype, entry.name, {
        get() { return get(this.buffer, entry); },
        set(value) { set(this.buffer, entry, value); this.after_write(entry); },
        enumerable: true,
    });
}
```

- The getter decodes from `buffer` every time and no longer caches values, so the cache can never disagree with the buffer.
- After writing `buffer`, the setter calls `after_write(entry)`, whose behavior is in 3.2.
- A combined word and its component bits share the same bytes; after writing either side, the other side naturally reads the new value, and `check_coupling` is not needed.
- The type declarations `src/layout_types.d.ts` are generated from the layout file (one interface per layout, the tags as properties, `comment` as doc comments), providing editor completion for access by name; the generated file goes into version control, and a test checks it matches the layout file.

Name conflicts: a tag name must not equal a member of TData, a rule still checked by `validate_structure`. Since Binding and Observer no longer hang on TData, the members of TData are reduced to a few such as `name`, `layout`, `buffer`, `size`, `get`, `after_write` and the write methods of 3.2, and the reserved name table shrinks accordingly.

## 3. TData

### 3.1 Creation and access

- Created by `new layout.Data_Class(name)`:
  1. allocates `buffer` (`layout.size` bytes);
  2. encodes and writes the `init_value` of each item in turn.
- External interface (complete definition in spec-data-api.md):
  - reading and writing by name: `data.pressure`, `data.pressure = v`;
  - `get(name)`: returns the TTag of the tag, `undefined` when the name does not exist;
  - raw write methods (3.2);
  - `detect()`: detects and reports the changes since the previous detection (3.3);
  - `buffer` (read access), `size`, `name`, `layout`.
- A TTag is a friendly interface for operating a single tag, holding neither a value nor a buffer slice:
  - `value` is readable and writable: reading decodes from `buffer`, and writing is exactly equivalent to `data[name] = v` (the same setter);
  - descriptions such as `name`, `type`, `length` come from the Layout item;
  - event subscription: `on('change', (old_value, new_value) => ...)`, fired by Observer (section 5).

  TTags are created on demand and cached; no TTag is created for a tag that has never been `get`.
- The block-wide `change(tagname, old, new)` event is emitted by Observer through TData.

### 3.2 Writes and scan requests

There are only two ways to write `buffer`, both through TData:

| Way | Users | After the write |
| --- | --- | --- |
| Assignment by name (`data[name] = v` or `tag.value = v`) | Any code: rules, event handlers, asynchronous callbacks, ordinary programs | Processed by the detection mode (3.3) |
| Raw write methods | The upward server (Unit_Map) | Processed by the detection mode (3.3) |

Writes are allowed at any time, whether during a scan or not.

The raw write methods are located by byte offset, for writers that do not access by tag name:

- `write_register(offset, value)`: writes a 16-bit register (big-endian);
- `write_bit(offset, mask, value)`: writes one bit of a byte (a coil);
- `write_bytes(offset, source)`: writes a run of bytes.

The vector functions `set_register` / `set_coil` of Unit_Map (the names of es-modbus v0.3) use `write_register` / `write_bit` instead, no longer call `buffer.writeUInt16BE` directly, and no longer call detection themselves; detection is handled by TData according to the detection mode. The TData of the controller use the immediate detection mode (3.3): one function code 16 request calls `set_register` several times in a row within one synchronous call, and each write detects immediately, so a Real spanning two registers emits one `change` event with a half-written value after the first register and another with the complete value after the second; rules are not affected, because `request_scan()` merges (6.2) and the scan runs only after the whole request has been handled, so rules read the complete value.

The loading of Binding (4.2) writes the content of `buffer` directly in the input phase of a scan; it is internal to the scan, does not go through the methods above, and does not request a scan; the changes after loading are detected in the publish phase of the same scan.

Apart from the data layer (`src/typed_data/`) and Binding, no code may write the content of `buffer` directly; a test checks that no other file in `src/` calls a write on `.buffer`.

### 3.3 Implementation of the detection modes

Detection itself is done by Observer (section 5): `diff()` compares `buffer` with the snapshot and reports the changes. Observer does not distinguish modes; the two modes (behavior in 4.2 of spec-data-api.md) only decide who calls `diff()` after a write of TData, and when.

All write paths end in the same private method of TData:

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

- Immediate mode: calls `diff()` synchronously inside the write statement, then `on_write`;
- Deferred mode: only calls `on_write` without detecting; detection is done by the user calling `detect()`;
- The scan is not part of TData: TData has no phases, ordering or timing, and only chooses between "detect itself" and "leave it to the user".

**The controller uses the immediate mode.** All tdata of the controller (data and command of lines, sections and actuators, the action record) always use the immediate detection mode, with `on_write` wired to `request_scan()` of the scheduler, so any write (rules, event handlers, HMI, asynchronous callbacks) requests a scan after detection.

The reasons for the immediate mode:

- Values are equally timely in both modes: writes take effect immediately, and rules always read the current value; the detection mode only decides when `change` events are emitted;
- The interlocks and aggregations of the controller are all in rules and do not depend on events (section 8), so the deferred mode brings no benefit to the interlock results;
- In immediate mode events are emitted in the call stack of the write, so the writer can be traced when debugging;
- During the migration the existing event handlers depend on "receiving the event right after the assignment"; always using the immediate mode avoids another switch at the end of the migration.

The known costs affect only event handlers (mainly logging): the events of writes of rules in the evaluate phase are emitted in the middle of rule execution; several changes of the same tag within one scan emit separate events; a function code 16 write of a value spanning two registers shows one intermediate value (3.2).

## 4. Binding

### 4.1 Binding parameters

`new Binding(data, driver, { start, remote_start, length, endian }, ...extras)`:

- `start` / `length`: the exchange area `[start, start + length)` within the TData, in bytes;
- `remote_start`: the remote start; `extras` is passed to the driver as is (`unit_id` for Modbus, `area, db` for S7);
- `endian`: `BE`, `LE` (`little`), `BEBS`, `LEBS`;
- `write_unit`: taken from `driver.write_unit`, default 1;
- the three exchange area parameters must be whole multiples of the write unit, otherwise an error is thrown (replacing today's `process.exit(1)`);
- Binding holds `IO_buffer` (in device byte order, as long as the exchange area), and data read by the driver is written only into `IO_buffer`.

### 4.2 Byte mapping and ownership masks

The device byte order applies per 16-bit register and per 32-bit value (spec 3.6). Binding precomputes for each byte of the exchange area its index `io_index[i]` in `IO_buffer`:

- 2-byte items: the two bytes are swapped for `LE` / `little` / `BEBS`, unchanged for `BE` / `LEBS`;
- 4-byte items: converted by the four orders `BE`, `LE`, `BEBS`, `LEBS` (the same as today's `convert_endian_4bytes`);
- Bool and single-byte items: `byte ^ 1` for `LE` / `little` / `BEBS`, unchanged otherwise;
- bytes belonging to no item are converted by the 2-byte rule.

The layout validation guarantees that non-Bool items do not overlap and Bools fall only inside combined words, so the mapping of each byte is unique.

A group (replacing TGroup, with the interface name `create_group(...names)` keeping the existing usage) computes at compilation an **ownership mask** `own[i]` for each byte of the group:

- bytes covered by a non-Bool item are `0xff`;
- a Bool item sets only the bit of its `mask`;
- several items of the group on the same byte are ORed.

So loading and exporting a group are both a compact byte-by-byte loop:

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

Loading changes only the bits occupied by the items of the group; e.g. `comm_OK` in the node status word is maintained by the controller and not in `data_payload`, so it stays unchanged on loading, the same result as today's tag-by-tag `read_from`. The computation of write ranges (extending to write units, merging intersecting or adjoining ranges) follows 3.4 of design.md, only moved from TGroup to the compilation of groups.

### 4.3 Reads and writes

- `request_read()`: starts one read of the whole area; when it completes, copies the data into `IO_buffer`, sets `fresh = true` and calls `request_scan()`. While the previous read has not completed, no new read is started, so requests do not pile up on slow devices.
- `load(group)`: in the input phase of a scan, performs the loading of 4.2 and clears `fresh`; it changes only `buffer`, emits no events, and requests no scan.
- `request_write(group)`: registers a write request; the same group registered several times within one scan is written only once.
- `flush_writes()`: in the output phase of a scan, exports the registered groups, then calls the driver to write by write range. Writes are asynchronous and do not block the scan.
- While the driver is not connected, `request_read` and `flush_writes` skip directly and keep the write requests, consistent with today's behavior when `check_driver` returns false.

### 4.4 Connection and completion states

Driver events and the results of asynchronous reads and writes no longer change tags directly from callbacks, but are recorded as states of Binding for rules to read:

| State | Updated when |
| --- | --- |
| `connected` | The driver's `connect` / `connfailed` events |
| `read_ok` | Each read completes: true on success, false on failure (today's `io_error` of the driver) |
| `write_done(group)` | A write of a group completes; records the completion sequence number and result, for rules to decide "the write requested last time has completed" |

After every state change Binding calls `request_scan()`. These states are dependency keys of rules (7.1); they are inputs, written only by Binding.

## 5. Observer

### 5.1 Snapshot comparison

Each TData has an Observer, which holds a snapshot `snapshot` as long as `buffer`, copied from `buffer` at creation (i.e. the encoding of the `init_value`s). The algorithm of `diff()`:

```js
diff() {
    const { buffer, snapshot, layout } = this;
    const seen = new Set();
    for (let i = 0; i < layout.size; i++) {
        if (buffer[i] === snapshot[i]) continue;
        for (const entry of layout.tags_at_byte[i]) {
            if (seen.has(entry)) continue;
            seen.add(entry);
            const old_value = entry.codec.get(snapshot, entry);
            const new_value = entry.codec.get(buffer, entry);
            if (!same_value(old_value, new_value)) this.changes.push([entry, old_value, new_value]);
        }
    }
    buffer.copy(snapshot);
    this.emit_changes();
}
```

- The old value is decoded from the snapshot and needs no cache.
- `same_value` treats two NaN as the same, consistent with today's `check_change`.
- The comparison and the snapshot update are completed first, then the events are emitted together in layout order: for each change, first the block-wide `change(name, old, new)`, then the `change(old, new)` of the TTag; events are always emitted after the new values take effect.
- Several writes within one detection merge into one event, whose old value is the value at the previous detection; a value that changed and was then restored emits no event.
- When handlers write again while changes are reported, another round of comparison follows; when there are still new changes after 16 consecutive rounds, an exception is thrown to prevent oscillation.
- Benchmark (the NODE structure, 74 tags, 146 bytes): with no or few changes it is 9 to 16 times faster than today's tag-by-tag check, and about 2 times faster with all values changed.

### 5.2 Detection and response

- Detection is complete: wherever a write comes from, the change is found by the next detection (after the write in immediate mode, in the publish phase of the scan in deferred mode), and nothing is missed.
- Response is timely: writes through the raw write methods of TData and through Binding request a scan immediately (3.2, 4.3, 4.4); should a write bypass them, the change is still processed at the latest in the scan of the next periodic tick, only slower, never lost.

### 5.3 Values of the previous scan

Observer provides `previous(name)`, which returns the value at the end of the previous scan: it decodes from the scan snapshot `scan_snapshot`, which the scheduler updates by calling `take_scan_snapshot()` at the end of each scan. In deferred mode the scan snapshot and the detection snapshot are the same after every scan; in immediate mode the detection snapshot keeps refreshing between scans, so the two are kept separately.

Binding states (4.4) and registered variables (7.1) have no Observer; the scheduler saves a copy of their values at the end of each scan. From these the scheduler provides uniform values of the previous scan and edge checks (6.5):

```js
scheduler.previous(owner, name);  // data block: observer.previous(name); binding state or variable: saved by the scheduler
scheduler.rose(owner, name);      // !previous && current
scheduler.fell(owner, name);      // previous && !current
scheduler.changed(owner, name);   // previous differs from current (NaN equals NaN)
```

## 6. Scan

### 6.1 Four phases

The `scan(tick)` of the scheduler runs entirely synchronously:

```js
function scan(tick) {
    // 1 input: take the process image, advance running tickers on periodic ticks
    phase = "input";
    for (const { binding, input_group } of bindings) if (binding.fresh) binding.load(input_group);
    if (tick) for (const ticker of running_tickers) ticker.count++;
    // 2 evaluate: all rules in one fixed dependency order, each isolated (6.4)
    phase = "evaluate";
    for (const rule of ordered_rules) guarded(() => rule.run(rule.ticker), rule);
    // 3 publish: detect every change since the last scan, emit change events
    phase = "publish";
    for (const data of data_blocks) guarded(() => data.detect(), data);
    // the end of this scan: data blocks, binding states and variables save their values
    take_scan_snapshots();
    // 4 output: send what was requested, start reads on periodic ticks
    phase = "output";
    for (const { binding } of bindings) binding.flush_writes().catch(report);
    if (tick) for (const { binding } of bindings) binding.request_read().catch(report);
    phase = "idle";
}
```

1. **Input**: loads the actuators with new data from `IO_buffer` into `buffer`, forming the process image of this scan. Actuators without new data keep their values, and communication anomalies are reflected by `comm_OK` / `work_OK` (as today). The scan of a periodic tick also adds 1 to the count of all running tickers (7.3).
2. **Evaluate**: runs all rules in the order arranged by section 7, computing aggregated values, trigger bits, timing and interlock actions, and registering write requests.
3. **Publish**: all Observers compare their snapshots and emit change events. Event handlers only log (section 8).
4. **Output**: performs the write requests registered in this scan; the scan of a periodic tick also starts the next round of reads. Reads and writes are asynchronous; when they complete, the `on_update` of Binding requests a scan, by which time this scan has ended.

"The values at the end of the previous scan" are saved after the publish phase: the writes made by rules and event handlers in this scan all count as part of this scan.

### 6.2 Triggers

Scans have two kinds of triggers:

| Trigger | Source | `tick` |
| --- | --- | --- |
| Periodic tick | Once every `MAIN_PERIOD` (500 ms) | true |
| Scan request | `request_scan()`: HMI writes through Unit_Map (3.2), actuator data read back (4.3), Binding state changes (4.4) | false |

- `request_scan()` merges with `setImmediate`: several requests in the same round of the event loop cause only one scan; when a periodic tick arrives while a request is pending, the scan of the tick handles it as well.
- Requests during a scan come from the writes of the scan itself (the periodic tick never calls `request_scan()`, and external callbacks can only run between two scans):
  - requests in the input and evaluate phases are ignored: the later rules of this scan already read these writes, and their changes are detected as well; derive rules write in every scan, and if they caused scans too, scanning would never stop;
  - requests from the start of the publish phase on schedule the next scan: the tdata written by event handlers may already have been detected in this publish phase.
- Writes outside scans are allowed as usual (event handlers, asynchronous callbacks, the upward server): the `on_write` of the controller's TData is wired to `request_scan()` (3.3), so any write causes a scan.
- Timing advances only when `tick` is true: the scheduler advances all running tickers in the input phase of a tick scan, and scans triggered by requests do not advance them, so the number of scans does not affect timing. Rules do not receive the `tick` flag and do not accumulate counts themselves (7.3).

### 6.3 Timing

- After actuator data is read back, an HMI write, or a connection state change, a scan runs immediately: derived states and interlock actions are completed in this scan, and the resulting commands are sent in the output phase of this scan.
- Reads are still started periodically, and the freshness of actuator data is limited by the read period, as today.
- Within one period several scans happen because of the read-backs of different actuators, and the begin and end data of a section may be read at different moments. This is the same as today (actuators were never read at the same time), and the flow difference evaluation has a confirmation delay, so it is not affected by momentary inconsistencies.
- There are no more state aggregation debounces and command sending debounces; `debouncify` / `debounce` are deleted after the migration.
- The controller neither debounces nor filters the values reported by actuators; signal debouncing is done by the actuators.

Latency compared with today:

| Path | Today | After the refactoring |
| --- | --- | --- |
| HMI `manStopCmd` -> stop pump command issued | Up to 500 ms (waiting for `section_loop`) + 100 ms debounce + IO | Immediate + IO |
| HMI writes `flow_override` of a section or line -> countdown interrupted | Up to 500 ms | Immediate |
| HMI command (e.g. `horn`) -> sent | 100 ms debounce + IO | Immediate + IO |
| Actuator acknowledgement -> command bit cleared | Read period + 100 ms debounce | Read back with the periodic read, processed on read-back |
| Flow change -> flow difference trigger bit | Read-back + two 50 ms debounces, counted in the next period | Processed on read-back, counted at the next tick |

### 6.4 Error isolation

The controller is a safety system, and one defect must not stop the other interlocks:

- Each rule runs on its own; when it throws, the exception is reported through `on_error(error, source)` injected when the scheduler is created, and the following rules continue; `source` is the failing rule, tdata or Binding;
- In the publish phase the detection of each tdata (with its event handlers) is isolated on its own;
- Failures of asynchronous reads and writes in the output phase are reported through `on_error` as well;
- The controller wires `on_error` to the log; the scheduler itself does not log, and exceptions are ignored when it is not injected.

### 6.5 Scheduler interface

```js
const scheduler = new Scheduler({ period: MAIN_PERIOD, on_error });
scheduler.add_data(tdata);                    // detected in the publish phase, snapshot at the end of a scan
scheduler.add_binding(binding, input_group);  // loaded in the input phase, flushed and read in the output phase
scheduler.add_binding(binding);               // output only: flushed in the output phase, never read nor loaded
scheduler.add_var(owner, name);               // a shared variable: a property of an object (7.1)
scheduler.add_rule(rule);                     // built by derive() / act() (7.2)
scheduler.prepare();                          // order the rules and check them (7.4); throws with every error
scheduler.start();                            // periodic ticks: scan(true) every period
scheduler.request_scan();                     // a coalesced triggered scan: scan(false)
scheduler.stop();
```

- `prepare()` is called once before the first scan; nothing is registered afterwards.
- A Binding registered without an input group is write-only, used for the command blocks of actuators: the controller only writes commands to actuators and never reads them back; the acknowledgement of commands is in `response_code` of the node tdata, obtained by the periodic read.
- `scan(tick)` can be called directly, for tests to drive scans; when called during a scan (e.g. in a rule or an event handler), it does not run nested but is queued after the current scan.
- The `on_write` of tdata and the `on_update` of Binding are wired to `request_scan()` by the user (done when step 5 wires into the running flow).

## 7. Rules

### 7.1 Dependency keys

The objects that rules read and write are uniformly expressed as "dependency keys", i.e. `(owner, name)` pairs:

- when the owner is a TData, the name is a tag name, e.g. `(section.data, 'comm_OK')`;
- when the owner is an ordinary object such as a section, line or actuator, the name is a property name of that object, e.g. `(section, 'press_SD_trigger')`. Such variables must be registered with `add_var`; a variable must be a property of some object, and a bare variable cannot be a dependency key;
- when the owner is a Binding, the name is a state name, e.g. `(binding, 'connected')`, read-only.

So TTags, variables (spec 3.6) and Binding states are ordered by the same rules, and variables need not become TTags.

A combined word shares the same data with its component bits but has a different name, and dependencies built by name cannot see the relation between them. Therefore:

- Rules write only component bits, never combined words. The data flow has no need to write both a word and its bits: whole-word writes come only from loading and the upward server, which are inputs of the scan; when several command bits need to be cleared (the acknowledgement handshake, command masking), they are written bit by bit by name;
- A combined word in `reads` is expanded before ordering into reads of all its component bits, after which dependencies are built by name. So a rule writing a bit is ordered before a rule reading the whole word; two rules writing different bits have no dependency between them.

### 7.2 The two kinds of rules

| Kind | Write constraint | Use |
| --- | --- | --- |
| derive | The only writer of its write keys, fully determining their values in every scan | Aggregations, differences, trigger bits, protection state, timing, `action_F`, `stop_pumps` and the like |
| act | Its write keys may have several writers (including the HMI and other acts), and it may write only when a condition holds | Edge actions, interlock set / reset, sending and receiving commands, copying parameters, action records, changing `comm_OK` / `work_OK` by the connection state |

Each rule has a name `name`, used in the startup checks and error reports, e.g. `section S1 comm_OK`. The keys declared by a rule are of three kinds:

| Field | Meaning |
| --- | --- |
| `reads` | Reads the values of this scan and forms dependencies: the writers are ordered before this rule |
| `writes` | The keys written |
| `reads_previous` | Reads the values at the end of the previous scan (`scheduler.previous()`), forming no dependency, used to break cycles (7.4) |

Rules can use two kinds of state:

| State | Use | Values of the previous scan, edge checks |
| --- | --- | --- |
| Dependency keys (tags, Binding states, registered variables) | State shared by several rules, taking part in ordering | Provided by the scheduler (5.3) |
| Closure variables | State belonging to one rule only: latches, counts, the "previous value" it needs itself, and the like | Kept by the rule itself |

Closure variables are not registered and take no part in ordering, and only the rule they belong to may read and write them. Timing does not accumulate in closure variables, but uses the ticker assigned by the scheduler (7.3).

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

// a private state in a closure variable, here the previous value for an edge
let was_high = false;
act({
    name: 'example closure edge',
    reads: [[node.data, 'pressure']],
    writes: [[node.command, 'horn']],
    run: () => {
        const high = node.data.pressure > LIMIT;
        if (high && !was_high) node.command.horn = true;
        was_high = high;
    },
});
```

### 7.3 Timing (Ticker)

When arranging the rules, the scheduler creates a Ticker for each rule and passes it as the argument of `run(ticker)` in scans. The rule decides itself when timing starts and stops, and the scheduler only advances it:

```js
class Ticker {
    count = 0;          // periodic ticks since start
    running = false;
    constructor(running_set) { this.running_set = running_set; }
    get elapsed() { return this.count * MAIN_PERIOD; }
    // no-op while running, so a held condition keeps counting
    start() {
        if (this.running) return;
        this.running = true;
        this.count = 0;
        this.running_set.add(this);
    }
    stop() {
        this.running = false;
        this.count = 0;
        this.running_set.delete(this);
    }
    restart() {
        this.stop();
        this.start();
    }
}
```

- Advancing: in the input phase of a tick scan, the scheduler adds 1 to the `count` of each ticker in `running_tickers` (6.1); scans triggered by requests do not advance them. Only running tickers are in the set, so the cost of advancing is proportional to the number of timings in progress.
- Rules do not receive the `tick` flag and do not accumulate counts themselves, so the number of scans does not affect timing.
- Each rule has only one ticker. Logic that needs two independent timings is split into two rules; e.g. the flow difference warning delay and the flow difference alarm delay of a section belong to two derive rules.

**An on-delay by value** (output after the condition has held for some time, the semantics of the PLC TON) is expressed by a helper function:

```js
// true once cond has held for longer than delay_ms
function on_delay(ticker, cond, delay_ms) {
    if (cond) ticker.start();
    else ticker.stop();
    return ticker.elapsed > delay_ms;
}

derive({
    reads: [[section.data, 'flow_alarm_trigger'], [section.data, 'flow_diff_AH_delay']],
    writes: [[section.data, 'flow_alarm_F']],
    run: (ticker) => {
        const { data } = section;
        data.flow_alarm_F = on_delay(ticker, data.flow_alarm_trigger, data.flow_diff_AH_delay);
    },
});
```

**An off-delay by value** (output immediately while the condition holds, and kept for some time after it disappears, the semantics of the PLC TOF) is its dual:

```js
// true while cond holds, and for delay_ms after it drops
function off_delay(ticker, cond, delay_ms) {
    return !on_delay(ticker, !cond, delay_ms);
}
```

The timing semantics are the same as `on_delay`. When the condition does not hold from the start, the output stays true for `delay_ms` after startup and then becomes false, consistent with the output of a TOF while its input is false.

**Timing started by an edge** (an action performed some time after an event, which the rule may abort on its own in between) is done by an act rule operating the ticker directly. Note that an edge check is true only in the scan where the edge occurs, so the timing check must be outside the edge check:

```js
act({
    reads: [[binding, 'connected']],
    writes: [[command, 'temperature_zero_raw'] /* ... all parameter tags */],
    run: (ticker) => {
        if (scheduler.rose(binding, 'connected')) ticker.restart();
        if (!binding.connected) ticker.stop();             // aborted by the rule itself
        if (ticker.running && ticker.elapsed >= 2000) {
            ticker.stop();
            reset_parameters();
        }
    },
});
```

Timing semantics:

- When the condition disappears or the rule calls `stop()`, it takes effect immediately, without waiting for the next tick. E.g. a manual hang-on during the countdown: the HMI writes `flow_override` of the section or line, triggering a scan, in which `protect_F` and `pre_stop_notice` become false and the countdown rule stops its ticker, so no flow difference action occurs;
- A ticker started between two ticks has `count` 1 at the next tick. Today's delay conditions (such as `flow_alarm_trigger`) are all set by events between two `section_loop`s, and the next `section_loop` adds 500 ms, which is exactly the same: after the condition holds, `on_delay` outputs true at the `floor(delay / MAIN_PERIOD) + 1`-th following tick;
- A ticker started in a tick scan has `count` 0 in that scan and counts from the next tick, one period later than the current code. After the refactoring, data read-backs trigger request scans, not tick scans, so this happens only when a tick scan happens to load new data;
- When the condition appears and disappears between two ticks, the ticker stops and resets, without affecting timing;
- In scans triggered by requests `count` does not change, so rules depending on timing results produce no new edges when run repeatedly;
- Timing values that need to be shown externally (such as `countdown`) are converted from `elapsed` by the rule in every scan, and the value does not change between two ticks.

All "counted by tick" processing of 7.5 uses tickers.

### 7.4 Ordering

At startup (after building the object graph, before the first scan) all rules are topologically sorted once, giving `ordered_rules`:

- Directed edge: rule writing key K -> rule reading key K;
- All writers of the same key are ordered before its readers;
- When a rule reads a key it also writes (read-modify-write, e.g. the rule containing `line_action_source &&= line.autoStopCmd`), that read forms no dependency edge;
- Keys in `reads_previous` form no dependency edges;
- Several writers of the same key, and rules without dependencies between them, are ordered by declaration order, so the result is repeatable;
- The declaration order follows today's processing order: actuators -> sections -> lines, objects of the same kind in configuration order.

Rules are declared after the whole object graph (all tdata, Bindings and variables) is built, because rules of upper levels reference tdata of lower levels, and rules of lower levels also reference tdata of upper levels (e.g. the section's `pre_stop_notice` reads the line's `pump_run`). The rules of each level are given by their own declaration functions (one each for actuators, sections and lines); at run time they are called after the object graph is built, in the order actuators -> sections -> lines, followed by `prepare()`.

At startup the following errors are checked; when found, all errors are reported and the program refuses to start:

- A dependency cycle: the rules and keys on the cycle are reported, with the hint that `reads_previous` can break it;
- A key in `reads_previous` has no value of the previous scan: only tags, the `connected` / `read_ok` of Binding and registered variables have values of the previous scan;
- A key has a derive writer and also other rule writers;
- A rule writes a read-only Binding state;
- A rule writes a combined word;
- A rule declares a tag name or Binding state name that does not exist;
- A rule declares a variable not registered with `add_var`;
- A rule has no name, or two rules have the same name.

Example: in the existing logic `section.pre_stop_notice` reads `line.pump_run`, `line.pump_run` aggregates the `pump_run` of the sections, and `line.pre_stop_notice` in turn aggregates the `pre_stop_notice` of the sections. Ordering by level (section -> line) cannot give a correct order; ordering by key gives:

```
node.pump_run -> section.pump_run -> line.pump_run
  -> section.pre_stop_notice -> line.pre_stop_notice
```

Today, because sections may read the old value of the line, a recomputation through the change event of the line is needed (6.2 of design.md); after ordering, it is computed right once within the same scan.

**Breaking cycles.** The dependencies between rules must be acyclic. When the business really needs a cycle (e.g. two quantities depending on each other), the rule author picks one place on the cycle and reads the value at the end of the previous scan there, i.e. puts this key into `reads_previous` in the declaration and reads it with `scheduler.previous()` in `run`. This is a unit delay in control systems: this quantity is always one scan period behind the others on the cycle, with fixed semantics.

```js
derive({
    name: 'line B',
    reads_previous: [[section.data, 'A']],
    writes: [[line.data, 'B']],
    run: () => { line.data.B = g(scheduler.previous(section.data, 'A')); },
});
```

The scheduler neither picks the breaking point automatically nor evaluates repeatedly within a scan until stable: whether it converges depends on the functions in the rules, not on the structure of the dependency graph, and is generally undecidable; even when it converges, the result may differ with the breaking point or the initial values. Where to break is a business decision, left to the rule author to write explicitly, which makes it easy to review.

### 7.5 Mapping of the existing processing to rules

| Existing processing | Rule kind |
| --- | --- |
| After `connfailed`, `comm_OK = false` after the delay `delay_protect_time`; true on `connect` | derive: `comm_OK = off_delay(ticker, connected, delay_protect_time)`; `comm_OK` is not in the loaded group and is written only by this rule |
| After `io_error`, `work_OK = false` after the delay | act: sets `work_OK = false` when `off_delay(ticker, read_ok, delay_protect_time)` is false; after a successful read, the loading restores the value reported by the actuator (the loading writes `work_OK` too, so it is an act) |
| `reset_parameters` 2 s after `connect` | act, by edge: the rising edge of `connected` starts timing by tick, and after 2 s the parameters of data are copied to command; a disconnection in between stops it |
| Actuator `pump_run` = OR of `pump_run_1..4` | Deleted: the actuator already reports `pump_run` after the OR, and the reported value prevails; like `pump_run_1..4` it is an input of the loading |
| Withdrawing the `stop_pumps` command on the falling edge of the actuator's `pump_run` | act |
| `response_code` acknowledgement handshake (clearing command bits, `executing`, sending again) | act: when `response_code` changes and is not 0, clears the acknowledged command bits bit by bit and resets `executing`; sending is done by the sending rule |
| Clearing the enable / disable command bits and sending on changes of `pressure_SD_F` | act |
| Local processing of `read_paras` | act: on the rising edge, copies the parameters and resets the bit |
| Local processing of `write_paras` | act: on the rising edge, copies the parameters and registers the write; reads `write_done(data_parameters)` and resets the bit after the write completes |
| Change of `commands`: `has_commands` | derive |
| Change of `commands`: sending the commands | act: when `commands` changes, or when `response_code` changes and is not 0 (so the actuator sees the acknowledged bits cleared), registers `request_write(commands_payload)`, replacing the 100 ms debounce |
| Resending after 3 periods without acknowledgement | act, timed by tick per actuator: after `has_commands` has held for more than 3 ticks, resends once per tick |
| Command masking (today a common `& 0xB1` for all actuators) | act: by the `command_mask` configured per actuator (12.1 of design.md), resets the unsupported command bits bit by bit in every scan. It is declared after all other rules, and several writers of the same command bit are ordered by declaration order, so it comes after the other rules writing command bits; since it writes command bits, it comes before the sending rule that reads `commands`, so unsupported commands are never sent |
| The section's `comm_OK`, `work_OK`, `press_warning_F`, `press_alarm_F`, `pump_run`, `pump_change_F`, `flow_begin`, `flow_end`, `flow_diff` | derive |
| The section's `flow_warning_trigger` / `flow_alarm_trigger`, the variable `press_SD_trigger`, `pre_stop_notice` | derive |
| The section's `protect_F` / `hangon_AF` | derive: reads the `flow_override` of the section and of its line; the line's is a master switch and does not overwrite the section's |
| The section's delay counts with `flow_warning_F` / `flow_alarm_F`, the countdown `countdown` | derive, counted by tick |
| The pressure action, the flow difference action and the `autoStopCmd` they set, the line's `autoStopCmd`, `line_action_source`, the line's `action_section_ID`, creating action records | act |
| The section's `action_F`, `stop_pumps` | derive |
| Issuing `stop_pumps` / `cancel_stop` to the actuators with pumps on changes of the section's `stop_pumps` | act |
| Clearing `autoStopCmd` / `manStopCmd` on the falling edge of the `pump_run` of a section or line | act |
| The line's `pump_run`, `alarm_F`, `pre_stop_notice` | derive |
| Loading the corresponding record on changes of the action record `index` (clearing the time when -1, restoring the old value when out of range) | act |
| Logging of the various state changes | Event handlers (section 8) |

The current processing order of `section_loop` is itself scan-like; after it is split into the rules of the table above, the order between the rules is decided by the ordering, and the evaluation conditions inside the rules stay the same.

The intermediate values passed between rules after the split that do not belong to a tdata are registered as variables of the section (7.1):

| Variable | Writer | Readers |
| --- | --- | --- |
| `press_SD_trigger` | The derive rule of the pressure interlock trigger | The pressure action |
| `countdown_expired` | The derive rule of the countdown: `pre_stop_notice` holds and the timing exceeds `action_time` | The flow difference action |
| `press_action` / `flow_action` | The pressure action / the flow difference action | The derive rule of `action_F`, the action record |

The parameters of an actuator are copied in both directions: `write_paras` copies the parameters of the command block into the node tdata and then writes them to the actuator; the parameter refresh after connecting and `read_paras` copy the parameters of the node tdata into the command block; `comm_OK` / `work_OK` also read `delay_protect_time` of the node tdata. This forms a cycle, broken by `reads_previous` on the side that reads the node parameters (7.4): the node parameters come from the actuator, and reading the value at the end of the previous scan is only one scan late; `write_paras` must read the command parameters of this scan, because the HMI often writes the parameters and then `write_paras` in the same request.

Two points differ from the current state and need confirming during the migration:

- After delays are counted by tick, the actual delay of `delay_protect_time` has a step of `MAIN_PERIOD`, at most one period later than today's `setTimeout`.
- Today the delay timer of `io_error` is never cancelled: even if reads recover within the delay, `work_OK = false` is set once when it expires and then overwritten by the next read; with counting, the count resets as soon as reads recover, and this brief false no longer occurs.

### 7.6 Checking the dependency declarations

Dependencies rely on explicit declarations, and a missing read key leads to a wrong order without an error. So a check in test mode is provided:

- The data layer provides a general access tracing hook `set_access_tracer(tracer | null)`: once set, the getter / setter of the prototype accessors call `tracer(tdata, name, "read" | "write")` on every access; the data layer only knows the hook, not the existence of rules;
- The test mode of the scheduler sets the hook and records the accesses into the actual read and write sets of the "current rule"; after a test case runs some scans, the actual reads and writes are compared with the declarations: a tag actually accessed but not declared is an error; reads of combined words are compared by their expanded component bits (7.1), and a write of a combined word is an error in itself. `scheduler.previous()` takes values from the snapshot and does not go through the accessors, so a tag declared only in `reads_previous` that is read directly is reported as an error too (it reads the value of this scan);
- The hook can trace only tags; Binding states and variables do not go through accessors and are outside the check;
- In the immediate detection mode, writes of a rule emit events during the execution of the rule, and accesses in event handlers are recorded under that rule. By the convention of section 8, the final event handlers only log and take the values they need from the event arguments, causing no extra accesses; handlers not yet rewritten during the migration are covered in 10.2.

At run time the hook is not set, and the accessors only add one check. "Run once and infer the dependencies automatically" was not adopted, because the short-circuiting of `&&`, `||` and conditional branches mean one run cannot see all reads.

## 8. Coding conventions for event handlers in the controller

This is a convention of the controller code, not a restriction of TData / TTag: TData / TTag prevent no writes.

- Derived logic such as interlocks and aggregations is written as rules, not in event handlers, so that a scan is based on one set of inputs and the result does not depend on the order of events;
- Event handlers are mainly for logging; writing tags in handlers is allowed, and such a write requests a scan and is read by the rules in the next scan;
- Logic that needs asynchronous operations is written as act rules: the rule registers the request, Binding records the completion state and requests a scan, and the follow-up processing is done by the rule reading the completion state (4.4).

## 9. Spec entries to be changed accordingly

| Location | Now | Change to |
| --- | --- | --- |
| 3.4 Division of evaluation and protection | None | Add a row: input signals are debounced by the actuators; the controller neither debounces nor filters the values reported by actuators and processes the values as received |
| 3.6 Access by name, change events | The program reads and writes TTag values by name; whether from actuator reads, HMI writes or program assignments, change events are emitted after the new value takes effect; business logic implements its interplay by subscribing to events | Reads, writes and events stay unchanged, pointing to spec-data-api.md: reading and writing by name at any time, events emitted when values change, not restricted by the scheduling of the controller. Delete "business logic implements its interplay by subscribing to events" and change it to: the aggregations and interlocks of the controller are evaluated in each processing on one set of inputs, and the results do not depend on the order in which events arrive |
| 3.6 Combined word linkage | Linked with its bits in both directions | Unchanged (a combined word and its bits share the same data, so the linkage holds naturally) |
| 5.5 Upward interface | A write from the HMI triggers the processing of the resulting state changes immediately | Unchanged |
| 6 Performance and timing | State aggregation is debounced by 50 ms, command sending by 100 ms | Delete this entry; change to: after actuator data is read back, an HMI write, or a communication state change, processing happens immediately, and the resulting commands are sent immediately, without debounces; delays, countdowns and the communication failure delay accumulate by the main loop period |

## 10. Transitional forms

The migration proceeds in several steps, and at the end of each step all tests pass and the external behavior is unchanged or has only the timing changes listed in section 9. To this end the controller uses the following transitional forms during the migration, which end when the migration is complete.

### 10.1 Migration under the immediate detection mode

The controller always uses the immediate detection mode (3.3). Until all derived logic has become rules, the existing event handlers depend on "receiving the event right after the assignment", which the immediate mode satisfies exactly:

- After assignments by name and writes of Unit_Map through the raw write methods, detection runs immediately; after loading by Binding, detection runs in the publish phase of the scan;
- The `on_write` of tdata is wired to `request_scan()`, so writes in immediate mode (including HMI writes) also request a scan after detection, and once derived values have become rules, the rules recompute accordingly;
- When a handler assigns again in an event, the nested detection only registers, and after the current round has been reported another round of comparison follows, until there are no new changes; when there are still new changes after 16 consecutive rounds, an exception is thrown to prevent oscillation;
- Edge checks in rules use the scan snapshot (5.3).

The order of events in the immediate detection mode differs from today in two places, and the first step of the migration must confirm that no handler depends on them:

- Today the side that is written emits its event first, and the other side follows through `check_coupling`; this changes to emitting in layout order, the combined word first and its component bits after;
- Today when a handler writes a tag again, the nested events are emitted immediately; this changes to emitting after the current round of changes has been reported.

After the migration the controller still uses the immediate detection mode and does not switch to the deferred mode.

### 10.2 Rules and event handlers side by side

The scan scheduler and the rule ordering go live before the business migration. During the migration:

- Derived values already rewritten are computed by rules, and the corresponding event subscriptions and `debouncify` wrappers are deleted at the same time;
- Those not yet rewritten are still computed by event handlers, which keep working under the immediate detection mode;
- Driver event callbacks and `setTimeout` delays stay as they are until the corresponding rules (the first three rows of 7.5) go live;
- `section_loop` / `node_loop` first run as coarse act rules in the existing order (declaring no keys, so they take no part in the ordering checks, and by declaration order sections come before actuators), and are deleted after the split is complete;
- After the derived part of `section_loop` has been split into rules, the remaining action part and the split rules have ordering requirements between them: it reads the flow difference alarm flags and `countdown_expired`, while `action_F` and `stop_pumps` read the action flags and `autoStopCmd` it writes. From then on, the remaining coarse rules all declare the keys they read and write and take part in ordering and checks;
- When event handlers not yet rewritten are caused by writes of rules (e.g. issuing commands to actuators on changes of `stop_pumps`), their accesses are recorded under that rule (7.6). The dependency check lists these accesses as known exceptions, deleted as the handlers become rules;
- Coarse rules run only in the scans of periodic ticks: the old main loop timed by `MAIN_PERIOD` on every call, and running in triggered scans would make the timing faster. The rules detect new ticks with their own tickers (running only when the count changes); for this an initial scan runs first at startup, starting these tickers, so they run from the first periodic tick on, at the same moments as the old `setInterval`.

## 11. Out of scope

- Layouts, point tables and protocols are all unchanged.
- The connection establishment and reconnection of drivers (the tick of `Base_Driver`, `reconnect_time`, `connfailed_time`, the automatic reconnection of each driver library) are unchanged; only the connection events no longer change tags directly but are recorded as Binding states (4.4).
- The unimplemented items listed in section 11 of design.md are not handled this time (except the command masking by actuator configuration, see 7.5), but the new structure must leave room for them: `tlms check` can call the rule ordering checks directly.
