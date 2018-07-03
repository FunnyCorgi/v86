"use strict";
/*
 * Compile time configuration, some only relevant for debug mode
 */

/**
 * @define {boolean}
 * Overridden for production by closure compiler
 */
var DEBUG = true;

/** @const
 * Also needs to be set in config.h
 */
var ENABLE_PROFILER = false;

/** @const */
var LOG_TO_FILE = false;

/**
 * @const
 * Enables logging all IO port reads and writes. Very verbose
 */
var LOG_ALL_IO = false;

/**
 * @const
 */
var DUMP_GENERATED_WASM = false;

/**
 * @const
 * Note: Needs to be enabled here and in const.h
 */
var DUMP_UNCOMPILED_ASSEMBLY = false;


var LOG_LEVEL = LOG_ALL & ~LOG_PS2 & ~LOG_PIT & ~LOG_VIRTIO & ~LOG_9P & ~LOG_PIC &
                          ~LOG_DMA & ~LOG_SERIAL & ~LOG_NET & ~LOG_FLOPPY & ~LOG_DISK & ~LOG_VGA;


/** @const */
var ENABLE_HPET = DEBUG && false;

/** @const */
var ENABLE_ACPI = false;


/**
 * @const
 * How often, in milliseconds, to yield to the browser for rendering and
 * running events
 */
var TIME_PER_FRAME = 1;

/**
 * @const
 * How many ticks the TSC does per millisecond
 */
var TSC_RATE = 50 * 1000;


/** @const */
var APIC_TIMER_FREQ = TSC_RATE;


/** @const */
var VMWARE_HYPERVISOR_PORT = true;

/** @const
 * Whether the coverage logger should be enabled under the appropriate conditions
 */
const COVERAGE_LOGGER_ALLOW = true;
