function [alarm, countK] = k_of_n_latch(viol, K, N, hyst_up, hyst_down)
%K_OF_N_LATCH Sliding-window K-of-N latch with hysteresis for MATLAB Function blocks.
%   [ALARM, COUNTK] = K_OF_N_LATCH(VIOL, K, N, HYST_UP, HYST_DOWN) raises
%   ALARM when at least K (or the hysteresis-up threshold) violations are
%   observed within the latest N samples. The latch resets when the
%   violation count falls to or below the hysteresis-down threshold.
%   COUNTK returns the current count of violations in the active window.
%
%   HYST_UP/HYST_DOWN can be specified either as counts (>= 1) or as ratios
%   (<= 1) relative to N.
%#codegen
arguments
    viol (1, 1) double
    K (1, 1) double {mustBePositive, mustBeInteger}
    N (1, 1) double {mustBePositive, mustBeInteger}
    hyst_up (1, 1) double {mustBeNonnegative}
    hyst_down (1, 1) double {mustBeNonnegative}
end

persistent buffer;
persistent index;
persistent count;
persistent filled;
persistent latched;

if isempty(buffer) || numel(buffer) ~= N
    buffer = false(N, 1);
    index = 1;
    count = 0;
    filled = 0;
    latched = false;
end

viol_flag = viol ~= 0;
if filled < N
    buffer(index) = viol_flag;
    count = count + double(viol_flag);
    filled = filled + 1;
else
    removed = buffer(index);
    buffer(index) = viol_flag;
    count = count + double(viol_flag) - double(removed);
end

index = index + 1;
if index > N
    index = 1;
end

set_threshold = resolve_threshold(hyst_up, K, N);
release_threshold = resolve_threshold(hyst_down, 0, N);
release_threshold = min(release_threshold, set_threshold - 1);
release_threshold = max(release_threshold, 0);

if ~latched
    if count >= set_threshold
        latched = true;
    end
else
    if count <= release_threshold
        latched = false;
    end
end

alarm = latched;
countK = count;
end

function threshold = resolve_threshold(value, base, N)
if value <= 1
    threshold = ceil(value * N);
else
    threshold = ceil(value);
end
threshold = max(base, threshold);
threshold = min(N, threshold);
end
