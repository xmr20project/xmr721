#!/bin/zsh
# Runs scan-remote.py on the machine that holds the Monero node's database, in parallel height ranges.
# Read-only on that machine.
# Usage: NODE_SSH=user@host run-scan.sh OUTPUT_DIR LAST_HEIGHT [WORKERS]
set -u
OUT=$1; LAST=$2; N=${3:-6}; FIRST=2838270
HERE=${0:A:h}
S=(ssh -T -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 ${NODE_SSH:?set NODE_SSH to user@host of the node machine})
mkdir -p $OUT
span=$(( (LAST - FIRST + 1 + N - 1) / N ))
pids=()
for i in $(seq 0 $((N-1))); do
  a=$((FIRST + i*span)); b=$((a + span - 1)); [ $b -gt $LAST ] && b=$LAST
  "${S[@]}" "nice -n 19 python3 -I - $a $b" < $HERE/scan-remote.py > $OUT/part-$i.bin 2> $OUT/part-$i.log &
  pids+=($!)
done
rc=0; for p in $pids; do wait $p || rc=1; done
for i in $(seq 0 $((N-1))); do tail -1 $OUT/part-$i.log | cut -c1-300; done
exit $rc
