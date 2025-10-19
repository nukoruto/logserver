classdef test_time_domain_metrics < matlab.unittest.TestCase
    %TEST_TIME_DOMAIN_METRICS Unit tests for analyze_time_domain.

    methods (Test)
        function test_step_reference_matches_integrators(testCase)
            t = linspace(0, 5, 501)';
            ref = double(t >= 0.5);
            tauL = 0.4;
            tauP = 0.6;
            yL = (1 - exp(-(t - 0.5) / tauL)) .* (t >= 0.5);
            yP = (1 - exp(-(t - 0.5) / tauP)) .* (t >= 0.5);

            eL = ref - yL;
            eP = ref - yP;

            iaeL = cumtrapz(t, abs(eL));
            iseL = cumtrapz(t, eL.^2);
            itaeL = cumtrapz(t, abs(eL) .* t);

            iaeP = cumtrapz(t, abs(eP));
            iseP = cumtrapz(t, eP.^2);
            itaeP = cumtrapz(t, abs(eP) .* t);

            logs = Simulink.SimulationData.Dataset;
            logs = logs.addElement(timeseries(t, t), 't');
            logs = logs.addElement(timeseries(ref, t), 'r');
            logs = logs.addElement(timeseries(yL, t), 'y_LSTM');
            logs = logs.addElement(timeseries(yP, t), 'y_PID');
            logs = logs.addElement(timeseries(iaeL, t), 'IAE_LSTM');
            logs = logs.addElement(timeseries(iseL, t), 'ISE_LSTM');
            logs = logs.addElement(timeseries(itaeL, t), 'ITAE_LSTM');
            logs = logs.addElement(timeseries(iaeP, t), 'IAE_PID');
            logs = logs.addElement(timeseries(iseP, t), 'ISE_PID');
            logs = logs.addElement(timeseries(itaeP, t), 'ITAE_PID');

            simOut = Simulink.SimulationOutput;
            simOut = simOut.set('logsout', logs);

            metrics = analyze_time_domain(simOut);

            testCase.verifyTrue(metrics.common.isStep);
            testCase.verifyLessThan(abs(metrics.LSTM.IAE - iaeL(end)), 1e-9);
            testCase.verifyLessThan(abs(metrics.LSTM.ISE - iseL(end)), 1e-9);
            testCase.verifyLessThan(abs(metrics.LSTM.ITAE - itaeL(end)), 1e-9);
            testCase.verifyLessThan(abs(metrics.PID.IAE - iaeP(end)), 1e-9);
            testCase.verifyLessThan(abs(metrics.PID.ISE - iseP(end)), 1e-9);
            testCase.verifyLessThan(abs(metrics.PID.ITAE - itaeP(end)), 1e-9);

            testCase.verifyGreaterThanOrEqual(metrics.LSTM.RiseTime, 0);
            testCase.verifyGreaterThanOrEqual(metrics.PID.RiseTime, 0);
            testCase.verifyGreaterThanOrEqual(metrics.LSTM.SettlingTime, 0);
            testCase.verifyGreaterThanOrEqual(metrics.PID.SettlingTime, 0);
        end

        function test_non_step_reference_metrics_defined(testCase)
            t = linspace(0, 6, 601)';
            ref = zeros(size(t));
            ref(t >= 1 & t < 3) = 1;
            ref(t >= 3 & t < 5) = 0.4;
            ref(t >= 5) = 0.8;

            yL = ref + 0.05 * sin(2 * pi * t / 3);
            yP = ref - 0.03 * cos(2 * pi * t / 4);

            logs = Simulink.SimulationData.Dataset;
            logs = logs.addElement(timeseries(t, t), 't');
            logs = logs.addElement(timeseries(ref, t), 'r');
            logs = logs.addElement(timeseries(yL, t), 'y_LSTM');
            logs = logs.addElement(timeseries(yP, t), 'y_PID');

            simOut = Simulink.SimulationOutput;
            simOut = simOut.set('logsout', logs);

            metrics = analyze_time_domain(simOut);

            testCase.verifyFalse(metrics.common.isStep);
            fields = {'IAE', 'ISE', 'ITAE', 'RiseTime', 'SettlingTime', 'OvershootPct', 'SteadyStateError'};
            for k = 1:numel(fields)
                testCase.verifyTrue(isfield(metrics.LSTM, fields{k}));
                testCase.verifyTrue(isfield(metrics.PID, fields{k}));
            end

            testCase.verifyFalse(any(isnan([metrics.LSTM.IAE, metrics.PID.IAE, ...
                metrics.LSTM.ISE, metrics.PID.ISE, metrics.LSTM.ITAE, metrics.PID.ITAE])));
            testCase.verifyGreaterThanOrEqual(metrics.LSTM.SettlingTime, 0);
            testCase.verifyGreaterThanOrEqual(metrics.PID.SettlingTime, 0);
            testCase.verifyClass(metrics.common.tEnd, 'double');
        end
    end
end
