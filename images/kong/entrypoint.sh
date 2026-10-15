#!/bin/sh
set -eu

if [ "$#" -ge 2 ] && [ "$1" = kong ] && [ "$2" = docker-start ]; then
    shift 2
    kong prepare -p "$KONG_PREFIX" "$@"
    # A restarted container can retain sockets from an unclean shutdown.
    find "$KONG_PREFIX/sockets" -maxdepth 1 -type s -delete
    exec nginx -p "$KONG_PREFIX" -c nginx.conf
fi

exec "$@"
