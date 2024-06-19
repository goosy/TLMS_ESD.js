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

export function curr_time() {
    const date = new Date();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}