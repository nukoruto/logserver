function [info_fn, method] = choose_info_fn(time_vector, reference, settling_threshold)
%CHOOSE_INFO_FN Select appropriate transient metric evaluator based on input type.
%   [FN, METHOD] = CHOOSE_INFO_FN(TIME_VECTOR, REFERENCE, SETTLING_THRESHOLD)
%   returns a function handle FN that accepts a response signal and
%   delegates to either STEPINFO or LSIMINFO depending on whether the
%   reference resembles a step input. METHOD is the string identifier of
%   the chosen function.
arguments
    time_vector (:, 1) double
    reference (:, 1) double
    settling_threshold (1, 1) double {mustBePositive}
end

if numel(time_vector) ~= numel(reference)
    error('choose_info_fn:LengthMismatch', ...
        'Time vector and reference signal must have identical lengths.');
end

if is_step_like(reference)
    method = "stepinfo";
    final_value = reference(end);
    info_fn = @(response) stepinfo(response, time_vector, final_value, ...
        'SettlingTimeThreshold', settling_threshold);
else
    method = "lsiminfo";
    info_fn = @(response) lsiminfo(response, time_vector, reference, ...
        'SettlingTimeThreshold', settling_threshold);
end
end

function flag = is_step_like(reference)
if isempty(reference)
    flag = true;
    return;
end
ref = reference(:);
% Determine tolerance relative to signal magnitude.
scale = max(1.0, max(abs(ref)));
tol = 1e-9 * scale;
deltas = diff(ref);
change_idx = find(abs(deltas) > tol);
if isempty(change_idx)
    flag = true;
    return;
end
first_change = change_idx(1);
last_change = change_idx(end);
if first_change ~= last_change
    flag = false;
    return;
end
pre_segment = ref(1:first_change);
post_segment = ref(first_change+1:end);
flag = max(abs(pre_segment - pre_segment(1))) <= tol && ...
       max(abs(post_segment - post_segment(1))) <= tol;
end
