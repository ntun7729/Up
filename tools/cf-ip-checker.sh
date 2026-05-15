#!/usr/bin/env bash
set -u

DOMAIN=""
PATH_TO_TEST="/health"
PORTS="443"
ROUNDS="1"
TOP="10"
CONCURRENCY="12"
CONNECT_TIMEOUT="2"
MAX_TIME="5"
IP_FILE=""
OUT="cf-ip-results.csv"
UUID=""
RANDOM_COUNT="0"
RANDOM_ONLY="false"
RANGES_URL="https://www.cloudflare.com/ips-v4"

DEFAULT_IPS="104.16.0.0 104.17.0.0 104.18.0.0 104.19.0.0 104.20.0.0 104.21.0.0 104.22.0.0 104.24.0.0 104.25.0.0 104.26.0.0 104.27.0.0 172.64.0.0 172.65.0.0 172.66.0.0 172.67.0.0 162.159.0.0 104.16.1.1 104.17.1.1 104.18.1.1 104.19.1.1 104.20.1.1 104.21.1.1 104.22.1.1 104.24.1.1 104.25.1.1 104.26.1.1 104.27.1.1 172.64.1.1 172.65.1.1 172.66.1.1 172.67.1.1 162.159.1.1"

FALLBACK_CIDRS="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"

usage() {
  cat <<'EOF'
Cloudflare entry IP checker for Termux/proot.

It checks whether Cloudflare candidate IPs can reach your Worker/custom domain
using HTTPS with correct Host/SNI behavior through curl --connect-to.
This is better than ICMP ping for VLESS WS TLS testing.

Usage:
  bash tools/cf-ip-checker.sh -d DOMAIN [options]

Required:
  -d, --domain DOMAIN       Worker/custom domain, for example worker.example.com

Options:
  -p, --path PATH           Test path. Default: /health
  --ports LIST              Comma-separated ports. Default: 443
  -f, --file FILE           Candidate IP file, one IP per line
  -r, --rounds N            Attempts per IP:port. Default: 1
  -j, --concurrency N       Parallel IP:port tests. Default: 12
  -n, --top N               Number of best IPs to print. Default: 10
  --connect-timeout SEC     Curl connect timeout. Default: 2
  --max-time SEC            Curl total timeout. Default: 5
  --timeout SEC             Alias for --max-time
  --random N                Add N random IPs from Cloudflare IPv4 ranges
  --random-only N           Use only N random Cloudflare IPv4 IPs
  --ranges-url URL          IPv4 CIDR list URL. Default: Cloudflare ips-v4
  -o, --output FILE         CSV output file. Default: cf-ip-results.csv
  --uuid UUID               Also print ready /sub?ips=... URL
  -h, --help                Show help

Fast examples:
  bash tools/cf-ip-checker.sh -d worker.example.com -j 16 --timeout 4
  bash tools/cf-ip-checker.sh -d worker.example.com --ports 443,8443,2053 -j 24 -r 1 --timeout 4 -n 10
  bash tools/cf-ip-checker.sh -d worker.example.com --random-only 100 -j 32 --timeout 4 -n 10
  bash tools/cf-ip-checker.sh -d worker.example.com --random 200 -j 32 --uuid 86c50e3a-5b87-49dd-bd20-03c7f2735e40
EOF
}

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
num_or_die() { case "$2" in ''|*[!0-9]*) die "$1 must be a number" ;; esac; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -d|--domain) DOMAIN="${2:-}"; shift 2 ;;
    -p|--path) PATH_TO_TEST="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    -f|--file) IP_FILE="${2:-}"; shift 2 ;;
    -r|--rounds) ROUNDS="${2:-}"; shift 2 ;;
    -j|--concurrency) CONCURRENCY="${2:-}"; shift 2 ;;
    -n|--top) TOP="${2:-}"; shift 2 ;;
    --connect-timeout) CONNECT_TIMEOUT="${2:-}"; shift 2 ;;
    --max-time|--timeout) MAX_TIME="${2:-}"; shift 2 ;;
    --random) RANDOM_COUNT="${2:-}"; shift 2 ;;
    --random-only) RANDOM_ONLY="true"; RANDOM_COUNT="${2:-}"; shift 2 ;;
    --ranges-url) RANGES_URL="${2:-}"; shift 2 ;;
    -o|--output) OUT="${2:-}"; shift 2 ;;
    --uuid) UUID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

