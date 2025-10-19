%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function metrics = analyze_time_domain(simOut, opts)
%ANALYZE_TIME_DOMAIN Compute time-domain metrics for LSTM and PID responses.
%
%   METRICS = ANALYZE_TIME_DOMAIN(SIMOUT, OPTS) extracts reference and
%   controller outputs from SIMOUT (Simulink.SimulationOutput) and returns
%   integral performance indices (IAE/ISE/ITAE) together with transient
%   metrics (rise time, settling time, overshoot percentage, steady-state
%   error). The function automatically switches between step-like and
%   general reference handling by inspecting the reference waveform.
%
%   OPTS is an optional struct supporting the fields:
%       settleTol       Settling band half-width as a fraction (default 0.02)
%       refSignalName   Reference signal name in logs (default "r")
%       lstmSignalName  LSTM output signal name (default "y_LSTM")
%       pidSignalName   PID output signal name (default "y_PID")
%       timeSignalName  Optional explicit time signal name (default "t")
%
%   The returned struct has fields METRICS.LSTM, METRICS.PID, and
%   METRICS.common. METRICS.LSTM and METRICS.PID each expose the fixed
%   fields IAE, ISE, ITAE, RiseTime, SettlingTime, OvershootPct, and
%   SteadyStateError so downstream scripts (e.g., run_all) can access them
%   without modification. METRICS.common stores metadata about the
%   evaluation (reference type, tolerance, time horizon).

arguments
    simOut Simulink.SimulationOutput
    opts.settleTol (1, 1) double {mustBePositive} = 0.02
    opts.refSignalName (1, 1) string = "r"
    opts.lstmSignalName (1, 1) string = "y_LSTM"
    opts.pidSignalName (1, 1) string = "y_PID"
    opts.timeSignalName (1, 1) string = "t"
end

logs = fetch_logs(simOut);
[timeVec, refSig] = extract_signal(logs, opts.refSignalName, opts.timeSignalName);
[~, lstmSig] = extract_signal(logs, opts.lstmSignalName, opts.timeSignalName, timeVec);
[~, pidSig] = extract_signal(logs, opts.pidSignalName, opts.timeSignalName, timeVec);

refSig = ensure_column(refSig);
lstmSig = ensure_column(lstmSig);
pidSig = ensure_column(pidSig);

timeVec = ensure_column(timeVec);

if ~isequal(size(refSig), size(lstmSig)) || ~isequal(size(refSig), size(pidSig))
    error('analyze_time_domain:SignalSizeMismatch', ...
        'Reference, LSTM, and PID signals must have matching dimensions.');
end

lstmError = refSig - lstmSig;
pidError = refSig - pidSig;

lstmIntegrals = compute_integral_metrics(timeVec, lstmError);
pidIntegrals = compute_integral_metrics(timeVec, pidError);

[isStep, stepStartIdx] = classify_reference(refSig);

if isStep
    stepIdxLSTM = stepStartIdx;
    stepIdxPID = stepStartIdx;
else
    stepIdxLSTM = stepStartIdx;
    stepIdxPID = stepStartIdx;
end

[lRise, lSettle, lOvershoot, lSSE] = compute_step_like_metrics( ...
    timeVec, refSig, lstmSig, opts.settleTol, stepIdxLSTM);
[pRise, pSettle, pOvershoot, pSSE] = compute_step_like_metrics( ...
    timeVec, refSig, pidSig, opts.settleTol, stepIdxPID);

metrics = struct();
metrics.LSTM = struct( ...
    'IAE', lstmIntegrals.IAE, ...
    'ISE', lstmIntegrals.ISE, ...
    'ITAE', lstmIntegrals.ITAE, ...
    'RiseTime', lRise, ...
    'SettlingTime', lSettle, ...
    'OvershootPct', lOvershoot, ...
    'SteadyStateError', lSSE);
metrics.PID = struct( ...
    'IAE', pidIntegrals.IAE, ...
    'ISE', pidIntegrals.ISE, ...
    'ITAE', pidIntegrals.ITAE, ...
    'RiseTime', pRise, ...
    'SettlingTime', pSettle, ...
    'OvershootPct', pOvershoot, ...
    'SteadyStateError', pSSE);
metrics.common = struct( ...
    'isStep', isStep, ...
    'tol', opts.settleTol, ...
    'tEnd', timeVec(end));
end

function logs = fetch_logs(simOut)
fields = simOut.who;
if any(strcmp('logsout', fields))
    logs = simOut.logsout;
else
    error('analyze_time_domain:MissingLogs', ...
        'SimulationOutput must contain logsout with required signals.');
end
end

function [timeVec, dataVec] = extract_signal(logs, signalName, timeName, fallbackTime)
if nargin < 4
    fallbackTime = [];
end

