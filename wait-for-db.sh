#!/bin/sh
# Wait for database to be ready

set -e

host="$1"
shift
port="$1"
shift

echo "Waiting for database at $host:$port to be ready..."

until nc -z "$host" "$port"; do
  echo "Database is unavailable - sleeping"
  sleep 1
done

echo "Database is ready - executing command"
exec "$@"
