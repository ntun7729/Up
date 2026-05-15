#!/usr/bin/env bash
set -u

DOMAIN=""
PATH_TO_TEST="/health"
PORTS="443"
ROUNDS="2"
TOP="10"
CONNECT_TIMEOUT="3"
MAX_TIME="8"
IP_FILE=""
OUT="cf-ip-results.csv"
UUID=""

DEFAULT_IPS="104.16.0.0 104.17.0.0 104.18.0.0 104.19.0.0 104.20.0.0 104.21.0.0 104.22.0.0 104.24.0.0 104.25.0.0 104.26.0.0 104.27.0.0 172.64.0.0 172.65.0.0 172.66.0.0 172.67.0.0 162.159.0.0 104.16.1.1 104.17.1.1 104.18.1.1 104.19.1.1 104.20.1.1 104.21.1.1 104.22.1.1 104.24.1.1 104.25.1.1 104.26.1.1 104.27.1.1 172.64.1.1 172.65.1.1 172.66.1.1 172.67.1.1 162.159.1.1"

usage() {
  cat <<'EOF'
Cloudflare entry IP checker for Termux/proot.

It checks whether Cloudflare candidate IPs can reach your Worker/custom domain
using HTTPS with the correct Host/SNI behavior through curl --connect-to.
This is better than ICMP ping for VLESS WS TLS testing.

Usage:
  bash tools/cf-ip-checker.sh -d DOMAIN [options]

Required:
  -d, --domain DOMAIN       Worker/custom domain, for example worker.example.com

Options:
  -p, --path PATH           Test path. Default: /health
  --ports LIST              Comma-separated ports. Default: 443
  -f, --file FILE           Candidate IP file, one IP per line
  -r, --rounds N            Attempts per IP:port. Default: 2
  -n, --top N               Number of best IPs to print. Default: 10
  --connect-timeout SEC     Curl connect timeout. Default: 3
  --max-time SEC            Curl total timeout. Default: 8
  -o, --output FILE         CSV output file. Default: cf-ip-results.csv
  --uuid UUID               Also print ready /sub?ips=... URL
  -h, --help                Show help

Examples:
  bash tools/cf-ip-checker.sh -d worker.example.com
  bash tools/cf-ip-checker.sh -d worker.example.com --ports 443,8443,2053 -n 10
  bash tools/cf-ip-checker.sh -d worker.example.com -f my-ips.txt --uuid 86c50e3a-5b87-49dd-bd20-03c7f2735e40
EOF
}

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -d|--domain) DOMAIN="${2:-}"; shift 2 ;;
    -p|--path) PATH_TO_TEST="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    -f|--file) IP_FILE="${2:-}"; shift 2 ;;
    -r|--rounds) ROUNDS="${2:-}"; shift 2 ;;
    -n|--top) TOP="${2:-}"; shift 2 ;;
    --connect-timeout) CONNECT_TIMEOUT="${2:-}"; shift 2 ;;
    --max-time) MAX_TIME="${2:-}"; shift 2 ;;
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

[ -n "$DOMAIN" ] || { usage; exit 1; }
case "$PATH_TO_TEST" in /*) ;; *) PATH_TO_TEST="/$PATH_TO_TEST" ;; esac

tmp_ips="${TMPDIR:-/tmp}/cf-ips.$$"
tmp_out="${TMPDIR:-/tmp}/cf-out.$$"
trap 'rm -f "$tmp_ips" "$tmp_out"' EXIT

if [ -n "$IP_FILE" ]; then
  [ -f "$IP_FILE" ] || die "IP file not found: $IP_FILE"
  sed 's/#.*//' "$IP_FILE" | awk '{$1=$1} /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print}' | sort -u > "$tmp_ips"
else
  for ip in $DEFAULT_IPS; do echo "$ip"; done | sort -u > "$tmp_ips"
fi

count="$(wc -l < "$tmp_ips" | awk '{print $1}')"
[ "$count" -gt 0 ] || die "no IP candidates"

echo "ip,port,ok,fail,avg_ms,best_ms,last_code" > "$tmp_out"

echo "Testing $count IPs for $DOMAIN$PATH_TO_TEST on ports $PORTS" >&2

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
    echo "$ip,$port,$ok,$fail,$avg_ms,$best_ms,$last_code" >> "$tmp_out"
  fi
}

IFS_OLD="$IFS"
IFS=','
set -- $PORTS
IFS="$IFS_OLD"

while read -r ip; do
  for port in "$@"; do
    port="$(echo "$port" | awk '{$1=$1;print}')"
    [ -n "$port" ] || continue
    test_ip_port "$ip" "$port"
    printf '.' >&2
  done
done < "$tmp_ips"
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
