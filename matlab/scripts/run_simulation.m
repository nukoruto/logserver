%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function simOut = run_simulation(modelPath, configPath)
%RUN_SIMULATION Execute the Simulink model and return logged outputs.
%
%   SIMOUT = RUN_SIMULATION(MODELPATH, CONFIGPATH) loads the Simulink model,
%   applies configuration parameters, runs the simulation, and returns the
%   Simulink.SimulationOutput.

arguments
    modelPath (1, 1) string = fullfile(fileparts(mfilename('fullpath')), '..', 'models', 'pid_vs_lstm.slx');
    configPath (1, 1) string = fullfile(fileparts(mfilename('fullpath')), '..', 'config', 'sim_config.json');
end

if exist(modelPath, 'file') ~= 4
    error('run_simulation:MissingModel', 'Model file %s does not exist. Run build_pid_vs_lstm_model first.', modelPath);
end

addpath(fullfile(fileparts(mfilename('fullpath')), '..', 'util'));

config = jsondecode(fileread(configPath));
load_system(modelPath);
modelName = bdroot(modelPath);

set_param(modelName, 'StopTime', num2str(config.simulation.stop_time));
set_param(modelName + "/Reference", 'VariableName', config.signals.reference);

simOut = sim(modelName, 'SaveOutput', 'on', 'ReturnWorkspaceOutputs', 'on');
end
