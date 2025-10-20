import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.audit_missing import audit_file, compute_completeness  # type: ignore


REQUIRED_COLUMNS = [
    "timestamp_utc",
    "method",
    "path",
    "referer",
    "user_agent",
    "ip",
    "cookie",
    "session_id",
    "op_category",
    "uid",
]


def _make_dataframe() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp_utc": [1704067200, 1704067260],
            "method": ["POST", "GET"],
            "path": ["/auth/login", "/dashboard"],
            "referer": ["", ""],
            "user_agent": ["ua", "ua"],
            "ip": ["127.0.0.1", "127.0.0.2"],
            "cookie": [
                "sid=ffffffffffffffffffffffffffffffff.001; Path=/; HttpOnly; Secure",
                "sid=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.002; Path=/; HttpOnly; Secure",
            ],
            "session_id": ["sess-1", "sess-2"],
            "op_category": ["AUTH", "READ"],
            "uid": [
                "ffffffffffffffffffffffffffffffff",
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            ],
        }
    )


def test_compute_completeness_all_present() -> None:
    df = _make_dataframe()
    completeness = compute_completeness(df, REQUIRED_COLUMNS)
    assert all(stats["completeness"] == 1.0 for stats in completeness.values())


def test_audit_file_enforces_completeness(tmp_path: Path) -> None:
    df = _make_dataframe()
    csv_path = tmp_path / "logs.csv"
    df.to_csv(csv_path, index=False)
    output = tmp_path / "completeness.json"
    result = audit_file(csv_path, ROOT / "schemas" / "log_schema_v2.yaml", output)
    assert output.exists()
    assert result["uid"]["completeness"] == 1.0

    df_missing = df.copy()
    df_missing.loc[0, "cookie"] = "null"
    df_missing.to_csv(csv_path, index=False)
    with pytest.raises(SystemExit):
        audit_file(csv_path, ROOT / "schemas" / "log_schema_v2.yaml", output)
