# Data Layer and Scan Cycle Refactoring: Migration Plan

> English version of [plan-scan.zh-cn.md](plan-scan.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> The target design is in [design-scan.md](design-scan.md); this document only arranges the steps and the ways of verification and does not repeat the design. Code is implemented according to the spec and design series.

## 1. Principles

- **Every step is deliverable on its own**: at its end `pnpm test` and the Biome check all pass, and it can be committed and reverted on its own.
- **Behavior changes come late**: steps 1-5 do not change external behavior (they only replace internal mechanisms); timing changes appear only in steps 6-8, and each step introduces only the changes listed in section 9 and at the end of 7.5 of design-scan.md.
- **Tests first, then the implementation**: each step first adds tests that constrain the behavior of the step and pass on the old implementation, then replaces the implementation.
- **The spec changes with the behavior**: the step that changes a behavior described by the spec also changes the corresponding entry of `doc/spec.md`.
- **design.md is merged last**: during the migration design.md keeps describing the code of the time; step 8 merges design-scan.md into design.md and then deletes design-scan.md and this document.
- **Working branch**: a branch `refactor/scan` is created from `dev`, with one or several commits per step, merged back into `dev` when everything is done.
- **Prerequisite**: the upgrade of es-modbus to v0.3 (see the prerequisite step in section 2) is completed on `dev` first, and `refactor/scan` is created from `dev` after the upgrade.

## 2. Overview of the steps

**Prerequisite step (done on `dev`, not part of this refactoring)**: upgrade es-modbus from v0.1.4 to v0.3 and align with its breaking changes (vector renamed to `snake_case`, `write()` resolving with whether the request was echoed, errors becoming `Error`, the client's own exponential backoff reconnection and dead connection detection, support of 6-digit and structured PDU addresses). Binding builds directly on the read and write results and the connection events of the drivers (4.3 and 4.4 of design-scan.md), and the write entry of the upward server also changes in step 3, so the upgrade comes first, to avoid adapting to and testing the driver interface twice. The upgrade must make clear which layer is responsible for reconnection (the `reconnect_time` of `Base_Driver` or the reconnection of es-modbus itself), because it decides the meaning of the `connected` state.

| Step | Content | Design | External behavior |
| --- | --- | --- | --- |
| 0 | Test baseline and open questions | - | Unchanged |
| 1 | Layout, codec table, prototype accessors | Section 2 | Unchanged |
| 2 | Observer and the two detection modes, TTag readable and writable, value cache and coupling linkage removed | Sections 3, 5, 10.1 | Unchanged (event order see open question 0.2) |
| 3 | Binding split out, raw write methods of TData | Sections 3, 4 | Unchanged |
| 4 | Scheduler, rules, ordering, Ticker (not wired in) | Sections 6, 7 | Unchanged |
| 5 | Wiring in the scan skeleton | 6.1, 6.2, 10.2 | Unchanged |
| 6 | Derived values become derive rules | 7.5 | State aggregation debounce removed |
| 7 | Actions, commands and connection states become act rules | 7.5 | Command sending debounce removed; the two points at the end of 7.5 |
| 8 | Cleanup, merging the documents | Section 8 | Unchanged |

## 3. The steps

### Step 0: test baseline and open questions

Changes:

1. **Extract the test fixture**: move `build_line()` and `settle()` of `test/section_proc_test.js` to `test/harness.js`, extended to build the complete object graph "line + sections + actuators (data, command, fake driver)", simulating actuators with `create_fake_driver`.
   - Tests are written only as "set inputs -> `settle()` -> assert outputs", without depending on the moments events fire;
   - `settle()` is implemented for now as waiting longer than the debounce chain; from step 5 on it drives scheduler scans instead, and the test cases themselves do not change.
2. **Add behavior tests** covering each row of existing processing in the table of 7.5 of design-scan.md, including at least:
   - Actuators: `pump_run` aggregation, `response_code` handshake, `pressure_SD_F` clearing command bits, `read_paras` / `write_paras`, sending `commands` and resending after 3 cycles, command masking;
   - Sections and lines: the aggregated values, the flow difference delays, the countdown and its interruption by a manual hang-on, setting and resetting the pressure / flow difference actions, issuing `stop_pumps` / `cancel_stop`, the line `flow_override` master switch, clearing `autoStopCmd` / `manStopCmd`, action records;
   - Upward server: after the vector writes registers and coils through `Unit_Map`, the corresponding tag events are emitted and the linked processing runs.
3. **Open questions** (results recorded in section 5 of this document):
   - 0.1 whether es-modbus, when handling function codes 15 / 16, calls the vector in turn within one synchronous call (deciding whether the merging conclusion of 3.2 of design-scan.md holds);
   - 0.2 whether any existing handler depends on "the order of the events of a combined word and its component bits" (10.1 of design-scan.md);
   - 0.3 whether any existing handler depends on "several changes of the same tag in one processing emitting separate events" (no longer true after step 8 merges events).
4. **Benchmark script**: add the benchmark script of snapshot comparison to `bench/` (not run by `pnpm test`), as the performance reference for step 2.

Done when: the new tests all pass on the existing implementation; the three open questions have conclusions.

### Step 1: YAML layouts, Layout, codec table, prototype accessors

Changes:

- Layout descriptions become YAML (2.1 of design-scan.md): convert the structure definitions of `src/structs/*.js` into `src/layouts.yaml` (keeping each comment as `comment`), compiled and exported by `src/layouts.js`; delete the `src/structs/` directory, and move `build_structure` and `validate_structure` into the data layer. The items expanded before and after the conversion are identical one by one (compared once at conversion).
- Build: rolldown copies `layouts.yaml` next to `main.js`; `.gitignore` ignores the copy.
- Add `src/typed_data/codecs.js` (`CODECS`) and `src/typed_data/layout.js`: `compile_layout(yaml_path)`, `layout_of(data_struct)`, `tags_at_byte`, generation of `Data_Class`. The same structure is compiled only once (cached by the structure object).
- By the component boundary (1.1 of design-scan.md): `build_structure` / `validate_structure` move to `src/typed_data/structure.js`; new code throws on errors and does not use the project logger.
- The `TData` constructor becomes based on Layout: the existing call `new TData(NODE, name)` is kept (taking the cached Layout inside), and the accessors come from the prototype.
- This step keeps the value cache of TTag and `check_change` / `check_coupling`; the setter still does "write buffer -> check change -> link", and the event behavior is completely unchanged; the per-type switch of TTag becomes a lookup in `CODECS`.
- The reserved name table of `validate_structure` follows the members of TData.
- Type declarations: generate `src/layout_types.d.ts` (D1 of section 4), add the `pnpm gen:types` script and a consistency test.

Verification: the existing `ttag_test`, `tdata_test`, `tgroup_test`, `layout_test` and the behavior tests of step 0 all pass; new Layout unit tests (YAML fragment references, inline lists, omitted `length`, a reference to a missing fragment, `tags_at_byte`, a combined word sharing bytes with its component bits, codec round trips); after `pnpm build`, run the bundle with the example configuration.

### Step 2: Observer and detection modes

Changes:

- Add `src/typed_data/observer.js`: snapshot comparison, `previous()`, `scan_snapshot` (section 5 of design-scan.md).
- TData supports two detection modes (4.2 of spec-data-api.md, implementation in 3.3 of design-scan.md): immediate (default) and deferred (`detect()`); `on_write` is called after writes in both modes, after detection in immediate mode; the controller uses immediate mode (3.3 of design-scan.md).
- TTag no longer holds a value: `value` is readable and writable, and writing is equivalent to `data[name] = v`; `change` events are emitted by Observer (spec-data-api.md).
- Delete the value cache of TTag, `check_change` and `check_coupling`; `build_structure` still keeps the coupling names, for the layout validation to identify component bits.
- Component boundary: TData, TTag and Observer no longer use the project logger and `process.exit`, and throw on errors; the existing `assert_exits` style tests change to asserting exceptions accordingly.
- `TGroup.read()` becomes "raw load tag by tag -> one detection"; `check_all_tags()` is renamed `detect()` and runs one detection; `layout` becomes a read-only property.

Verification: all tests pass; new Observer unit tests (changing only a component bit, changing only a combined word, changing and restoring, NaN, nested assignment, the iteration limit) and tests of both detection modes, plus a test for each promise of spec-data-api.md; run `bench/` and compare with step 1.

### Step 3: Binding split out, raw write methods of TData

Changes:

- Add `src/drivers/binding.js` (placed with the drivers, not part of the data layer, 1.1 of design-scan.md): binding parameter checks (throwing errors instead of exiting), `io_index`, the ownership masks and write ranges of groups, `request_read` / `load` / `request_write` / `flush_writes`, connection and completion states (4.4; in this step only recorded, not used).
- `create_group(...names)` replaces `create_tag_group`; `TGroup` is deleted.
- There is no scheduler yet in this step: after a read completes, `load` and comparison follow immediately, and write requests `flush_writes` immediately, keeping the existing timing.
- TData gains `write_register` / `write_bit` / `write_bytes`; the vector of `Unit_Map` uses them. After a write, processing follows the detection mode (in immediate mode, detection right after the write).
- `node_proc.js` uses Binding; `TData.set_IO` is deleted.
- In the startup flow, errors thrown by Binding are logged and the program exits, keeping the behavior "configuration errors refuse to start".
- Add a check test for "never write buffer directly" (3.2).
- Component boundary: `create_vector` and `Unit_Map` move from `drivers/modbusTCP.js` into `src/typed_data/`, with the logger injected through a constructor argument; `createMTServer` stays in the drivers and uses them. Without `set_IO`, TData no longer depends on TGroup / Binding.

Verification:

- Equivalence test: keep a copy of the existing byte order conversion of `read_from` / `write_to` in the test file as a reference, and for the 4 byte orders, the two write units of Modbus and S7, and random buffer contents, compare the old and new load / export results byte by byte;
- The write range cases of the existing `tgroup_test` all pass after migrating to Binding;
- The behavior tests of step 0 all pass.

### Step 4: scheduler, rules, ordering, Ticker

Changes (new modules only, not wired into the running flow):

- `src/scan.js`: the scheduler (the interface of 6.5 of design-scan.md; merging of `request_scan` and handling of requests during the phases of a scan, the four phases of `scan(tick)`, `running_tickers`, error isolation, saving the values of tdata, Binding states and registered variables at the end of a scan, and `previous` / `rose` / `fell` / `changed`).
- `src/rules.js`: the `derive` / `act` declarations (including `reads_previous` to break cycles), dependency keys, topological sorting, startup checks (all of 7.4 of design-scan.md), `Ticker`, `on_delay` / `off_delay`.
- The access tracing hook `set_access_tracer` of the data layer, and the dependency tracing test mode of the scheduler (7.6 of design-scan.md).

Verification: unit tests cover the ordering (including read-modify-write, several writers of the same key in declaration order, the cross-level dependency example, breaking a cycle with `reads_previous`), all startup checks, the timing semantics of Ticker and `on_delay` / `off_delay` (7.3 of design-scan.md item by item), the merging of `request_scan` and the handling of requests during each phase, error isolation, edge checks (tdata, Binding states, registered variables), and the dependency tracing test mode.

### Step 5: wiring in the scan skeleton

Changes:

- `run_controller` creates the scheduler, and `setInterval` becomes the periodic tick calling `scan(true)`.
- Reading actuator data becomes: `request_read()` in the output phase of a tick scan, setting `fresh` and requesting a scan when completed, loading in the input phase.
- The `on_write` of line, section and actuator tdata is wired to `request_scan()`: writes in immediate mode (including HMI writes through `Unit_Map`) also request a scan after detection (10.1 of design-scan.md).
- `section_loop` / `node_loop` are wrapped as coarse act rules, run in the existing order (sections first, then actuators), excluded from the ordering checks, and run only in the scans of periodic ticks; at startup an initial scan runs first (10.2 of design-scan.md).
- The controller still uses the immediate detection mode, and the existing event handlers and debounces work as before.
- The test fixture does not change: it advances the periodic tick with fake timers and lets `setImmediate` run between steps, so the triggered scans complete along the way.

Behavior: between a data read returning and its loading there is just one more `setImmediate`; everything else is unchanged.

Verification: all tests pass; start with `pnpm dev` using the example configuration and confirm that startup, logging, and reading and writing through the upward server are normal (with actuators offline, `comm_OK` becomes false after the delay).

### Step 6: derived values become derive rules

One commit with two parts:

- Aggregations: delete the OR of the actuator's `pump_run` (the value reported by the actuator prevails, see 7.5 of design-scan.md); the section's `comm_OK`, `work_OK`, `press_warning_F`, `press_alarm_F`, `pump_run`, `pump_change_F`, `flow_begin`, `flow_end`, `flow_diff`, trigger bits, `press_SD_trigger`, `pre_stop_notice`; the line's `pump_run`, `alarm_F`, `pre_stop_notice`.
- The derived part of `section_loop`: `protect_F` / `hangon_AF`, the flow difference warning / alarm delays (one rule each, with `on_delay`), the countdown `countdown`, `action_F`, `stop_pumps`. The coarse rule of `section_loop` keeps only the action part.

For each migrated item, the corresponding event subscriptions, `update_*` functions and `debouncify` wrappers are deleted at the same time. The rules of sections and lines are declared after the object graph is built (7.4 of design-scan.md), and the new variables are in 7.5 of design-scan.md; the remaining coarse rules declare the keys they read and write (10.2 of design-scan.md).

Delete `test/section_proc_test.js`: it calls the `update_*` deleted in this step and the changed `section_loop` directly; its scenarios are covered by the system tests, with the one exception "not erasing `action_section_ID` across sections", which becomes a rule-level unit test in step 7.

Spec: change section 6 of `doc/spec.md`: delete "state aggregation is debounced by 50 ms", and write "processing right after actuator data is read back and after HMI writes" and "delays and countdowns accumulate by the main loop period".

Verification: all tests pass; run the behavior tests with the dependency tracing test mode on, confirming that the declarations match the actual reads and writes (accesses of event handlers not yet rewritten are listed as known exceptions, see 10.2 of design-scan.md); add the test "a manual hang-on during the countdown interrupts it in the scan right after the HMI write".

### Step 7: actions, commands and connection states become act rules

One commit with three parts:

- Actions of sections and lines: the pressure action, the flow difference action, `autoStopCmd`, `line_action_source`, `action_section_ID`, action records; clearing commands on the falling edge of `pump_run`; issuing `stop_pumps` / `cancel_stop`. The interlock actions run in every scan. Delete the coarse rule of `section_loop`.
- Actuator commands: the acknowledgement handshake, `pressure_SD_F` clearing command bits, `read_paras` / `write_paras` (with the `write_done` state), command sending becoming a registered `request_write(commands_payload)`, resending after 3 cycles (with a Ticker, timed per actuator), command masking by actuator configuration (`supported_commands`, 12.1 of design.md, replacing the common `& 0xB1`). The command Binding is registered with the scheduler as write-only (6.5 of design-scan.md). Delete `debounce_send_commands` and the coarse rule of `node_loop`.
- Connection states: driver events only update Binding states; `comm_OK`, `work_OK` and refreshing the parameters 2 s after connecting become act rules; delete the corresponding driver event callbacks and `setTimeout`. The drivers of the test fixture change to start disconnected and connect after startup, like the real drivers.

Rules write only component bits, never combined words (7.1 of design-scan.md): the handshake and the masking clear command bits by name, bit by bit.

Spec: change section 6 of `doc/spec.md`: delete "command sending is debounced by 100 ms", and write "the resulting commands are sent immediately" and "the communication failure delay accumulates by the main loop period".

Verification: all tests pass; new tests cover the two differences at the end of 7.5 (`delay_protect_time` in period steps; a read recovering within the delay no longer causes a brief `work_OK = false`); add the test "after the HMI writes a command, the command is written out in the output phase of the same scan".

### Step 8: cleanup, merging the documents

Changes:

- Review all remaining event handlers: by the coding conventions of section 8 of design-scan.md, all derived logic has been written as rules.
- Delete `debouncify` / `debounce` and the remains of the old TTag interface.
- The controller still uses the immediate detection mode (3.3 of design-scan.md) and does not switch.

Spec: change 3.4 of `doc/spec.md` (adding "input signals are debounced by the actuators") and "Change events" of 3.6 (section 9 of design-scan.md).

Documents: merge design-scan.md into design.md (rewriting sections 3, 5, 6, 7, updating the related descriptions in sections 1, 2, 9), and delete design-scan.md and this document.

Verification: all tests pass; smoke run with `pnpm dev`; run `bench/` and record the final results.

## 4. Decisions

| No. | Question | Decision | Step |
| --- | --- | --- | --- |
| D1 | Whether the type declarations generated from the layouts go into version control | Yes: generated from `layouts.yaml` into `src/layout_types.d.ts`, checked by a test to match the layouts, so regenerating is not forgotten | Step 1 |
| D4 | The source of layout descriptions | A single YAML file (2.1 of design-scan.md); several files / a directory supported later | Step 1 |
| D3 | Whether the two behavior differences at the end of 7.5 are accepted | Accepted | Step 7 |

## 5. Conclusions of the open questions

Filled in after step 0:

| No. | Conclusion | Effect |
| --- | --- | --- |
| 0.1 | Confirmed from the source: `ModbusServer.js` of es-modbus v0.3.0-beta.2, when handling function codes 15 / 16, calls `set_coil` / `set_register` for each point in one synchronous loop. Step 0 adds a test to pin this behavior | The merging conclusion of 3.2 of design-scan.md holds |
| 0.2 | To be confirmed | |
| 0.3 | To be confirmed | |
