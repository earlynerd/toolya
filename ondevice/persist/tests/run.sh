#!/bin/sh
# Fixture tests for toolya persist (native build, PERSIST_TEST paths).
# Proves: config parse, pattern-gated enforce-byte poke on a fixture "mem"
# file, setprop exec, kill-switch refusal, token refusal, proxy forwarding.
set -e
cd "$(dirname "$0")/.."

F=fixture
mkcfg() { # $1=token $2=usb
  printf 'v=1\naddrs=0x1000\noff=1\nusb=%s\ndelay=0\ntoken=%s\n' "$2" "$1" > $F/config
}
mkm() { # fixture "physical memory": word 0x01000100 at 0x1000 (LE 00 01 00 01)
  printf '%08x' 0 | head -c 4096 >/dev/null # no-op guard
  dd if=/dev/zero of=$F/mem bs=4096 count=2 status=none
  printf '\000\001\000\001' | dd of=$F/mem bs=1 seek=4096 conv=notrunc status=none
}
word_at() { od -An -tx1 -j 4096 -N 4 $F/mem | tr -d ' \n'; }

fail() { echo "FAIL: $1"; exit 1; }

rm -rf $F; mkdir -p $F
cp build/stock_fixture.so $F/gps.stock.so

echo "== poke: happy path (armed)"
mkm
printf 'toolya-persist-v1\n' > $F/enabled; chmod 600 $F/enabled
mkcfg toolya-persist-v1 acm,adb
printf '#!/bin/sh\necho "$1=$2" >> ./fixture/setprop.log\n' > $F/fake-setprop; chmod 755 $F/fake-setprop
build/test-poke || fail "poke exited nonzero"
[ "$(word_at)" = "00000001" ] || fail "enforce byte at +1 not cleared (mem=$(word_at))"
grep -q 'sys.usb.config=acm,adb' $F/setprop.log || fail "setprop not exec'd"
grep -q 'phase=done poke=ok usb=set' $F/boot.log || fail "witness line missing: $(cat $F/boot.log)"

echo "== poke: kill switch (disabled flag) refuses"
mkm; touch $F/disabled
build/test-poke; [ $? -eq 2 ] || fail "expected exit 2 with kill switch"
[ "$(word_at)" = "00010001" ] || fail "memory written despite kill switch"
rm $F/disabled

echo "== poke: wrong token refuses"
mkm; mkcfg not-the-token acm,adb
build/test-poke; [ $? -eq 4 ] || fail "expected exit 4 on token mismatch"
[ "$(word_at)" = "00010001" ] || fail "memory written with bad token"

echo "== proxy: forward-first pass-through"
rm -f $F/enabled   # unarmed: constructor must still forward, spawn nothing
build/test-proxy-main

echo "persist fixture tests: all ok"
