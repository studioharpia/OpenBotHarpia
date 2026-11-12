#!/bin/sh
set -eu
# Only infrastructure-owned secrets are accepted; no eval and no secret is written to stdout.
if [ -n "${EMAIL_SMTP_PASSWORD_FILE:-}" ]; then
  export EMAIL_SMTP_PASSWORD="$(cat "$EMAIL_SMTP_PASSWORD_FILE")"
fi
if [ -n "${REMOTE_SESSION_SECRET_FILE:-}" ]; then
  export REMOTE_SESSION_SECRET="$(cat "$REMOTE_SESSION_SECRET_FILE")"
fi
if [ -n "${REMOTE_AUTH_WEBHOOK_SECRET_FILE:-}" ]; then
  export REMOTE_AUTH_WEBHOOK_SECRET="$(cat "$REMOTE_AUTH_WEBHOOK_SECRET_FILE")"
fi
if [ -n "${REMOTE_METRICS_TOKEN_FILE:-}" ]; then
  export REMOTE_METRICS_TOKEN="$(cat "$REMOTE_METRICS_TOKEN_FILE")"
fi
if [ -n "${TURN_SHARED_SECRET_FILE:-}" ]; then
  export TURN_SHARED_SECRET="$(cat "$TURN_SHARED_SECRET_FILE")"
fi
exec "$@"
