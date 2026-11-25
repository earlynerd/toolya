/* SPDX-License-Identifier: AGPL-3.0-or-later
 * toolya_persist boot helper (static, -nostdlib, raw syscalls).
 *
 * Exec'd once per boot by the gps proxy when every gate passes. Re-validates
 * the gates (defense against a race), settles, then does exactly two things:
 *
 *   1. SELinux permissive: devmem-style poke of the selinux_state enforce
 *      byte at the physical addresses from the config file. Only addresses
 *      whose 32-bit word matches the known selinux_state pattern (0x01000100
 *      or 0x01000000) are ever written; a single byte is set to 0.
 *   2. ADB on: exec /system/bin/setprop sys.usb.config <usb string>, the
 *      same property write the stock engpc factory path uses.
 *
 * Everything else is witness logging. It never writes anywhere else, never
 * restores enforcing, and never touches the flash chain. Revert = remove the
 * arm flag (or set the kill flag) and reboot.
 */
#include "raw_syscall.h"

#ifdef PERSIST_TEST
#define CONFIG_PATH "./fixture/config"
#define ENABLED_FLAG "./fixture/enabled"
#define DISABLED_FLAG "./fixture/disabled"
#define LOG_PATH "./fixture/boot.log"
#define MEM_PATH "./fixture/mem"
#define SETPROP_PATH "./fixture/fake-setprop"
#else
#define CONFIG_PATH "/vendor/lib64/toolya_persist/config"
#define ENABLED_FLAG "/data/toolya-persist/enabled"
#define DISABLED_FLAG "/data/toolya-persist/disabled"
#define LOG_PATH "/data/toolya-persist/boot.log"
#define MEM_PATH "/dev/mem"
#define SETPROP_PATH "/system/bin/setprop"
#endif

static const char ARM_TOKEN[] = "toolya-persist-v1\n";
enum { LOG_MAX = 131072, CFG_MAX = 4096, ADDR_MAX = 8 };
enum { PROT_RW_ = 3, MAP_SHARED_ = 1 };

