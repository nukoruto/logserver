%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function [alarm, state] = k_of_n_latch(flags, k, state)
%K_OF_N_LATCH MATLAB Function block helper implementing K-of-N logic with hysteresis.
%
%   [ALARM, STATE] = K_OF_N_LATCH(FLAGS, K, STATE) raises ALARM when at
%   least K elements of FLAGS are true. STATE is a struct with fields
%   'latched' and 'release_ratio'.

arguments
    flags (:, 1) logical
    k (1, 1) double {mustBeInteger, mustBePositive}
    state (1, 1) struct = struct('latched', false, 'release_ratio', 0.5)
end

if k > numel(flags)
    error('k_of_n_latch:InvalidK', 'k must not exceed the number of flags.');
end

countTrue = sum(flags);
if state.latched
    releaseThreshold = ceil(k * state.release_ratio);
    alarm = countTrue >= releaseThreshold;
    state.latched = alarm;
else
    alarm = countTrue >= k;
    state.latched = alarm;
end
end
