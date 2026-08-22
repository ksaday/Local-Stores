#!/bin/sh
# Writes PgBouncer's configuration from the environment, then becomes it.
#
# Generated at start rather than baked into the image because the parts that
# vary — the RDS endpoint, the password — are per-environment and one of them
# is a secret. A configuration file with a password in it must not exist in a
# layer that gets pushed to a registry.
set -eu

: "${PGB_HOST:?RDS endpoint required}"
: "${PGB_USER:?database user required}"
: "${PGB_PASSWORD:?database password required}"
PGB_PORT="${PGB_PORT:-5432}"
PGB_DATABASE="${PGB_DATABASE:-bba}"

# tmpfs, so neither file is ever written to a layer or a volume.
CONF_DIR=/tmp/pgbouncer
mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"

# PgBouncer computes the SCRAM verifier itself from a plaintext entry, so the
# client handshake is scram-sha-256 even though this file holds the password.
printf '"%s" "%s"\n' "$PGB_USER" "$PGB_PASSWORD" > "$CONF_DIR/userlist.txt"
chmod 600 "$CONF_DIR/userlist.txt"

cat > "$CONF_DIR/pgbouncer.ini" <<INI
[databases]
${PGB_DATABASE} = host=${PGB_HOST} port=${PGB_PORT} dbname=${PGB_DATABASE}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432

auth_type = scram-sha-256
auth_file = ${CONF_DIR}/userlist.txt

; The entire reason this exists. Transaction pooling returns a connection to
; the pool at COMMIT, so N application connections multiplex onto far fewer
; server connections. It is safe here only because every RLS setting this
; codebase writes is transaction-local — see tenant-isolation.test.ts, which
; fails if that ever changes.
pool_mode = transaction

; What the application may open, and what reaches Postgres. The ratio is the
; point: §14.4 puts 20 API tasks at 10 Prisma connections each, which is 200
; connections that would otherwise land on RDS directly.
max_client_conn = ${PGB_MAX_CLIENT_CONN:-2000}
default_pool_size = ${PGB_DEFAULT_POOL_SIZE:-25}
reserve_pool_size = ${PGB_RESERVE_POOL_SIZE:-5}
reserve_pool_timeout = 3

; Prepared statements are disabled, and the application knows: its connection
; string carries ?pgbouncer=true, which is how Prisma is told not to use them.
; PgBouncer 1.21 can track them in transaction mode, but the documented Prisma
; path is the one with fewer ways to be subtly wrong.
max_prepared_statements = 0

; node-postgres sends extra_float_digits in its startup packet. PgBouncer
; rejects unknown startup parameters by default, so without this every
; connection fails immediately with a message that does not mention it.
ignore_startup_parameters = extra_float_digits,options

; TLS to RDS. The data subnets have no route to the internet, but encryption
; in transit inside the VPC is what §14.8 asks for end to end.
server_tls_sslmode = require

; Shorter than RDS's own idle timeout so PgBouncer closes connections rather
; than discovering they are already gone.
server_idle_timeout = 240
server_lifetime = 3600

; A query that runs longer than this is cancelled. Above the 600ms write SLO
; by a wide margin, and below the point where a stuck query holds a pool slot
; for the rest of the day.
query_wait_timeout = 30

log_connections = 0
log_disconnections = 0
stats_period = 60
INI

exec pgbouncer "$CONF_DIR/pgbouncer.ini"
