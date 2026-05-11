#!/bin/sh
set -eu

: "${POSTGRES_DB:=backend_playground}"
: "${POSTGRES_USER:=playground}"
: "${POSTGRES_PASSWORD:=CHANGE_ME_POSTGRES_PASSWORD}"
: "${PGBOUNCER_MAX_CLIENT_CONN:=1000}"
: "${PGBOUNCER_DEFAULT_POOL_SIZE:=40}"
: "${PGBOUNCER_MIN_POOL_SIZE:=5}"
: "${PGBOUNCER_RESERVE_POOL_SIZE:=10}"

printf '"%s" "%s"\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" > /tmp/userlist.txt
envsubst < /etc/pgbouncer/pgbouncer.ini.template > /tmp/pgbouncer.ini

exec pgbouncer /tmp/pgbouncer.ini