if has_element(logs, signalName)
    element = logs.get(signalName);
    dataVec = double(element.Values.Data);
    if isprop(element.Values, 'Time') && ~isempty(element.Values.Time)
        timeVec = double(element.Values.Time);
    elseif ~isempty(fallbackTime)
        timeVec = fallbackTime;
    else
        error('analyze_time_domain:MissingTimeVector', ...
            'Signal %s does not provide a time vector.', signalName);
    end
else
    error('analyze_time_domain:MissingSignal', ...
        'logsout is missing required signal %s.', signalName);
end

if isempty(timeVec) && ~isempty(fallbackTime)
    timeVec = fallbackTime;
end

if isempty(timeVec)
    if has_element(logs, timeName)
        timeElement = logs.get(timeName);
        timeVec = double(timeElement.Values.Data);
    else
        error('analyze_time_domain:MissingTimeSignal', ...
            'Unable to resolve time vector for signal %s.', signalName);
    end
end
end

function tf = has_element(logs, signalName)
if isa(logs, 'Simulink.SimulationData.Dataset')
    tf = logs.hasElement(signalName);
else
    try
        logs.get(signalName);
        tf = true;
    catch
        tf = false;
    end
end
end

function vec = ensure_column(vec)
vec = double(vec);
if isrow(vec)
    vec = vec.';
end
end

function integrals = compute_integral_metrics(t, errorSignal)
errorSignal = ensure_column(errorSignal);
integrals = struct();
integrals.IAE = trapz(t, abs(errorSignal));
integrals.ISE = trapz(t, errorSignal.^2);
integrals.ITAE = trapz(t, abs(errorSignal) .* t);
end

function [isStep, stepIdx] = classify_reference(reference)
reference = ensure_column(reference);
if numel(reference) < 2
    isStep = false;
    stepIdx = NaN;
    return;
end

dr = diff(reference);
thr = max(1e-12, 0.01 * max(abs(reference)));
stepLocations = find(abs(dr) > thr);
isStep = numel(stepLocations) == 1;
if isempty(stepLocations)
    stepIdx = NaN;
else
    stepIdx = stepLocations(end);
end
end

function [riseTime, settlingTime, overshootPct, steadyStateError] = ...
    compute_step_like_metrics(t, r, y, tol, stepIdx)
t = ensure_column(t);
r = ensure_column(r);
y = ensure_column(y);

if isnan(stepIdx)
    riseTime = NaN;
    settlingTime = NaN;
    overshootPct = NaN;
    steadyStateError = r(end) - y(end);
    return;
end

if stepIdx < 1 || stepIdx >= numel(t)
    error('analyze_time_domain:InvalidStepIndex', ...
        'Step index %d is outside valid range.', stepIdx);
end

segmentIdx = stepIdx:numel(t);
tSeg = t(segmentIdx);
rSeg = r(segmentIdx);
ySeg = y(segmentIdx);

rInitial = r(stepIdx);
rFinal = r(end);
rawAmplitude = rFinal - rInitial;
if abs(rawAmplitude) < eps
    riseStart = NaN;
    riseEnd = NaN;
    riseTime = NaN;
    amplitudeSign = 1;
else
    level10 = rInitial + 0.1 * rawAmplitude;
    level90 = rInitial + 0.9 * rawAmplitude;
    amplitudeSign = sign(rawAmplitude);
    riseStart = crossing_time(tSeg, ySeg, level10, amplitudeSign);
    riseEnd = crossing_time(tSeg, ySeg, level90, amplitudeSign);
    if any(isnan([riseStart, riseEnd]))
        riseTime = NaN;
    else
        riseTime = riseEnd - riseStart;
    end
end
A = amplitudeSign * max(abs(rawAmplitude), eps);

band = tol * abs(A);
settlingTime = settle_time(tSeg, ySeg, rFinal, band);

if abs(rawAmplitude) < eps
    normalizedDeviation = zeros(size(ySeg));
else
    normalizedDeviation = (ySeg - rFinal) / A;
end
overshootPct = max(normalizedDeviation) * 100;
steadyStateError = rFinal - ySeg(end);
end

function tCross = crossing_time(t, y, level, amplitude)
if amplitude >= 0
    idx = find(y >= level, 1, 'first');
else
    idx = find(y <= level, 1, 'first');
end

if isempty(idx)
    tCross = NaN;
    return;
end

if idx == 1
    tCross = t(1);
    return;
end

y1 = y(idx - 1);
y2 = y(idx);
t1 = t(idx - 1);
t2 = t(idx);
if y2 == y1
    tCross = t2;
else
    tCross = t1 + (level - y1) * (t2 - t1) / (y2 - y1);
end
end

function settlingTime = settle_time(t, y, target, band)
violations = find(abs(y - target) > band, 1, 'last');
if isempty(violations)
    settlingTime = t(1);
    return;
end

if violations == numel(t)
    settlingTime = t(end);
else
    settlingTime = t(violations + 1);
end
end
