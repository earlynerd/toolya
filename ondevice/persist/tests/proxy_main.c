/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Loads the fixture-built proxy and proves forward-first behavior:
 * dlopen(proxy) → call exported getter → sentinel comes from the stock lib,
 * argument passed through unchanged. Also proves no helper spawn happens
 * when the arm flag is absent (checked by the runner via the fixture dir).
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    void *p = dlopen("./build/gps_proxy_test.so", RTLD_NOW | RTLD_GLOBAL);
    if (!p) { fprintf(stderr, "dlopen proxy: %s\n", dlerror()); return 1; }
    const void *(*g)(void *) = dlsym(p, "gps_get_hardware_interface");
    if (!g) { fprintf(stderr, "dlsym getter: %s\n", dlerror()); return 1; }
    const void *r = g((void *)0x42);
    if (r != (const void *)0xC0FFEE) { fprintf(stderr, "forward broken: got %p\n", r); return 1; }
    if (g((void *)0x99) != 0) { fprintf(stderr, "forward not transparent\n"); return 1; }
    puts("proxy forward ok");
    return 0;
}
