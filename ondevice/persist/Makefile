# toolya persist — on-device pieces (docs/PERSIST.md).
#
# Device build (aarch64): needs gcc-aarch64-linux-gnu (same toolchain the
# natartos build uses), or run in a gcc:13 container:
#   docker run --rm -v "$PWD":/w -w /w gcc:13 make
CC ?= aarch64-linux-gnu-gcc
CFLAGS ?= -O2 -fno-builtin -nostdlib -Wall -Wextra -std=c17
BUILD := build

all: $(BUILD)/gps.default.so $(BUILD)/poke

# GPS HAL proxy: shared, dlopen'd by dji_services at boot.
$(BUILD)/gps.default.so: gps_proxy.c raw_syscall.h | $(BUILD)
	$(CC) $(CFLAGS) -shared -fPIC -o $@ gps_proxy.c

# Boot helper: static freestanding binary.
$(BUILD)/poke: poke.c raw_syscall.h | $(BUILD)
	$(CC) $(CFLAGS) -static -Wl,--entry=_start -o $@ poke.c

$(BUILD):
	mkdir -p $(BUILD)

# ---- tests: compile the same sources natively with fixture paths ----
TESTCC ?= cc
TESTCFLAGS := -O0 -g -Wall -Wextra -std=c17 -DPERSIST_TEST

test: fixture-check
	@echo "[persist] all fixture tests passed"

fixture-check: $(BUILD)/test-poke $(BUILD)/test-proxy $(BUILD)/test-stock
	./tests/run.sh

$(BUILD)/test-poke: poke.c raw_syscall.h tests/run.sh | $(BUILD)
	$(TESTCC) $(TESTCFLAGS) -o $@ poke.c

$(BUILD)/test-proxy: gps_proxy.c raw_syscall.h | $(BUILD)
	$(TESTCC) $(TESTCFLAGS) -shared -fPIC -o $(BUILD)/gps_proxy_test.so gps_proxy.c

$(BUILD)/test-stock: tests/stock_fixture.c | $(BUILD)
	$(TESTCC) $(TESTCFLAGS) -shared -fPIC -o $(BUILD)/stock_fixture.so tests/stock_fixture.c

$(BUILD)/test-proxy-main: tests/proxy_main.c | $(BUILD)
	$(TESTCC) $(TESTCFLAGS) -rdynamic -o $@ tests/proxy_main.c

clean:
	rm -rf $(BUILD)

.PHONY: all test fixture-check clean
