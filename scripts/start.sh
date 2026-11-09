#!/usr/bin/env bash
# Start the reconstruction bridge and the EiDOlON editor together.
# The Training tab connects to http://127.0.0.1:8787 when that port answers.
# Processes that are already listening are left alone. Ctrl-C stops only
# the processes this script started.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_PORT="${PORT:-8787}"
EDITOR_PORT="${EIDOLON_PORT:-5174}"

STARTED_BRIDGE=
STARTED_EDITOR=

cleanup() {
    local status=$?
    if [[ -n "${STARTED_BRIDGE}" ]]; then
        kill -- "-${STARTED_BRIDGE}" 2>/dev/null || kill "${STARTED_BRIDGE}" 2>/dev/null || true
    fi
    if [[ -n "${STARTED_EDITOR}" ]]; then
        kill -- "-${STARTED_EDITOR}" 2>/dev/null || kill "${STARTED_EDITOR}" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    exit "${status}"
}
trap cleanup INT TERM

bridge_health() {
    curl -sf -m 2 "http://localhost:${BRIDGE_PORT}/health" >/dev/null
}

editor_title() {
    curl -sf -m 2 "http://localhost:${1}/" 2>/dev/null | grep -o '<title>[^<]*</title>' || true
}

# Own process groups so Ctrl-C reaches npm's node child.
set -m

if bridge_health; then
    echo "Reconstruction bridge already on http://localhost:${BRIDGE_PORT}"
else
    echo "Starting reconstruction bridge on http://localhost:${BRIDGE_PORT}"
    (
        cd "${ROOT}/tools/reconstruction-server"
        exec npm start
    ) &
    STARTED_BRIDGE=$!
    ready=
    for _ in $(seq 1 40); do
        if bridge_health; then
            ready=1
            break
        fi
        if ! kill -0 "${STARTED_BRIDGE}" 2>/dev/null; then
            echo "Reconstruction bridge exited before it was healthy."
            exit 1
        fi
        sleep 0.25
    done
    if [[ -z "${ready}" ]]; then
        echo "Reconstruction bridge did not answer on port ${BRIDGE_PORT}."
        exit 1
    fi
fi

EDITOR_URL="http://localhost:${EDITOR_PORT}/"
title="$(editor_title "${EDITOR_PORT}")"
if [[ "${title}" == "<title>EiDOlON</title>" ]]; then
    echo "EiDOlON already at ${EDITOR_URL}"
elif [[ -n "${title}" ]]; then
    echo "Port ${EDITOR_PORT} is in use by ${title}, not EiDOlON."
    echo "Stop that process or set EIDOLON_PORT to a free port."
    exit 1
else
    echo "Starting EiDOlON on ${EDITOR_URL}"
    (
        cd "${ROOT}/app"
        exec npm run dev -- --port "${EDITOR_PORT}" --strictPort
    ) &
    STARTED_EDITOR=$!
    ready=
    for _ in $(seq 1 40); do
        if [[ "$(editor_title "${EDITOR_PORT}")" == "<title>EiDOlON</title>" ]]; then
            ready=1
            break
        fi
        if ! kill -0 "${STARTED_EDITOR}" 2>/dev/null; then
            echo "EiDOlON exited before it was ready."
            exit 1
        fi
        sleep 0.25
    done
    if [[ -z "${ready}" ]]; then
        echo "EiDOlON did not answer on port ${EDITOR_PORT}."
        exit 1
    fi
fi

echo "Open ${EDITOR_URL}"
echo "Training connects to http://localhost:${BRIDGE_PORT} when you open Create splat."
if [[ "$(uname)" == "Darwin" ]]; then
    open "${EDITOR_URL}" || true
fi

if [[ -n "${STARTED_BRIDGE}" || -n "${STARTED_EDITOR}" ]]; then
    echo "Ctrl-C stops the processes this script started."
    wait
fi
