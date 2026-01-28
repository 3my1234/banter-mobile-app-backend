#!/bin/sh

# usage: ./wait-for-db.sh host:port [-- command args]

hostport="$1"
shift # remove host:port from arguments

# If the next argument is "--", skip it
if [ "$1" = "--" ]; then
  shift
fi

host=$(echo $hostport | cut -d: -f1)
port=$(echo $hostport | cut -d: -f2)

echo "Waiting for database at $host:$port..."

while ! nc -z "$host" "$port"; do
  echo "Database is unavailable - sleeping"
  sleep 2
done

echo "Database is up - executing command: $@"
exec "$@"
