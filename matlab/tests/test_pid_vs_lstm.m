classdef test_pid_vs_lstm < matlab.unittest.TestCase
    %TEST_PID_VS_LSTM Basic smoke tests for the Simulink workflow scripts.

    methods (Test)
        function test_make_artifacts(testCase)
            artifactsDir = make_artifacts(tempdir);
            testCase.assertTrue(isfolder(artifactsDir));
        end

        function test_choose_info_fn_step(testCase)
            t = (0:4)';
            ref = [zeros(2, 1); ones(3, 1)];
            [fn, method] = choose_info_fn(t, ref, 0.02);
            testCase.verifyEqual(method, "stepinfo");
            info = fn(ref);
            testCase.verifyClass(info, 'struct');
            testCase.verifyGreaterThanOrEqual(info.RiseTime, 0);
        end

        function test_choose_info_fn_lsim(testCase)
            t = (0:4)';
            ref = sin(t);
            [fn, method] = choose_info_fn(t, ref, 0.02);
            testCase.verifyEqual(method, "lsiminfo");
            resp = ref;
            info = fn(resp);
            testCase.verifyClass(info, 'struct');
        end

        function test_k_of_n_latch_hysteresis(testCase)
            clear k_of_n_latch; %#ok<CLFUNC>
            inputs = [0 1 1 1 0 0 0];
            alarms = false(size(inputs));
            counts = zeros(size(inputs));
            for idx = 1:numel(inputs)
                [alarms(idx), counts(idx)] = k_of_n_latch(inputs(idx), 3, 5, 3, 1);
            end
            testCase.verifyTrue(alarms(4));
            testCase.verifyFalse(alarms(end));
            testCase.verifyGreaterThanOrEqual(max(counts), 3);
        end
    end
end
