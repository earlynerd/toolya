/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Stand-in for the stock GPS library: exports the getter the proxy forwards
 * to, with a recognizable sentinel so tests can prove pass-through.
 */
#include <stdint.h>
typedef const void *(*gps_getter)(void *);
static const void *get(void *device) {
    return (uintptr_t)device == 0x42 ? (const void *)0xC0FFEE : 0;
}
__attribute__((visibility("default")))
const void *gps_get_hardware_interface(void *device) { return get(device); }
