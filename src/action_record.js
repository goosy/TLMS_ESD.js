import { access, writeFile, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import csv_parser from 'csv-parser';
import { TData } from './typed_data/TData.js';
import { RECORD } from './structs/record.js';
import { logger } from './util.js';

const HEADERS = RECORD.items
    .filter(field => field.type.toLowerCase() !== 'word' && field.name !== 'index')
    .map(field => field.name);
const boolean_fields = ["press_action", "flow_action", "node1_pump_run", "node2_pump_run", "node3_pump_run", "node4_pump_run"];
const number_fields = HEADERS.filter(field => !boolean_fields.includes(field));
function convertTypes(row) {
    for (const field of number_fields) {
        const value = row[field];
        row[field] = value !== '' && value !== undefined ? Number.parseFloat(value) : null;
    }
    for (const field of boolean_fields) {
        row[field] = row[field] === 'true';
    }
}

function set_current_time(tdata) {
    const d = new Date();
    tdata.year = d.getFullYear();
    tdata.month = d.getMonth() + 1;
    tdata.day = d.getDate();
    tdata.hour = d.getHours();
    tdata.minute = d.getMinutes();
    tdata.second = d.getSeconds();
}

export class Action_Record {
    records = [];
    records_size = 10;
    data;
    name;
    file;
    constructor(name) {
        this.name = name;
        this.file = `${name}.csv`;
        this.data = new TData(RECORD, name);
    }

    get(index) {
        const record = this.records[index];
        if (!record) return false;
        for (const key of HEADERS) {
            this.data[key] = record[key];
        }
        return true;
    }

    async init(filename) {
        this.file = filename ?? this.file;
        try {
            await access(this.file);
            logger.info(`action record file is set to ${this.file}.`);
        } catch {
            await writeFile(this.file, `${HEADERS.join(',')}\n`);
            logger.info(`Empty action record file ${this.file} is created and used.`);
        }
        await this.read_records_from_csv();
        this.data.on('change', (tagname, old_value, new_value) => {
            logger.debug(`${this.name}: ${tagname} ${old_value} => ${new_value}`);
            if (tagname === 'index') {
                if (new_value === -1) {
                    const data = this.data;
                    data.year = 0;
                    data.month = 0;
                    data.day = 0;
                    data.hour = 0;
                    data.minute = 0;
                    data.second = 0;
                } else {
                    const OK = this.get(new_value);
                    if (!OK) this.data.index = old_value;
                }
            }
        });
        // Initial index value
        if (this.records.length) {
            this.data.index = 0;
        } else {
            this.data.index = -1;
        }
    }

    read_records_from_csv() {
        return new Promise((resolve, reject) => {
            const records = this.records;
            records.length = 0;
            createReadStream(this.file)
                .pipe(csv_parser())
                .on('error', error => reject(error))
                .on('data', row => {
                    // add record to records and ensure records' length does not exceed records_size
                    if (records.unshift(row) > this.records_size) records.pop();
                })
                .on('end', () => {
                    records.forEach(convertTypes);
                    resolve(true);
                });
        });
    }

    async add_record() {
        set_current_time(this.data);
        const record = {};
        for (const key of HEADERS) {
            record[key] = this.data[key];
        }
        // add record to records and ensure records' length does not exceed records_size
        if (this.records.unshift(record) > this.records_size) this.records.pop();
        this.data.index = 0;
        // append record to csv
        const row = HEADERS.map(key => this.data[key]).join(',');
        await appendFile(this.file, `${row}\n`, { flags: 'a' });
    }
}
