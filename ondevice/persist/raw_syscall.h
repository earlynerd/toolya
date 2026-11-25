/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Raw syscall wrappers for the persist pieces. Both the GPS proxy (a
 * constructor inside a dlopen, where libc locks are hazardous) and the
 * static helper run -nostdlib and talk to the kernel directly.
 */
#ifndef TOOLYA_PERSIST_RAW_SYSCALL_H
#define TOOLYA_PERSIST_RAW_SYSCALL_H

#include <stddef.h>
#include <stdint.h>

#if defined(__aarch64__)
enum { NR_openat = 56, NR_close = 57, NR_lseek = 62, NR_read = 63, NR_write = 64,
       NR_getpid = 172, NR_geteuid = 175, NR_statx = 291, NR_exit_group = 94,
       NR_clone = 220, NR_execve = 221, NR_wait4 = 260, NR_setsid = 157,
       NR_mmap = 222, NR_munmap = 215, NR_nanosleep = 101,
       RAW_O_NOFOLLOW = 0100000 };
static inline long raw_call(long n, long a, long b, long c, long d, long e) {
    register long x0 __asm__("x0") = a, x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c, x3 __asm__("x3") = d;
    register long x4 __asm__("x4") = e, x8 __asm__("x8") = n;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3),
                     "r"(x4), "r"(x8) : "memory", "cc");
    return x0;
}
#elif defined(__x86_64__)
enum { NR_openat = 257, NR_close = 3, NR_lseek = 8, NR_read = 0, NR_write = 1,
       NR_getpid = 39, NR_geteuid = 107, NR_statx = 332, NR_exit_group = 231,
       NR_clone = 56, NR_execve = 59, NR_wait4 = 61, NR_setsid = 112,
       NR_mmap = 9, NR_munmap = 11, NR_nanosleep = 35,
       RAW_O_NOFOLLOW = 0400000 };
static inline long raw_call(long n, long a, long b, long c, long d, long e) {
    register long r10 __asm__("r10") = d, r8 __asm__("r8") = e;
    long result;
    __asm__ volatile("syscall" : "=a"(result) : "a"(n), "D"(a), "S"(b),
                     "d"(c), "r"(r10), "r"(r8) : "rcx", "r11", "memory", "cc");
    return result;
}
#else
#error toolya persist supports Linux AArch64 and x86-64 (tests) only.
#endif

/* open flags (generic Linux values) */
enum { RAW_O_RDONLY_ = 0, RAW_O_WRONLY_ = 1, RAW_O_RDWR_ = 2,
       RAW_O_APPEND_ = 02000, RAW_O_CLOEXEC_ = 02000000,
       RAW_O_NOFOLLOW_ = RAW_O_NOFOLLOW };

#define RAW_AT_FDCWD (-100)

/* Six-argument calls (mmap). Same register contract, one arg deeper. */
#if defined(__aarch64__)
static inline long raw_call6(long n, long a, long b, long c, long d, long e, long f) {
    register long x0 __asm__("x0") = a, x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c, x3 __asm__("x3") = d;
    register long x4 __asm__("x4") = e, x5 __asm__("x5") = f;
    register long x8 __asm__("x8") = n;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3),
                     "r"(x4), "r"(x5), "r"(x8) : "memory", "cc");
    return x0;
}
#elif defined(__x86_64__)
static inline long raw_call6(long n, long a, long b, long c, long d, long e, long f) {
    register long r10 __asm__("r10") = d, r8 __asm__("r8") = e, r9 __asm__("r9") = f;
    long result;
    __asm__ volatile("syscall" : "=a"(result) : "a"(n), "D"(a), "S"(b),
                     "d"(c), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory", "cc");
    return result;
}
#endif

static inline long raw_open(const char *path, long flags) {
    return raw_call(NR_openat, RAW_AT_FDCWD, (long)path, flags, 0, 0);
}
static inline void raw_close(long fd) { (void)raw_call(NR_close, fd, 0, 0, 0, 0); }
static inline long raw_read(long fd, void *buf, long len) {
    return raw_call(NR_read, fd, (long)buf, len, 0, 0);
}
static inline long raw_write(long fd, const void *buf, long len) {
    return raw_call(NR_write, fd, (long)buf, len, 0, 0);
}
static inline void raw_exit(long code) { (void)raw_call(NR_exit_group, code, 0, 0, 0, 0); }

/* Linux statx has one fixed layout on both supported architectures. */
struct raw_statx {
    uint32_t mask, blksize;
    uint64_t attributes;
    uint32_t nlink, uid, gid;
    uint16_t mode, pad;
    uint64_t ino, size;
    unsigned char rest[208];
};
_Static_assert(sizeof(struct raw_statx) == 256, "statx ABI");

enum { STATX_TYPE_ = 1, STATX_MODE_ = 2, STATX_UID_ = 8, STATX_SIZE_ = 0x200,
       AT_EMPTY_PATH_ = 0x1000, S_IFREG_ = 0100000, S_IFMT_ = 0170000 };

static inline long raw_statx(const char *path, struct raw_statx *st) {
    return raw_call(NR_statx, RAW_AT_FDCWD, (long)path, 0x100 /*AT_SYMLINK_NOFOLLOW*/, 0x3FF, (long)st);
}

/* Trusted = regular file (no symlink), root-owned, no group/world write.
 * Mirrors the natartos boot-activation trust gates. */
static inline int raw_trusted_file(const char *path) {
    struct raw_statx st;
    if (raw_statx(path, &st) != 0) return 0;
    if ((st.mode & S_IFMT_) != S_IFREG_) return 0;
    if (st.uid != 0) return 0;
    if (st.mode & 0022) return 0;
    return 1;
}

/* File absent (does not exist). */
static inline int raw_absent(const char *path) {
    struct raw_statx st;
    return raw_statx(path, &st) == -2; /* -ENOENT */
}

/* Read a regular file (bounded). Returns length, or -1. */
static inline long raw_readfile(const char *path, char *buf, long cap) {
    long fd = raw_open(path, RAW_O_RDONLY_ | RAW_O_CLOEXEC_ | RAW_O_NOFOLLOW_);
    if (fd < 0) return -1;
    long total = 0, r;
    while (total < cap && (r = raw_read(fd, buf + total, cap - total)) > 0) total += r;
    raw_close(fd);
    if (r < 0 && total == 0) return -1;
    if (total < cap) buf[total] = 0;
    return total;
}

/* Exact-match a small file against a token (token may include trailing LF). */
static inline int raw_file_is(const char *path, const char *token, long tlen) {
    char buf[64];
    if (tlen >= (long)sizeof buf) return 0;
    long n = raw_readfile(path, buf, (long)sizeof buf - 1);
    if (n < 0 || n != tlen) return 0;
    for (long i = 0; i < tlen; i++) if (buf[i] != token[i]) return 0;
    return 1;
}

/* Minimal helpers (no libc). */
static inline long raw_strlen(const char *s) { long n = 0; while (s[n]) n++; return n; }
static inline int raw_streq(const char *a, const char *b) {
    long i = 0; while (a[i] && a[i] == b[i]) i++; return a[i] == b[i];
}
static inline void raw_strlcpy(char *d, const char *s, long cap) {
    long i = 0;
    for (; i + 1 < cap && s[i]; i++) d[i] = s[i];
    d[i < cap ? i : cap - 1] = 0;
}
#endif
