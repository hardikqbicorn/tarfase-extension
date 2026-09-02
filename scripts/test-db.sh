#!/usr/bin/env bash
#
# Runs the integration suite against a real PostgreSQL database.
#
# Without this, `npm test` still runs the integration tests - they fall back to
# an in-memory store with the same idempotency semantics. This script exercises
# the actual schema: partition routing, the (event_id, timestamp) unique
# constraint, and JSONB round-tripping.
#
# Usage:
#   ./scripts/test-db.sh                       # start a throwaway database, test, tear down
#   TEST_DATABASE_URL=postgres://... npm run test:integration   # use your own
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGPORT="${PGPORT:-55432}"
PGDATA_DIR="${PGDATA_DIR:-/tmp/ide-collector-testdb}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DBNAME=ide_events

if [ ! -x "${PGBIN}/initdb" ]; then
  echo "!! PostgreSQL binaries not found at ${PGBIN}" >&2
  echo "   Set PGBIN, or run the suite against Docker Compose:" >&2
  echo "     docker compose up -d postgres" >&2
  echo "     TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ide_events npm run test:integration" >&2
  exit 1
fi

# PostgreSQL refuses to run as root. CI containers often are root, so when that
# is the case the server commands are run as an unprivileged helper user
# instead of failing outright.
PG_RUN_AS=""
if [ "$(id -u)" -eq 0 ]; then
  PG_USER="${PG_USER:-ide-collector-test}"
  if ! id "${PG_USER}" >/dev/null 2>&1; then
    echo "==> Running as root; creating unprivileged user ${PG_USER} to own the server"
    useradd -m "${PG_USER}" >/dev/null 2>&1 || {
      echo "!! Could not create ${PG_USER}. Re-run as a non-root user." >&2
      exit 1
    }
  fi
  PG_RUN_AS="${PG_USER}"
fi

# Runs a server command, dropping privileges when the script is running as root.
run_pg() {
  if [ -n "${PG_RUN_AS}" ]; then
    su "${PG_RUN_AS}" -c "$*"
  else
    eval "$*"
  fi
}

cleanup() {
  run_pg "${PGBIN}/pg_ctl -D ${PGDATA_DIR} stop -m fast" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Initializing throwaway cluster at ${PGDATA_DIR}"
rm -rf "${PGDATA_DIR}"
mkdir -p "${PGDATA_DIR}"
[ -n "${PG_RUN_AS}" ] && chown -R "${PG_RUN_AS}" "${PGDATA_DIR}"
run_pg "${PGBIN}/initdb -D ${PGDATA_DIR} -U postgres --auth=trust" >/dev/null

echo "==> Starting PostgreSQL on port ${PGPORT}"
# unix_socket_directories points into PGDATA because /var/run/postgresql is
# often not writable by the user running the tests.
run_pg "${PGBIN}/pg_ctl -D ${PGDATA_DIR} \
  -o '-p ${PGPORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${PGDATA_DIR}' \
  -l ${PGDATA_DIR}/server.log start" >/dev/null

# pg_ctl returns before the server accepts connections.
for _ in $(seq 1 30); do
  if "${PGBIN}/pg_isready" -h 127.0.0.1 -p "${PGPORT}" -q; then break; fi
  sleep 1
done

echo "==> Creating database and applying migrations"
psql -h 127.0.0.1 -p "${PGPORT}" -U postgres -q -c "CREATE DATABASE ${DBNAME};"
for migration in "${REPO_ROOT}"/database/supabase/migrations/*.sql; do
  echo "    $(basename "${migration}")"
  psql -h 127.0.0.1 -p "${PGPORT}" -U postgres -d "${DBNAME}" -v ON_ERROR_STOP=1 -q -f "${migration}"
done

echo "==> Running integration tests against real PostgreSQL"
cd "${REPO_ROOT}"
TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${DBNAME}" \
  npx vitest run tests/integration

echo "==> Done"
