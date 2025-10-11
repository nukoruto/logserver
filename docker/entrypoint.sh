#!/bin/sh
set -eu

DEFAULT_ADA_DEVICE="${GPU_DEVICE_MAP_ADA6000:-0}"
DEFAULT_4060_DEVICE="${GPU_DEVICE_MAP_4060:-1}"
DEFAULT_DEVICE="${GPU_DEVICE_MAP_DEFAULT:-${DEFAULT_ADA_DEVICE}}"

case "${GPU_MODE:-ada6000}" in
  ada6000)
    export CUDA_VISIBLE_DEVICES="${DEFAULT_ADA_DEVICE}"
    ;;
  4060)
    export CUDA_VISIBLE_DEVICES="${DEFAULT_4060_DEVICE}"
    ;;
  none|disabled|cpu)
    unset CUDA_VISIBLE_DEVICES
    ;;
  *)
    echo "[entrypoint] Unknown GPU_MODE '${GPU_MODE}'. Falling back to default device." >&2
    export CUDA_VISIBLE_DEVICES="${DEFAULT_DEVICE}"
    ;;
esac

if [ -n "${LOG_DIR:-}" ] && [ ! -d "${LOG_DIR}" ]; then
  mkdir -p "${LOG_DIR}"
fi

exec "$@"