need curl
need awk
need sort
need grep
need sed
need mkfifo

[ -n "$DOMAIN" ] || { usage; exit 1; }
case "$PATH_TO_TEST" in /*) ;; *) PATH_TO_TEST="/$PATH_TO_TEST" ;; esac
num_or_die rounds "$ROUNDS"
num_or_die concurrency "$CONCURRENCY"
num_or_die top "$TOP"
num_or_die random "$RANDOM_COUNT"
[ "$CONCURRENCY" -gt 0 ] || die "concurrency must be greater than 0"
[ "$ROUNDS" -gt 0 ] || die "rounds must be greater than 0"

base="${TMPDIR:-/tmp}/cfip.$$"
tmp_ips="$base.ips"
tmp_jobs="$base.jobs"
tmp_out="$base.out"
fifo="$base.fifo"
trap 'rm -f "$tmp_ips" "$tmp_jobs" "$tmp_out" "$fifo"' EXIT

fetch_ranges() {
  ranges="$(curl -fsSL --connect-timeout 3 --max-time 8 "$RANGES_URL" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' || true)"
  if [ -n "$ranges" ]; then
    printf '%s\n' "$ranges"
  else
    for cidr in $FALLBACK_CIDRS; do echo "$cidr"; done
  fi
}

generate_random_ips() {
  n="$1"
  [ "$n" -gt 0 ] || return 0
  fetch_ranges | awk -v n="$n" '
    function ip2int(ip, a) { split(ip,a,"."); return a[1]*16777216+a[2]*65536+a[3]*256+a[4] }
    function int2ip(x, a,b,c,d) { a=int(x/16777216); x%=16777216; b=int(x/65536); x%=65536; c=int(x/256); d=x%256; return a"."b"."c"."d }
    function pow2(e, r,i) { r=1; for(i=0;i<e;i++) r*=2; return r }
    BEGIN { srand(systime()+PROCINFO["pid"]) }
    /^[0-9.]+\/[0-9]+$/ {
      split($0,p,"/"); cidr[++c]=$0; base[c]=ip2int(p[1]); mask[c]=p[2]
    }
    END {
      if (c < 1) exit
      for (i=0; i<n; i++) {
        idx=1+int(rand()*c)
        size=pow2(32-mask[idx])
        if (size <= 2) off=0; else off=1+int(rand()*(size-2))
        print int2ip(base[idx]+off)
      }
    }'
}

if [ "$RANDOM_ONLY" = "true" ]; then
  : > "$tmp_ips"
elif [ -n "$IP_FILE" ]; then
  [ -f "$IP_FILE" ] || die "IP file not found: $IP_FILE"
  sed 's/#.*//' "$IP_FILE" | awk '{$1=$1} /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print}' > "$tmp_ips"
else
  for ip in $DEFAULT_IPS; do echo "$ip"; done > "$tmp_ips"
fi

generate_random_ips "$RANDOM_COUNT" >> "$tmp_ips"
sort -u "$tmp_ips" -o "$tmp_ips"

count="$(wc -l < "$tmp_ips" | awk '{print $1}')"
[ "$count" -gt 0 ] || die "no IP candidates"

: > "$tmp_jobs"
IFS_OLD="$IFS"
IFS=','
set -- $PORTS
IFS="$IFS_OLD"
while read -r ip; do
  for port in "$@"; do
    port="$(echo "$port" | awk '{$1=$1;print}')"
    [ -n "$port" ] || continue
    case "$port" in *[!0-9]*) continue ;; esac
    echo "$ip $port" >> "$tmp_jobs"
  done
done < "$tmp_ips"

job_count="$(wc -l < "$tmp_jobs" | awk '{print $1}')"
[ "$job_count" -gt 0 ] || die "no IP:port jobs"