/* ---- tiny formatting (no libc) ---- */
static char *put_str(char *p, const char *end, const char *s) {
    while (*s && p < end) *p++ = *s++;
    return p;
}
static char *put_dec(char *p, const char *end, unsigned long v) {
    char t[24]; int n = 0;
    do { t[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (n && p < end) *p++ = t[--n];
    return p;
}
static char *put_hex(char *p, const char *end, unsigned long v) {
    static const char d[] = "0123456789abcdef";
    if (p + 2 > end) return p;
    *p++ = '0'; *p++ = 'x';
    for (int i = 15; i >= 0; i--) {
        char c = d[(v >> (i * 4)) & 0xF];
        if (c != '0' || i == 0) { if (p < end) *p++ = c; }
    }
    return p;
}

static unsigned long parse_dec(const char *s) {
    unsigned long v = 0;
    while (*s >= '0' && *s <= '9') v = v * 10 + (unsigned long)(*s++ - '0');
    return v;
}
static unsigned long parse_hex(const char *s) {
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
    unsigned long v = 0;
    for (;; s++) {
        int d;
        if (*s >= '0' && *s <= '9') d = *s - '0';
        else if (*s >= 'a' && *s <= 'f') d = *s - 'a' + 10;
        else if (*s >= 'A' && *s <= 'F') d = *s - 'A' + 10;
        else break;
        v = v * 16 + (unsigned long)d;
    }
    return v;
}

/* value lookup in a key=value config; out gets a pointer into cfg */
static int cfg_get(char *cfg, const char *key, char **out) {
    long klen = raw_strlen(key);
    char *p = cfg;
    while (*p) {
        char *eol = p; while (*eol && *eol != '\n') eol++;
        long eq = 0; while (eq < klen && p[eq] == key[eq]) eq++;
        if (eq == klen && p[eq] == '=') { *out = p + eq + 1; return 1; }
        if (!*eol) break;
        *eol = 0; p = eol + 1;
    }
    return 0;
}

static void sleep_s(unsigned long secs) {
    struct { long tv_sec, tv_nsec; } ts;
    ts.tv_nsec = 0;
    /* one second at a time; nanosleep may return early on signal */
    while (secs--) { ts.tv_sec = 1; (void)raw_call(NR_nanosleep, (long)&ts, 0, 0, 0, 0); }
}

/* ---- witness log ---- */
static void log_line(const char *what, int poke_ok, int usb_set, const char *enforce_state,
                     int poked_addr) {
    struct raw_statx st;
    if (raw_statx(LOG_PATH, &st) == 0 && st.size >= LOG_MAX) return; /* cap: drop */
    long fd = raw_call(NR_openat, RAW_AT_FDCWD, (long)LOG_PATH,
                       RAW_O_WRONLY_ | RAW_O_APPEND_ | RAW_O_CLOEXEC_ | RAW_O_NOFOLLOW_, 0, 0);
    if (fd < 0) return;
    char line[512], *p = line, *end = line + sizeof line - 2;
    p = put_str(p, end, "persist v=1 phase=");
    p = put_str(p, end, what);
    p = put_str(p, end, " pid=");
    p = put_dec(p, end, (unsigned long)raw_call(NR_getpid, 0, 0, 0, 0, 0));
    p = put_str(p, end, " poke=");
    /* ok = byte written; skip = no addresses; deny = /dev/mem open refused
       (the exact LSM/DAC signal the first bench run is probing for). */
    p = put_str(p, end, poke_ok > 0 ? "ok" : (poke_ok == 0 ? "skip" : "deny"));
    p = put_str(p, end, " usb=");
    p = put_str(p, end, usb_set > 0 ? "set" : "fail");
    p = put_str(p, end, " enforce=");
    p = put_str(p, end, enforce_state);
    if (poked_addr) { p = put_str(p, end, " addr="); p = put_hex(p, end, (unsigned long)poked_addr); }
    /* boot id for cross-boot correlation */
    char bid[48];
    if (raw_readfile("/proc/sys/kernel/random/boot_id", bid, (long)sizeof bid - 1) > 0) {
        long n = raw_strlen(bid); while (n && (bid[n-1] == '\n' || bid[n-1] == '\r')) bid[--n] = 0;
        p = put_str(p, end, " boot=");
        p = put_str(p, end, bid);
    }
    *p++ = '\n';
    (void)raw_write(fd, line, p - line);
    raw_close(fd);
}

/* ---- gates re-check (the proxy checked too; re-arm against races) ---- */
static int gates_pass(void) {
    if (raw_call(NR_geteuid, 0, 0, 0, 0, 0) != 0) return 0;
    struct raw_statx st;
    if (raw_statx(DISABLED_FLAG, &st) == 0) return 0; /* kill switch present */
    if (!raw_file_is(ENABLED_FLAG, ARM_TOKEN, (long)sizeof ARM_TOKEN - 1)) return 0;
    if (!raw_trusted_file(ENABLED_FLAG)) return 0;
    return 1;
}

/* ---- the SELinux enforce-byte poke ---- */
static int poke_permissive(unsigned long addrs[ADDR_MAX], int naddrs, unsigned long off,
                           unsigned long *hit) {
    long fd = raw_open(MEM_PATH, RAW_O_RDWR_ | RAW_O_CLOEXEC_);
    if (fd < 0) return -1;
    int ok = 0;
    for (int i = 0; i < naddrs && !ok; i++) {
        unsigned long page = addrs[i] & ~0xFFFUL, inpage = addrs[i] & 0xFFFUL;
        void *m = (void *)raw_call6(NR_mmap, 0, 4096, PROT_RW_, MAP_SHARED_, fd, (long)page);
        if ((unsigned long)m >= (unsigned long)-4095L) continue; /* mmap errno */
        unsigned char *base = (unsigned char *)m + inpage;
        unsigned int word = *(volatile unsigned int *)base;
        if (word == 0x01000100u || word == 0x01000000u) {
            *(volatile unsigned char *)(base + off) = 0;
            *hit = addrs[i];
            ok = 1;
        }
        (void)raw_call(NR_munmap, (long)m, 4096, 0, 0, 0);
    }
    raw_close(fd);
    return ok;
}

/* ---- setprop via the stock binary (no property-service code needed) ---- */
static int setprop_on_device(const char *val) {
    long pid = raw_call(NR_clone, 17 /*SIGCHLD*/, 0, 0, 0, 0);
    if (pid < 0) return 0;
    if (pid == 0) {
        static char a0[] = SETPROP_PATH, a1[] = "sys.usb.config";
        static char vbuf[64];
        raw_strlcpy(vbuf, val, (long)sizeof vbuf);
        char *argv[] = { a0, a1, vbuf, 0 };
        char *envp[] = { "PATH=/system/bin:/sbin:/vendor/bin", 0 };
        (void)raw_call(NR_execve, (long)a0, (long)argv, (long)envp, 0, 0);
        raw_exit(127);
    }
    long status = raw_call(NR_wait4, pid, 0, 0, 0, 0);
    return status >= 0;
}

static const char *read_enforce_state(void) {
    char b[8];
    long n = raw_readfile("/sys/fs/selinux/enforce", b, (long)sizeof b - 1);
    if (n <= 0) return "deny";
    return b[0] == '0' ? "0" : "1";
}

static void poke_main(void) {
    if (!gates_pass()) { log_line("gate", 0, 0, read_enforce_state(), 0); raw_exit(2); }

    char cfg[CFG_MAX];
    if (raw_readfile(CONFIG_PATH, cfg, (long)sizeof cfg - 1) < 0) {
        log_line("cfg-open", 0, 0, read_enforce_state(), 0); raw_exit(3);
    }
    char *v;
    if (!cfg_get(cfg, "v", &v) || v[0] != '1' ||
        !cfg_get(cfg, "token", &v) || !raw_streq(v, "toolya-persist-v1")) {
        log_line("cfg-bad", 0, 0, read_enforce_state(), 0); raw_exit(4);
    }
    unsigned long delay = 10, off = 1;
    if (cfg_get(cfg, "delay", &v)) delay = parse_dec(v);
    if (cfg_get(cfg, "off", &v)) off = parse_dec(v);
    const char *usb = "acm,adb";
    char *uv;
    if (cfg_get(cfg, "usb", &uv) && uv[0]) usb = uv;

    sleep_s(delay); /* let stock boot settle before we touch anything */

    unsigned long addrs[ADDR_MAX]; int naddrs = 0;
    if (cfg_get(cfg, "addrs", &v)) {
        while (naddrs < ADDR_MAX && *v) {
            addrs[naddrs++] = parse_hex(v);
            while (*v && *v != ',') v++;
            if (*v == ',') v++;
        }
    }

    unsigned long hit = 0;
    int poke_ok = naddrs ? poke_permissive(addrs, naddrs, off, &hit) : 0;
    int usb_set = setprop_on_device(usb);
    log_line("done", poke_ok, usb_set, read_enforce_state(), hit);
    raw_exit(poke_ok > 0 ? 0 : 5);
}

#ifdef PERSIST_TEST
int main(void) { poke_main(); return 0; }
#else
void _start(void) { poke_main(); }
#endif
