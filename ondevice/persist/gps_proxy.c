/* SPDX-License-Identifier: AGPL-3.0-or-later
 * gps.default.so proxy — the persistent boot anchor (docs/PERSIST.md).
 *
 * Installed in place of the stock GPS HAL library; dji_services dlopens it
 * at every boot. Forward-first: the original library is loaded and its getter
 * resolved before any gate logic runs, so the worst this code can do to the
 * consumer is behave exactly like a stock library that returns null.
 *
 * If — and only if — every gate passes (root, arm flag exact-match, no kill
 * flag, trusted helper/config), it detaches a static helper via two raw
 * forks + execve. Raw syscalls only past the constructor: libc locks are
 * held inside a dlopen. No vendor code is copied or redistributed.
 */
#include <stddef.h>
#include <stdint.h>
#include "raw_syscall.h"

#ifdef PERSIST_TEST
#define STOCK_PATH   "./fixture/gps.stock.so"
#define ENABLED_FLAG "./fixture/enabled"
#define DISABLED_FLAG "./fixture/disabled"
#define HELPER_PATH  "./fixture/poke"
#define CONFIG_PATH  "./fixture/config"
#else
#define STOCK_PATH   "/vendor/lib64/gps.default.stock.so"
#define ENABLED_FLAG "/data/toolya-persist/enabled"
#define DISABLED_FLAG "/data/toolya-persist/disabled"
#define HELPER_PATH  "/vendor/lib64/toolya_persist/poke"
#define CONFIG_PATH  "/vendor/lib64/toolya_persist/config"
#endif

/* Arm token, exactly as written by the CLI: "toolya-persist-v1\n". */
static const char ARM_TOKEN[] = "toolya-persist-v1\n";

/* The only dynamic imports; resolved from the host process's libdl. */
extern void *dlopen(const char *, int);
extern void *dlsym(void *, const char *);
enum { RTLD_NOW_ = 2, RTLD_LOCAL_ = 4 };

typedef const void *(*gps_getter)(void *);
static gps_getter stock_getter;

__attribute__((visibility("default")))
const void *gps_get_hardware_interface(void *device) {
    gps_getter getter = __atomic_load_n(&stock_getter, __ATOMIC_ACQUIRE);
    return getter ? getter(device) : NULL;
}

static int gates_pass(void) {
    if (raw_call(NR_geteuid, 0, 0, 0, 0, 0) != 0) return 0;
    /* Kill switch first: presence = stock behavior, unconditionally. */
    if (!raw_absent(DISABLED_FLAG)) {
        struct raw_statx st;
        if (raw_statx(DISABLED_FLAG, &st) != 0) return 0; /* exists → off */
    }
    if (!raw_file_is(ENABLED_FLAG, ARM_TOKEN, (long)sizeof ARM_TOKEN - 1)) return 0;
    if (!raw_trusted_file(ENABLED_FLAG)) return 0;
    if (!raw_trusted_file(HELPER_PATH)) return 0;
    if (!raw_trusted_file(CONFIG_PATH)) return 0;
    return 1;
}

static void spawn_helper(void) {
    long a = raw_call(NR_clone, 17 /*SIGCHLD*/, 0, 0, 0, 0);
    if (a > 0) { (void)raw_call(NR_wait4, a, 0, 0, 0, 0); return; }
    if (a < 0) return;
    /* child A: second fork so the helper is re-parented to init, then exec. */
    long b = raw_call(NR_clone, 17 /*SIGCHLD*/, 0, 0, 0, 0);
    if (b < 0) raw_exit(1);
    if (b > 0) raw_exit(0);
    (void)raw_call(NR_setsid, 0, 0, 0, 0, 0);
    static char arg0[] = HELPER_PATH;
    char *argv[] = { arg0, 0 };
    (void)raw_call(NR_execve, (long)arg0, (long)argv, 0, 0, 0);
    raw_exit(1);
}

__attribute__((constructor))
static void persist_init(void) {
    void *h = dlopen(STOCK_PATH, RTLD_NOW_ | RTLD_LOCAL_);
    if (h) {
        gps_getter g = (gps_getter)dlsym(h, "gps_get_hardware_interface");
        __atomic_store_n(&stock_getter, g, __ATOMIC_RELEASE);
    }
    /* Forwarding is established (or honestly null) before anything else. */
    if (stock_getter && gates_pass()) spawn_helper();
}
