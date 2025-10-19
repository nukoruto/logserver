%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function metrics = analyze_time_domain(simOut, settleBand)
%ANALYZE_TIME_DOMAIN Compute time-domain control metrics from simulation output.
%
%   METRICS = ANALYZE_TIME_DOMAIN(SIMOUT, SETTLEBAND) calculates rise time,
%   overshoot, settling time, steady-state error, and integral absolute
%   error metrics from the SimulationOutput struct.

arguments
    simOut Simulink.SimulationOutput
    settleBand (1, 1) double {mustBePositive} = 0.02
end

simData = simOut.simout;
timeVec = simData.time;
signals = simData.signals;

plantIdx = 1;
refIdx = numel(signals);

response = double(signals(plantIdx).values);
ref = double(signals(refIdx).values);

metrics = struct();
metrics.rise_time = time_to_value(response, ref, timeVec, 0.9);
metrics.overshoot_pct = (max(response) - ref(end)) / ref(end) * 100;
metrics.settling_time = settling_time(response, ref, timeVec, settleBand);
metrics.steady_state_error = abs(response(end) - ref(end));
metrics.IAE = trapz(timeVec, abs(response - ref));
end

function tRise = time_to_value(response, reference, timeVec, targetFraction)
    target = targetFraction * reference(end);
    idx = find(response >= target, 1, 'first');
    if isempty(idx)
        tRise = NaN;
    else
        tRise = timeVec(idx) - timeVec(1);
    end
end

function tSettle = settling_time(response, reference, timeVec, band)
    finalValue = reference(end);
    lower = finalValue * (1 - band);
    upper = finalValue * (1 + band);
    idx = find(response < lower | response > upper, 1, 'last');
    if isempty(idx)
        tSettle = 0;
    else
        tSettle = timeVec(idx) - timeVec(1);
    end
end
