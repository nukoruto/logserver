%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

classdef test_pid_vs_lstm < matlab.unittest.TestCase
    %TEST_PID_VS_LSTM Basic smoke tests for the Simulink workflow scripts.

    methods (Test)
        function test_make_artifacts(testCase)
            artifactsDir = make_artifacts(tempdir);
            testCase.assertTrue(isfolder(artifactsDir));
        end

        function test_choose_info_fn_rmse(testCase)
            fn = choose_info_fn("rmse");
            val = fn([0; 1], [0; 1]);
            testCase.verifyEqual(val, 0);
        end
    end
end
