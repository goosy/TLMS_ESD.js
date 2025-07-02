import log4js from 'log4js';

const level = process.env.LOG_LEVEL || 'info';

const default_appenders = ['info_file', 'error_file'];
if (process.env.TLMS !== 'controller') {
    default_appenders.push('console');
}

const file_appender = {
    type: 'file',
    pattern: 'yyyy-MM-dd',
    fileNameSep: '_',
    keepFileExt: true,
    maxLogSize: 10 * 1024 * 1024, // 10MB
    compress: true,
    alwaysIncludePattern: true,
    layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] - %m'
    },
}

const colored_layout = {
    type: 'pattern',
    pattern: '%[%d{yyyy-MM-dd hh:mm:ss.SSS} %p%] - %m',
};

log4js.configure({
    appenders: {
        info_file: { ...file_appender, filename: 'logs/info.log' },
        error_file: { ...file_appender, filename: 'logs/error.log' },
        console: { type: 'console', layout: colored_layout, }
    },
    categories: {
        console: { appenders: ['console'], level },
        default: { appenders: default_appenders, level }
    }
});

const logger_map = {
    default: log4js.getLogger('default'),
    console: log4js.getLogger('console'),
};

export const logger = {
    _logger: logger_map.default,
    set category(category) {
        logger._logger = logger_map[category] ?? logger_map.default;
    },

    trace(message, ...args) {
        this._logger.trace(message, ...args);
    },
    debug(message, ...args) {
        this._logger.debug(message, ...args);
    },
    info(message, ...args) {
        this._logger.info(message, ...args);
    },
    warn(message, ...args) {
        this._logger.warn(message, ...args);
    },
    error(message, ...args) {
        this._logger.error(message, ...args);
    },
    fatal(message, ...args) {
        this._logger.fatal(message, ...args);
    },
}

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
const debounce_timers = {};

/**
 * @param {string} key - The tag to identify the debounced function
 * @param {Function} fn - The function to debounce
 * @param {number} delay - The delay in milliseconds
 * @returns {Function} The debounced function
 */
export function debouncify(key, fn, delay) {
    // Check if the key is a string
    // Check if the function is a valid function
    if (typeof key !== 'string' || typeof fn !== 'function') {
        return () => { };
    }

    return function (...args) {
        // If the timer for this tag already exists, clear it
        const timer = debounce_timers[key];
        if (timer) {
            clearTimeout(timer);
        }

        // Set a new timer for this tag
        debounce_timers[key] = setTimeout(() => {
            fn.apply(this, args);
            delete debounce_timers[key];
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
    // Check if the key is a string
    // Check if the function is a valid function
    if (typeof key !== 'string' || typeof fn !== 'function') {
        return;
    }

    // If the timer for this tag already exists, clear it
    const timer = debounce_timers[key];
    if (timer) {
        clearTimeout(timer);
    }

    // Set a new timer for this tag
    debounce_timers[key] = setTimeout(() => {
        fn();
        delete debounce_timers[key];
    }, delay);
}
