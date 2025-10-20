"""SPOT (POT/GPD) based threshold estimation."""

from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import numpy as np

from . import ThresholdConfig, _hash_values

try:  # SciPy is optional but recommended
    from scipy.optimize import minimize
except Exception:  # pragma: no cover - SciPy absent fallback
    minimize = None  # type: ignore[assignment]


def _gpd_neg_log_likelihood(params: np.ndarray, excesses: np.ndarray) -> float:
    xi = float(params[0])
    beta = float(math.exp(params[1]))
    if beta <= 0.0:
        return math.inf
    scaled = 1.0 + xi * (excesses / beta)
    if np.any(scaled <= 0.0):
        return math.inf
    if abs(xi) < 1e-12:
        return excesses.size * math.log(beta) + excesses.sum() / beta
    return excesses.size * math.log(beta) + (1.0 + 1.0 / xi) * np.log(scaled).sum()


def fit_gpd_mle(excesses: np.ndarray) -> Tuple[float, float, Dict[str, float]]:
    if excesses.size == 0:
        raise ValueError("excesses must not be empty")
    mean_excess = float(np.mean(excesses))
    var_excess = float(np.var(excesses))
    if var_excess <= 0:
        xi_init = 0.0
        beta_init = mean_excess
    else:
        xi_init = max(-0.49, 0.5 * ((mean_excess ** 2) / var_excess - 1.0))
        beta_init = max(1e-6, 0.5 * mean_excess * (((mean_excess ** 2) / var_excess) + 1.0))
    x0 = np.array([xi_init, math.log(beta_init)], dtype=np.float64)

    if minimize is None:
        xi = float(np.clip(xi_init, -0.49, 10.0))
        beta = float(max(beta_init, 1e-6))
        return xi, beta, {"solver": "moments"}

    result = minimize(
        _gpd_neg_log_likelihood,
        x0,
        args=(excesses,),
        method="L-BFGS-B",
        bounds=[(-0.49, 10.0), (-20.0, 20.0)],
    )
    if not result.success:
        xi = float(np.clip(xi_init, -0.49, 10.0))
        beta = float(max(beta_init, 1e-6))
        return xi, beta, {"solver": "moments", "warning": result.message}

    xi = float(result.x[0])
    beta = float(math.exp(result.x[1]))
    return xi, beta, {"solver": "mle", "nfev": result.nfev, "njev": getattr(result, "njev", None)}


def spot_threshold(
    values: np.ndarray,
    config: ThresholdConfig,
    *,
    side: str,
) -> Tuple[Optional[float], Optional[float], Dict[str, float], Optional[str]]:
    if values.size == 0:
        return None, None, {"status": "skipped", "reason": "empty_values"}, "empty_values"

    calib_size = int(math.ceil(values.size * float(config.calib_frac)))
    calib_size = min(max(calib_size, config.min_exceed + 1), values.size)
    calib = np.asarray(values[:calib_size], dtype=np.float64)

    def _single_tail(data: np.ndarray, invert: bool) -> Tuple[Optional[float], Dict[str, float], Optional[str]]:
        working = -data if invert else data
        u = float(np.quantile(working, config.u_quantile, method="linear"))
        exceedances = working[working > u] - u
        details: Dict[str, float] = {
            "u": u,
            "calib_size": float(calib.size),
            "u_quantile": float(config.u_quantile),
            "min_exceed": float(config.min_exceed),
            "alpha": float(config.alpha),
            "q": float(config.q),
        }
        if exceedances.size < int(config.min_exceed):
            details["n_exceed"] = float(exceedances.size)
            return None, details, "insufficient_exceedances"
        xi, beta, solver_meta = fit_gpd_mle(exceedances)
        details.update({"xi": float(xi), "beta": float(beta), "n_exceed": float(exceedances.size)})
        details.update({k: v for k, v in solver_meta.items() if v is not None})
        p_ref = float(exceedances.size) / float(calib.size)
        q_star = max(float(config.q), 1e-12)
        details["p_ref"] = p_ref
        details["data_hash_tail"] = _hash_values(exceedances)
        if q_star >= p_ref:
            tau_domain = u
        else:
            if abs(xi) < 1e-8:
                tau_domain = u + beta * math.log(p_ref / q_star)
            else:
                tau_domain = u + (beta / xi) * ((p_ref / q_star) ** xi - 1.0)
        if invert:
            tau = -tau_domain
        else:
            tau = tau_domain
        details["tau_domain"] = float(tau_domain)
        return float(tau), details, None

    tau_hi: Optional[float] = None
    tau_lo: Optional[float] = None
    details: Dict[str, float] = {"method": "spot"}
    fallback_reason: Optional[str] = None

    if side in {"upper", "both"}:
        tau_hi, hi_details, reason = _single_tail(calib, invert=False)
        details.update({f"upper_{k}": v for k, v in hi_details.items()})
        if reason is not None and fallback_reason is None:
            fallback_reason = f"upper_{reason}"
    if side in {"lower", "both"}:
        tau_lo, lo_details, reason = _single_tail(calib, invert=True)
        details.update({f"lower_{k}": v for k, v in lo_details.items()})
        if reason is not None:
            suffix = f"lower_{reason}"
            fallback_reason = suffix if fallback_reason is None else fallback_reason

    return tau_hi, tau_lo, details, fallback_reason
