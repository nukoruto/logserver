function [alarm, countK] = k_of_n_latch(viol, K, N, hyst_up, hyst_down)
%K_OF_N_LATCH Apply K-of-N logic with hysteresis to a violation signal.
%   [ALARM, COUNTK] = K_OF_N_LATCH(VIOL, K, N, HYST_UP, HYST_DOWN) maintains
%   an internal sliding window of the last N boolean samples of VIOL and
%   asserts ALARM when at least K + HYST_UP samples are true. The alarm is
%   released only after the count drops to K - HYST_DOWN or below. COUNTK
%   reports the current number of true samples in the window. All inputs are
%   expected to be scalar doubles (compatible with Simulink code generation).
%   The function preserves state across invocations via persistent storage.
%   This implementation is intended for use inside a MATLAB Function block.
%
%   Inputs:
%       viol     - Current violation flag (0 or 1)
%       K        - Minimum number of violations to trigger the alarm
%       N        - Window size (number of recent samples to evaluate)
%       hyst_up  - Additional samples above K required to assert the alarm
%       hyst_down- Samples below K required to release the alarm
%
%   Outputs:
%       alarm  - Latched alarm flag (0 or 1)
%       countK - Current count of violations within the window
%
%   Example:
%       [alarm, count] = util.k_of_n_latch(check, 3, 5, 1, 2);
%
%   Notes:
%       - Hysteresis thresholds are clamped to the range [0, N].
%       - The violation history is initialised to zeros on the first call.
%       - Inputs are cast to logical for counting but stored as double to
%         ensure compatibility with generated Simulink code.
%
%   See also MATLAB Function block documentation for persistent variables.

%#codegen
arguments
    viol (1, 1) double
    K (1, 1) double {mustBeNonnegative}
    N (1, 1) double {mustBePositive}
    hyst_up (1, 1) double {mustBeNonnegative}
    hyst_down (1, 1) double {mustBeNonnegative}
end

persistent history;
persistent index;
persistent latched;
persistent filled;

if isempty(history)
    history = zeros(1, max(1, int32(floor(N))));
    index = int32(1);
    latched = false;
    filled = false;
end

window_length = max(1, int32(floor(N)));
if numel(history) ~= window_length
    history = zeros(1, window_length);
    index = int32(1);
    latched = false;
    filled = false;
end

% Clamp thresholds within the window limits.
trigger_threshold = min(window_length, int32(floor(K + hyst_up)));
release_threshold = max(0, int32(ceil(K - hyst_down)));

current = double(viol ~= 0);
history(index) = current;

if index == window_length
    index = int32(1);
    filled = true;
else
    index = index + 1;
end

if filled
    countK = sum(history);
else
    countK = sum(history(1:double(index) - 1));
end

if countK >= double(trigger_threshold)
    latched = true;
elseif countK <= double(release_threshold)
    latched = false;
end

alarm = double(latched);
countK = double(countK);

end
