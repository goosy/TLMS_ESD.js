# Data Object Interface Specification (TData / TTag)

> English version of [spec-data-api.zh-cn.md](spec-data-api.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document specifies the programming interface that TData and TTag promise to their users, and refines section 3.6 of [spec.md](spec.md). The implementation is in [design-scan.md](design-scan.md).
> TData and TTag are general data objects for programmers: values can be read and written at any time, and events are emitted when values change. They do not depend on the scheduling of the controller; the scan-based data flow of the controller is only one way of using them and does not restrict their capabilities.

## 1. Concepts

| Name | Meaning |
| --- | --- |
| Layout | The fixed format of a block of data: the name, type, bit offset and initial value of each tag, given by the layout description (section 6), immutable once compiled |
| TData / tdata | TData is the class of data objects, and a tdata is an instance of it: a block of data allocated by some layout, stored big-endian inside, offering reading and writing by name and change events |
| TTag | The operating interface of a named entry of a tdata: its value can be read and written, and its changes subscribed to |

The T in TData and TTag means Typed: a tdata is stored in a fixed layout, and each tag has a definite type and position.

Tag types: `Bool`, `Byte`, `SInt`, `USInt`, `Int`, `UInt`, `Word`, `DInt`, `UDInt`, `DWord`, `Real`. The value of a `Bool` is `true` / `false`, the others are numbers. A `Word` made of several `Bool`s is called a combined word; it shares the same data with its component bits.

## 2. TData

### 2.1 Creation

```js
const data = new TData(layout, name, options);
```

- `layout`: a layout compiled by `compile_layout` (section 6);
- `name`: the name of the tdata, used in logs and error messages;
- `options` (optional):
  - `detection`: the detection mode, `"immediate"` (default) or `"deferred"`, see 4.2;
  - `on_write(data)`: called after every write, to notify the user that a write happened; in immediate mode it is called after the detection of this write has completed, in deferred mode it is used to schedule the detection (4.2).
- After creation the value of each tag equals its initial value in the layout, and no change event is emitted at this point.

### 2.2 Properties

| Property | Access | Description |
| --- | --- | --- |
| `name` | Writable | The name of the tdata |
| `layout` | Read-only | The layout used |
| `size` | Read-only | The number of bytes of the tdata |
| `buffer` | Read-only | The internal buffer (big-endian). The property is read-only and cannot be replaced by another buffer; the content of the buffer can be read and written, and after its content is changed directly, `detect()` must be called, otherwise the changes are not detected |

Assigning to a read-only property throws a `TypeError`.

### 2.3 Reading and writing by name

```js
data.pressure = 1.5;          // write
const value = data.pressure;  // read
```

- Each tag name is a property of the tdata, readable and writable, at any time;
- A write takes effect immediately: after the write, reading returns the new value, and so does the `value` of the TTag;
- Writing a combined word changes its component bits; writing a component bit changes the combined word;
- Writing an integer outside the range of the type throws a `RangeError`, and the old value stays; writing a `Bool` takes the truthiness of the value.

### 2.4 Getting a TTag

```js
const tag = data.get("pressure");
```

Returns the TTag of the tag; the same tdata always returns the same TTag for the same name. Returns `undefined` when the name does not exist.

### 2.5 Raw writes

For writers that do not access by tag name (such as the upward server), located by byte offset; the processing after the write is the same as for writes by name:

| Method | Description |
| --- | --- |
| `write_register(offset, value)` | Writes a 16-bit register (big-endian); `offset` is a byte offset |
| `write_bit(offset, mask, value)` | Writes the bits given by `mask` in a byte |
| `write_bytes(offset, source)` | Writes a run of bytes from `offset` |

### 2.6 Detection

`detect()`: runs a detection (4.1) and reports all changes since the previous detection. In immediate mode, detection runs automatically after writes, so it is usually needed only after the content of `buffer` has been changed directly; in deferred mode the user calls it at the appropriate time.

### 2.7 Events

```js
data.on("change", (name, old_value, new_value) => { /* ... */ });
```

Emitted when the value of any tag of the tdata changes, with the tag name, the old value and the new value.

## 3. TTag

| Member | Description |
| --- | --- |
| `name` | Tag name |
| `type` | Type (lower case) |
| `length` | Number of bytes occupied |
| `value` | Current value, readable and writable; writing is exactly equivalent to `data[name] = v` |
| `on("change", (old_value, new_value) => ...)` | Subscribes to the changes of the tag |

A TTag holds no value; reads and writes act directly on its tdata.

## 4. Changes and events

### 4.1 Detection

**Detection** compares the current value of each tag of the tdata with its value at the previous detection, and emits a `change` event for each tag whose value differs; after the detection, the current values become the baseline of the next detection. The initial values at the creation of the tdata are the baseline of the first detection.

How many times a tag is written between two detections does not matter to detection: it compares only the values at the two moments, so several writes merge into one event, whose old value is the value at the previous detection; a value that changed and was then restored emits no event.

### 4.2 Detection modes

The detection mode decides when detection runs, chosen by `detection` when the tdata is created. The detection mode affects only when `change` events are emitted, not the values: in both modes writes take effect immediately, and reading a property of the tdata or the `value` of a TTag at any time returns the current value (2.3). In both modes the read and write capabilities of tdata and TTag, and the content and conventions of events (4.3), are exactly the same.

| Mode | After a write | When events are emitted | `on_write` | Suited for |
| --- | --- | --- | --- | --- |
| Immediate (`"immediate"`, default) | Detects immediately | When the write statement returns, the events it caused have been emitted | Called after detection | Ordinary programs, device emulation |
| Deferred (`"deferred"`) | Does not detect | When the user calls `detect()`, all events since the previous detection are emitted together | Called, to schedule the detection | Users that need to process a batch of inputs as a whole |

- Neither mode loses changes: in deferred mode, as long as the user eventually calls `detect()`, all changes since the previous detection are reported.
- In immediate mode every write detects once, so several writes emit separate events; in deferred mode they merge as in 4.1.

### 4.3 Common conventions

- Wherever a change comes from (a write by name, a TTag write, a raw write, `detect()` after a direct change of `buffer`), an event is emitted and nothing is missed;
- Events are emitted after the new value takes effect: a handler reads the new value;
- An event is emitted only when the value really changes: writing the same value emits nothing; writing `NaN` over `NaN` counts as unchanged;
- Combined words and component bits emit their own events: when one write changes a combined word and some of its bits, both the word and those bits emit;
- Multiple changes of one detection are emitted in layout order (a combined word before its component bits); for each change, the `change` of the tdata is emitted first, then the `change` of the TTag;
- A handler may write any tag: in immediate mode, the changes caused by that write are emitted after the current batch of changes has been emitted; in deferred mode, the write calls `on_write`, and the changes are emitted at the next `detect()`;
- If writes in handlers keep triggering each other and there are still new changes after 16 consecutive rounds, the detection throws, to prevent endless oscillation; changes not yet emitted are not lost and are emitted at the next detection.

## 5. Errors

On errors the interface throws, without logging or exiting the process; the caller decides how to handle them:

| Case | Exception |
| --- | --- |
| Writing an integer outside the range of the type | `RangeError`, the old value stays |
| Invalid layout, a tag name conflicting with a member of TData | `Error` thrown when the tdata is created |
| Writes in handlers that trigger each other and do not settle | `Error` thrown by the detection |

## 6. Layout description

### 6.1 File

A layout description is a YAML 1.2 file and can define several layouts at once:

- Root key `layouts`: a mapping whose keys are layout names (such as `NODE`) and whose values are the item lists of those layouts;
- All other root keys are fragments: the key is the fragment name, the value an item list, referenced by name from items.

```yaml
node_commands:              # a fragment
  - { name: stop_pumps, type: Bool, offset: 8, init_value: false, comment: Stop pump command }
  - { name: cancel_stop, type: Bool, offset: 9, comment: Cancel stop pump }

layouts:
  NODE:
    - { name: ID, type: UInt, offset: 0, init_value: 0 }
    - name: response_code
      type: Word
      offset: 128
      coupling: node_commands
    - { includes: node_parameters, offset: 144 }
```

For now one file is compiled at a time. When several files (a directory) are supported later, the way to merge them and the handling of key conflicts will be specified.

### 6.2 Items

| Field | Description |
| --- | --- |
| `name` | Tag name, unique within a layout, must not equal a member of TData |
| `type` | One of the types of section 1, case-insensitive |
| `offset` | Bit offset; a non-Bool must be on a whole byte, and a multi-byte type must start at an even byte |
| `length` | Bit length, may be omitted and is then given by the type; when written it must match the type |
| `init_value` | Initial value, must be representable by the type; for combined words and component bits see below |
| `comment` | Optional description text, used for generating point tables, type declarations and the like |
| `coupling` | The component bits of a combined word: a fragment name or an inline item list, the `offset` of each bit relative to the word |
| `is_combined` | Optional, marks a combined word whose whole word and bits are linked in both directions |
| `includes` | Together with `offset` (and optionally `name_prefix`), splices in the items given by a fragment name or an inline list, shifted as a whole |

Items in fragments may also reference other fragments.

### 6.3 Validity

- The byte ranges of non-Bool tags do not overlap; each bit belongs to at most one Bool;
- A Bool inside the byte range of a non-Bool tag must be a component bit of that tag (a combined word); each component bit of a combined word must lie within the range of the word;
- Only one side of a combined word and its component bits may give initial values: when the combined word gives one, the initial values of the component bits follow from the whole word; when it does not, the component bits give them (bits not given are `false`), and the initial value of the whole word is composed from them;
- The total length of a layout is a whole number of registers (a multiple of 16 bits);
- Referenced fragments must exist, and fragments must not reference each other cyclically.

### 6.4 Compilation

```js
const { layouts, fragments } = compile_layout(yaml_path);
const node = new TData(layouts.NODE, "node_1");
```

- `layouts`: the compiled layouts indexed by layout name, used to create TData;
- `fragments`: the item lists indexed by fragment name (references expanded, offsets relative to the start of the fragment), for users to query, e.g. to get all tag names of the parameter block;
- When the file has any violation, an `Error` is thrown whose `errors` property lists all violations.

## 7. Outside this interface

- Exchanging data with devices (byte order conversion, group reads and writes, driver binding) is the job of the IO binding, which operates tdata through this interface and `buffer`;
- The scheduling, rules and timing of the controller are not part of this interface.
