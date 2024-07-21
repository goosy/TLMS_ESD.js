import log4js from 'log4js';

const layout = {
    type: 'pattern',
    pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] - %m'
};

const file_appender = {
    type: 'file',
    pattern: 'yyyy-MM-dd',
    fileNameSep: '_',
    keepFileExt: true,
    maxLogSize: 10 * 1024 * 1024, // 10MB
    compress: true,
    alwaysIncludePattern: true,
    layout,
}

const level = process.env.LOG_LEVEL || 'info';

const appenders = [];
if (process.env.TLMS !== 'controller') {
    appenders.push('console');
}
if (process.env.TLMS !== 'emulator') {
    appenders.push('info_file', 'error_file');
}

log4js.configure({
    appenders: {
        info_file: { ...file_appender, filename: 'logs/info.log' },
        error_file: { ...file_appender, filename: 'logs/error.log' },
        console: {
            type: 'console',
            layout: {
                type: 'pattern',
                pattern: '%[%d{yyyy-MM-dd hh:mm:ss.SSS} %p%] - %m',
            }
        }
    },
    categories: {
        default: { appenders, level }
    }
});

export const logger = log4js.getLogger();

/**
 * Mixes properties from multiple objects into a target object.
 *
 * @param {Object} target - The target object to mix properties into.
 * @param {...Object} mixin_items - The objects containing properties to mix into the target object.
 * @return {void}
 */
function mixin(target, mixin_item) {
    [...Object.getOwnPropertyNames(mixin_item), ...Object.getOwnPropertySymbols(mixin_item)].forEach(key => {
        if (!target.hasOwnProperty(key)) {
            Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(mixin_item, key));
        }
    });
}

/**
 * Mixes properties from multiple objects into an object.
 * and do same for their prototypes.
 * It is mainly applied to the `this` object in the class constructor
 *
 * @param {Object} obj - The object to mix properties into.
 * @param {...Object} mixin_items - The objects containing properties to mix into the object.
 * @return {void}
 */
Object.mixin = function (obj, ...mixin_items) {
    mixin_items.forEach(mixin_item => {
        mixin(Object.getPrototypeOf(obj), Object.getPrototypeOf(mixin_item));
        mixin(obj, mixin_item);
    });
}

// Create an object to store timers for each tag
const timers = {};

/**
 * @param {string} key - The tag to identify the debounced function
 * @param {Function} fn - The function to debounce
 * @param {number} delay - The delay in milliseconds
 * @returns {Function} The debounced function
 */
export function debouncify(key, fn, delay) {
    return function (...args) {
        // If the timer for this tag already exists, clear it
        if (timers[key]) {
            clearTimeout(timers[key]);
        }

        // Set a new timer for this tag
        timers[key] = setTimeout(() => {
            fn.apply(this, args);
            delete timers[key];
        }, delay);
    }
}

/**
 * @param {string} key - The tag to identify the debounced function
 * @param {Function} fn - The function to debounce
 * @param {number} delay - The delay in milliseconds
 * @returns {Function} The debounced function
 */
export function debounce(key, fn, delay) {
    // If the timer for this tag already exists, clear it
    if (timers[key]) {
        clearTimeout(timers[key]);
    }

    // Set a new timer for this tag
    timers[key] = setTimeout(() => {
        fn();
        delete timers[key];
    }, delay);
}
