"""Utility script to ensure JWT_HMAC_KEY is not using the insecure default value.

This script inspects environment variables and an optional .env file to verify
that JWT_HMAC_KEY has been customized from the known seed used for fixtures.
It exits with status code 1 when the insecure default is detected so CI can
block deployments that rely on the placeholder secret.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Dict

DEFAULT_JWT_KEY = "c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY="


def parse_env_file(path: Path) -> Dict[str, str]:
    """Parse a simple KEY=VALUE .env file into a dictionary."""
    values: Dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        values[key] = value
    return values


def check_value(source: str, value: str) -> None:
    if value == DEFAULT_JWT_KEY:
        raise SystemExit(
            f"ERROR: {source} contains the insecure default JWT_HMAC_KEY. "
            "Generate a new base64 secret (>=128 bits) and update the configuration."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify JWT_HMAC_KEY is customized")
    parser.add_argument(
        "--env-file",
        default=".env",
        type=Path,
        help="Path to .env file to inspect (default: ./.env)",
    )
    args = parser.parse_args()

    env_values = parse_env_file(args.env_file)

    env_var = os.environ.get("JWT_HMAC_KEY")
    if env_var:
        check_value("environment variable JWT_HMAC_KEY", env_var)

    file_value = env_values.get("JWT_HMAC_KEY")
    if file_value:
        check_value(f"{args.env_file}", file_value)

    if not env_var and "JWT_HMAC_KEY" not in env_values:
        print(
            "WARNING: JWT_HMAC_KEY is not defined in environment or .env file.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
