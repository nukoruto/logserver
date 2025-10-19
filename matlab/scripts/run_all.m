%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function artifactsDir = run_all()
%RUN_ALL End-to-end execution pipeline for Simulink comparison.
%   RUN_ALL orchestrates model generation, simulation, analysis, and report
%   export. Returns the artifacts directory containing generated files.

configPath = fullfile(fileparts(mfilename('fullpath')), '..', 'config', 'sim_config.json');
addpath(fullfile(fileparts(mfilename('fullpath')), '..', 'util'));
outputDir = make_artifacts();

build_pid_vs_lstm_model(configPath);
simOut = run_simulation();
metrics = analyze_time_domain(simOut);
export_report(metrics, outputDir);

artifactsDir = outputDir;
end
