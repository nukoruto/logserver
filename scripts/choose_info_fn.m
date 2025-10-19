function info = choose_info_fn(ref_signal, tolerance)
%CHOOSE_INFO_FN Determine appropriate time-domain info function for signals.
%   INFO = CHOOSE_INFO_FN(REF_SIGNAL, TOLERANCE) inspects the reference
%   Structure with Time payload REF_SIGNAL and returns a struct describing
%   the recommended metrics function. The struct contains the fields:
%       - handle: function handle (@stepinfo or @lsiminfo)
%       - type:   'step' or 'general'
%       - channel: index of the dominant channel in the reference
%       - amplitude: difference between final and initial values
%   TOLERANCE specifies the numeric tolerance when detecting step changes
%   (default 1e-9).
%
%   The heuristic selects the channel with the largest amplitude and then
%   checks whether the input resembles a single-step transition. If so,
%   stepinfo is used; otherwise, lsiminfo is returned.

arguments
    ref_signal (1, 1) struct
    tolerance (1, 1) double = 1e-9
end

values = double(ref_signal.signals.values);
if isempty(values)
    error('choose_info_fn:EmptySignal', 'Reference signal must contain data.');
end

ranges = max(values, [], 1) - min(values, [], 1);
[~, channel] = max(ranges);
channel = max(channel, 1);
profile = values(:, channel);

initial_value = profile(1);
final_value = profile(end);
delta = final_value - initial_value;

transitions = find(abs(diff(profile)) > tolerance);
is_step = false;
if numel(transitions) == 1
    is_step = true;
elseif numel(transitions) > 1
    % Allow slight oscillations after the primary transition if they are
    % negligible compared with the main amplitude.
    residual = profile(transitions(end)+1:end);
    if ~isempty(residual)
        deviation = max(abs(residual - final_value));
    else
        deviation = 0;
    end
    if deviation <= max(tolerance, 0.01 * max(1.0, abs(delta)))
        is_step = true;
    end
end

if abs(delta) <= tolerance
    is_step = false;
end

if is_step
    info.handle = @stepinfo;
    info.type = 'step';
else
    info.handle = @lsiminfo;
    info.type = 'general';
end
info.channel = channel;
info.amplitude = delta;

end
