#!/bin/bash
# First-boot database bootstrap for the pgvector image (runs in POSTGRES_DB=governance).
# Creates the extra platform databases from katip.config.yaml
# (services.postgres.databases) with dedicated owners. Passwords are passed
# via KC_DB_PASSWORD / LITELLM_DB_PASSWORD env (injected by compose from katip.env).
set -euo pipefail

create_db_with_owner() {
  local db="$1" owner="$2" password="$3"
  # dollar-quote the password: $pg$...$pg$ (never conflicts with base64url secrets)
  local dq="\$pg\$${password}\$pg\$"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE ROLE ${owner} LOGIN PASSWORD ${dq}' WHERE NOT EXISTS
      (SELECT FROM pg_roles WHERE rolname = '${owner}')\gexec
    SELECT 'CREATE DATABASE ${db} OWNER ${owner}' WHERE NOT EXISTS
      (SELECT FROM pg_database WHERE datname = '${db}')\gexec
EOSQL
}

create_db_with_owner keycloak keycloak "${KC_DB_PASSWORD:?KC_DB_PASSWORD must be set}"
create_db_with_owner litellm litellm "${LITELLM_DB_PASSWORD:?LITELLM_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