mkfifo "$fifo"
cat > "$tmp_out" <<'EOF'
ip,port,ok,fail,avg_ms,best_ms,last_code
EOF

echo "Testing $count IPs / $job_count IP:port jobs for $DOMAIN$PATH_TO_TEST" >&2
echo "ports=$PORTS rounds=$ROUNDS concurrency=$CONCURRENCY connect_timeout=$CONNECT_TIMEOUT max_time=$MAX_TIME" >&2

test_ip_port() {
  ip="$1"
  port="$2"
  ok=0
  fail=0
  sum="0"
  best="999999"
  last_code="000"
  if [ "$port" = "443" ]; then
    url="https://$DOMAIN$PATH_TO_TEST"
  else
    url="https://$DOMAIN:$port$PATH_TO_TEST"
  fi
  connect_to="$DOMAIN:$port:$ip:$port"
  i=1
  while [ "$i" -le "$ROUNDS" ]; do
    r="$(curl -sS -o /dev/null --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" --connect-to "$connect_to" -w '%{http_code} %{time_total}' "$url" 2>/dev/null || true)"
    code="$(echo "$r" | awk '{print $1}')"
    total="$(echo "$r" | awk '{print $2}')"
    [ -n "$code" ] || code="000"
    [ -n "$total" ] || total="0"
    last_code="$code"
    if [ "$code" = "200" ]; then
      ok=$((ok + 1))
      sum="$(awk -v a="$sum" -v b="$total" 'BEGIN{printf "%.6f", a+b}')"
      best="$(awk -v a="$best" -v b="$total" 'BEGIN{if(b<a) printf "%.6f", b; else printf "%.6f", a}')"
    else
      fail=$((fail + 1))
    fi
    i=$((i + 1))
  done
  if [ "$ok" -gt 0 ]; then
    avg_ms="$(awk -v s="$sum" -v n="$ok" 'BEGIN{printf "%.0f", (s/n)*1000}')"
    best_ms="$(awk -v s="$best" 'BEGIN{printf "%.0f", s*1000}')"
    echo "$ip,$port,$ok,$fail,$avg_ms,$best_ms,$last_code" > "$fifo"
  else
    echo "." > "$fifo"
  fi
}

collector() {
  done_count=0
  while [ "$done_count" -lt "$job_count" ]; do
    if IFS= read -r line < "$fifo"; then
      if [ "$line" = "." ]; then
        printf '.' >&2
      else
        printf '+' >&2
        echo "$line" >> "$tmp_out"
      fi
      done_count=$((done_count + 1))
    fi
  done
}
collector &
collector_pid=$!

running=0
while read -r ip port; do
  test_ip_port "$ip" "$port" &
  running=$((running + 1))
  if [ "$running" -ge "$CONCURRENCY" ]; then
    wait -n 2>/dev/null || wait
    running=$((running - 1))
  fi
done < "$tmp_jobs"
wait
wait "$collector_pid" 2>/dev/null || true
printf '\n' >&2

{
  head -n 1 "$tmp_out"
  tail -n +2 "$tmp_out" | sort -t, -k5,5n -k6,6n
} > "$OUT"

echo "Best results:"
printf '%-16s %-6s %-4s %-5s %-7s %-7s %-5s\n' IP PORT OK FAIL AVG_MS BEST_MS HTTP
tail -n +2 "$OUT" | awk -F, -v top="$TOP" '{printf "%-16s %-6s %-4s %-5s %-7s %-7s %-5s\n", $1,$2,$3,$4,$5,$6,$7; if(++n>=top) exit}'

best_ips="$(tail -n +2 "$OUT" | awk -F, -v top="$TOP" '!seen[$1]++ {printf sep $1; sep=","; if(++n>=top) exit}')"

echo
echo "Saved CSV: $OUT"
echo "Best IPs CSV:"
echo "$best_ips"

if [ -n "$UUID" ] && [ -n "$best_ips" ]; then
  echo
  echo "Subscription URL with best IPs:"
  echo "https://$DOMAIN/$UUID/sub?ips=$best_ips&count=$TOP"
fi
