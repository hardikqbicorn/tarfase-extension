#!/usr/bin/env bash
#
# Creates the platform's Kafka topics. Idempotent: re-running is a no-op, so
# this is safe to leave in `docker compose up`.
#
# Partition counts govern the maximum consumer parallelism for each topic.
# Events are keyed by installation_id, so a single installation's events always
# land on one partition and keep their relative order; scaling out means adding
# partitions and consumer instances, not changing the schema.
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:29092}"

# Retention:
#   raw       - 7 days. The database is the system of record; the raw topic only
#               needs to cover replay after an outage.
#   processed - 3 days. Downstream consumers (enrichment, analytics) are
#               expected to keep up.
#   errors    - 30 days. Dead letters need a long window for investigation.
create_topic() {
  local name="$1" partitions="$2" retention_ms="$3"

  echo "==> Creating topic ${name} (partitions=${partitions}, retention=${retention_ms}ms)"
  kafka-topics.sh \
    --bootstrap-server "${BOOTSTRAP}" \
    --create \
    --if-not-exists \
    --topic "${name}" \
    --partitions "${partitions}" \
    --replication-factor 1 \
    --config "retention.ms=${retention_ms}" \
    --config "compression.type=producer" \
    --config "min.insync.replicas=1"
}

echo "==> Waiting for Kafka at ${BOOTSTRAP}"
for attempt in $(seq 1 30); do
  if kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" --list >/dev/null 2>&1; then
    echo "==> Kafka is reachable"
    break
  fi
  if [ "${attempt}" -eq 30 ]; then
    echo "!! Kafka did not become reachable in time" >&2
    exit 1
  fi
  sleep 2
done

create_topic "ide.events.raw"       6  604800000   # 7 days
create_topic "ide.events.processed" 6  259200000   # 3 days
create_topic "ide.events.errors"    3  2592000000  # 30 days

echo "==> Topics now present:"
kafka-topics.sh --bootstrap-server "${BOOTSTRAP}" --list
